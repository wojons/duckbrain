/**
 * Segment consolidation tests — DB-GAP-051.
 *
 * The module plans and applies two repairs to a JSONL partition: MERGE (pack
 * many near-empty segments into bounded ones) and SPLIT (cut a segment that is
 * past the 1000-line/1MB rotation bound into bounded chunks). Every test here
 * drives the real filesystem — a scratch partition per test — because the
 * properties that matter (record order, record count, nothing overwritten,
 * nothing deleted that was just written) are filesystem facts.
 *
 * Coverage map:
 *   - merge reduces the file count with the record sequence byte-identical;
 *   - split of a >1000-line and of a >1MB segment, exact counts, both bounds;
 *   - idempotence (second plan empty, second run writes nothing);
 *   - collision safety (no duplicate basenames, nothing overwritten that the
 *     plan does not own, two splits in one plan never share a name);
 *   - dry run writes nothing and leaves every byte alone;
 *   - D1 double allocation, D2 a reused input name, D3 one-run convergence;
 *   - the bound constants are pinned to `resolveJsonlTargetPath`'s REAL
 *     rotation rule, so the module and the writer cannot drift apart;
 *   - current.jsonl / non-numeric names / .parquet / .gitkeep are untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  SEGMENT_MAX_BYTES,
  SEGMENT_MAX_LINES,
  executeSegmentConsolidation,
  planSegmentConsolidation,
} from "./segment-consolidation";
import { compareChunkNames, resolveJsonlTargetPath } from "./jsonl";

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const SEGMENT_FILE = /^\d+\.jsonl$/;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-segcons-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** One distinguishable JSONL record; `pad` widens it for byte-bound tests. */
function makeLine(i: number, pad = 0): string {
  return JSON.stringify({ id: i, pad: "x".repeat(pad) });
}

function writeSegment(dir: string, name: string, lines: string[]): void {
  fs.writeFileSync(
    path.join(dir, name),
    lines.map((l) => `${l}\n`).join(""),
    "utf8",
  );
}

/** Every record of the partition, in the order a reader sees them. */
function readOrder(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => SEGMENT_FILE.test(f))
    .sort(compareChunkNames)
    .flatMap((n) =>
      fs
        .readFileSync(path.join(dir, n), "utf8")
        .split("\n")
        .filter((l) => l.trim() !== ""),
    );
}

function segmentFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => SEGMENT_FILE.test(f));
}

/** Name -> exact bytes on disk, for untouched-file assertions. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(dir).sort()) {
    out[f] = fs.readFileSync(path.join(dir, f), "utf8");
  }
  return out;
}

/** Every numeric segment is within BOTH bounds. */
function expectWithinBounds(dir: string): void {
  for (const name of segmentFiles(dir)) {
    const raw = fs.readFileSync(path.join(dir, name), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length, `${name} line count`).toBeLessThanOrEqual(
      SEGMENT_MAX_LINES,
    );
    expect(Buffer.byteLength(raw, "utf8"), `${name} byte size`).toBeLessThan(
      SEGMENT_MAX_BYTES + 1,
    );
  }
}

/** Seed `count` one-record segments named from `start`. */
function seedTiny(
  dir: string,
  count: number,
  start = 1,
  firstRecord = 0,
): string[] {
  const records: string[] = [];
  for (let i = 0; i < count; i++) {
    const line = makeLine(firstRecord + i);
    records.push(line);
    writeSegment(dir, `${String(start + i).padStart(4, "0")}.jsonl`, [line]);
  }
  return records;
}

describe("merge", () => {
  it("collapses 2,500 one-record segments in ONE run, order and counts intact", () => {
    const records = seedTiny(tmpDir, 2500);
    const before = readOrder(tmpDir);
    expect(before).toEqual(records);

    const plan = planSegmentConsolidation(tmpDir);

    // D3: the planner emits EVERY group the partition needs, not one batch.
    expect(plan.merges.length).toBeGreaterThanOrEqual(2);
    expect(plan.splits).toEqual([]);
    expect(plan.stats.segmentsBefore).toBe(2500);
    expect(plan.stats.segmentsAfter).toBeLessThan(10);
    expect(plan.stats.recordsBefore).toBe(2500);
    expect(plan.stats.recordsAfter).toBe(2500);

    // D1: no two outputs share a basename.
    expect(new Set(plan.writtenFiles).size).toBe(plan.writtenFiles.length);

    // D1: a written name may only overwrite a file the plan owns.
    const owned = new Set([
      ...plan.merges.flatMap((m) => m.inputs),
      ...plan.splits.map((s) => s.input),
    ]);
    for (const name of plan.writtenFiles) {
      if (!plan.addedFiles.includes(name)) {
        expect(fs.existsSync(path.join(tmpDir, name))).toBe(true);
        expect(owned.has(name), `${name} is not a plan input`).toBe(true);
      }
    }

    const result = executeSegmentConsolidation(tmpDir);

    expect(result.dryRun).toBe(false);
    expect(result.stats.recordsBefore).toBe(2500);
    expect(result.stats.recordsAfter).toBe(2500);
    expect(result.stats.segmentsAfter).toBe(segmentFiles(tmpDir).length);
    expect(segmentFiles(tmpDir).length).toBeLessThan(10);
    expect(readOrder(tmpDir)).toEqual(before);
    expectWithinBounds(tmpDir);
  });

  it("packs outputs up to the bound and starts a new file past it", () => {
    // 1,000 one-record segments fill exactly one output; the 1,001st does not
    // fit, so a second output starts.
    seedTiny(tmpDir, 1001);
    const plan = planSegmentConsolidation(tmpDir);
    expect(plan.stats.segmentsAfter).toBe(2);
    executeSegmentConsolidation(tmpDir);
    const sizes = segmentFiles(tmpDir)
      .sort(compareChunkNames)
      .map(
        (n) =>
          fs
            .readFileSync(path.join(tmpDir, n), "utf8")
            .split("\n")
            .filter((l) => l.trim() !== "").length,
      );
    expect(sizes).toEqual([1000, 1]);
  });
});

describe("split", () => {
  it("cuts a >1000-line segment into bounded chunks with exact counts", () => {
    const records = Array.from({ length: 2500 }, (_, i) =>
      makeLine(100_000 + i),
    );
    writeSegment(tmpDir, "0007.jsonl", records);

    const plan = planSegmentConsolidation(tmpDir);
    expect(plan.merges).toEqual([]);
    expect(plan.splits.length).toBe(1);
    const split = plan.splits[0];
    expect(split.input).toBe("0007.jsonl");
    expect(split.inputLines).toBe(2500);
    expect(split.chunks.length).toBeGreaterThanOrEqual(3);
    expect(split.chunks.reduce((a, c) => a + c.lines, 0)).toBe(2500);
    expect(split.chunks.every((c) => c.lines > 0)).toBe(true);
    expect(split.chunks.map((c) => c.from)).toEqual(
      split.chunks
        .map((c) => c.from)
        .slice()
        .sort((a, b) => a - b),
    );

    // D2: the split input is one of its own chunk outputs — it must not be
    // deleted, and it must never appear in both the written and removed sets.
    expect(plan.writtenFiles).toContain("0007.jsonl");
    expect(plan.removedFiles).not.toContain("0007.jsonl");
    expect(
      plan.writtenFiles.filter((n) => plan.removedFiles.includes(n)),
    ).toEqual([]);

    const result = executeSegmentConsolidation(tmpDir);
    expect(result.removed).toEqual([]);
    expect(result.written).toEqual(
      plan.writtenFiles.slice().sort(compareChunkNames),
    );
    expect(readOrder(tmpDir)).toEqual(records);
    expect(readOrder(tmpDir).length).toBe(2500);
    expect(segmentFiles(tmpDir).length).toBe(split.chunks.length);
    expect(fs.existsSync(path.join(tmpDir, "0007.jsonl"))).toBe(true);
    expectWithinBounds(tmpDir);
  });

  it("cuts a >1MB segment on the BYTE bound while under the line bound", () => {
    const records = Array.from({ length: 900 }, (_, i) => makeLine(i, 1200));
    writeSegment(tmpDir, "0004.jsonl", records);
    const inputPath = path.join(tmpDir, "0004.jsonl");
    const inputBytes = Buffer.byteLength(
      fs.readFileSync(inputPath, "utf8"),
      "utf8",
    );

    // Premise: over the byte bound, under the line bound.
    expect(inputBytes).toBeGreaterThan(SEGMENT_MAX_BYTES);
    expect(records.length).toBeLessThan(SEGMENT_MAX_LINES);

    const plan = planSegmentConsolidation(tmpDir);
    const split = plan.splits[0];
    expect(split.chunks.length).toBeGreaterThanOrEqual(2);
    expect(split.inputBytes).toBe(inputBytes);
    expect(split.chunks.reduce((a, c) => a + c.bytes, 0)).toBe(inputBytes);
    expect(split.chunks.every((c) => c.bytes <= SEGMENT_MAX_BYTES)).toBe(true);

    executeSegmentConsolidation(tmpDir);
    expect(readOrder(tmpDir)).toEqual(records);
    expect(segmentFiles(tmpDir).length).toBe(split.chunks.length);
    expectWithinBounds(tmpDir);
  });

  it("places chunks inside the input's own slot so order is preserved", () => {
    // A split input between two surviving neighbours: every chunk name must
    // fall strictly between them, and the surviving neighbours must not move.
    seedTiny(tmpDir, 2, 1, 0);
    const big = Array.from({ length: 1500 }, (_, i) => makeLine(50_000 + i));
    writeSegment(tmpDir, "0007.jsonl", big);
    writeSegment(tmpDir, "0090.jsonl", [makeLine(90_000)]);

    const before = readOrder(tmpDir);
    const plan = planSegmentConsolidation(tmpDir);
    const names = plan.splits[0].chunks.map((c) => c.name);
    expect(names).toContain("0007.jsonl");
    for (const n of names) {
      expect(compareChunkNames("0002.jsonl", n)).toBeLessThan(0);
      expect(compareChunkNames(n, "0090.jsonl")).toBeLessThan(0);
    }

    executeSegmentConsolidation(tmpDir);
    expect(readOrder(tmpDir)).toEqual(before);
    expect(fs.existsSync(path.join(tmpDir, "0090.jsonl"))).toBe(true);
    expectWithinBounds(tmpDir);
  });

  it("reports a single record past the byte bound instead of leaving it silent", () => {
    const huge = makeLine(1, SEGMENT_MAX_BYTES + 1024);
    writeSegment(tmpDir, "0009.jsonl", [huge]);
    seedTiny(tmpDir, 3, 1, 0);

    const plan = planSegmentConsolidation(tmpDir);
    expect(plan.splits).toEqual([]);
    expect(plan.unplaceable.length).toBe(1);
    expect(plan.unplaceable[0].input).toBe("0009.jsonl");
    expect(plan.unplaceable[0].reason).toMatch(/single record/i);

    const before = readOrder(tmpDir);
    executeSegmentConsolidation(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, "0009.jsonl"))).toBe(true);
    expect(readOrder(tmpDir)).toEqual(before);
  });
});

describe("D2: an input that is also an output is never deleted", () => {
  it("never deletes a name the same plan writes, even a merge-freed one", () => {
    // 20 one-record segments merge into 0001 (freeing 0002..0020); the oversize
    // segment right after them needs two extra names and its own slot is the
    // gap those freed names occupy. The chunks therefore LAND ON names the
    // merge would otherwise delete.
    const merged = seedTiny(tmpDir, 20, 1, 0);
    const big = Array.from({ length: 2500 }, (_, i) => makeLine(200_000 + i));
    writeSegment(tmpDir, "0021.jsonl", big);

    const before = readOrder(tmpDir);
    expect(before.length).toBe(20 + 2500);

    const plan = planSegmentConsolidation(tmpDir);
    expect(plan.merges.length).toBe(1);
    expect(plan.splits.length).toBe(1);
    const merge = plan.merges[0];
    const split = plan.splits[0];

    // The hazard is live in this fixture, not hypothetical: the split re-uses
    // at least one name the merge frees (otherwise the test proves nothing).
    const wouldBeDeleted = merge.inputs.slice(1);
    expect(
      plan.writtenFiles.filter((n) => wouldBeDeleted.includes(n)).length,
    ).toBeGreaterThan(0);

    // ...and no name is both written and deleted.
    expect(
      plan.removedFiles.filter((n) => plan.writtenFiles.includes(n)),
    ).toEqual([]);
    expect(plan.removedFiles).not.toContain(split.input);
    expect(plan.removedFiles).not.toContain(merge.output);
    expect(plan.stats.recordsBefore).toBe(2520);

    const result = executeSegmentConsolidation(tmpDir);

    // Observation to state in the report: the reused names appear in `written`
    // and are absent from `removed`.
    for (const name of result.written) {
      expect(result.removed).not.toContain(name);
    }
    expect(result.removed.length).toBe(plan.removedFiles.length);
    expect(readOrder(tmpDir)).toEqual(before);
    expect(readOrder(tmpDir).length).toBe(2520);
    expect(merged.length + big.length).toBe(2520);
    expect(segmentFiles(tmpDir).length).toBe(result.stats.segmentsAfter);
    expectWithinBounds(tmpDir);
  });
});

describe("D3: one run converges", () => {
  it("needs a single plan+execute for thousands of tiny segments", () => {
    seedTiny(tmpDir, 2500);
    const filesBefore = segmentFiles(tmpDir).length;
    expect(filesBefore).toBe(2500);

    const result = executeSegmentConsolidation(tmpDir);

    const filesAfter = segmentFiles(tmpDir).length;
    // A single-batch planner would emit ONE output per invocation and need
    // ~3 runs to get here; this is one plan and one pass over the partition.
    expect(result.plan.merges.length).toBeGreaterThanOrEqual(2);
    expect(filesAfter).toBeLessThanOrEqual(5);
    expect(filesBefore / filesAfter).toBeGreaterThan(500);
    expect(result.stats.recordsBefore).toBe(2500);
    expect(result.stats.recordsAfter).toBe(2500);
    expectWithinBounds(tmpDir);

    // And it is a fixpoint: nothing left to do.
    const second = planSegmentConsolidation(tmpDir);
    expect(second.merges).toEqual([]);
    expect(second.splits).toEqual([]);
  });
});

describe("idempotence", () => {
  it("second plan is empty and a second run writes nothing", () => {
    seedTiny(tmpDir, 40, 1, 0);
    const big = Array.from({ length: 2500 }, (_, i) => makeLine(300_000 + i));
    writeSegment(tmpDir, "0041.jsonl", big);
    const before = readOrder(tmpDir);

    const first = executeSegmentConsolidation(tmpDir);
    expect(first.written.length).toBeGreaterThan(0);
    expect(first.removed.length).toBeGreaterThan(0);
    expect(readOrder(tmpDir)).toEqual(before);

    const afterFirst = snapshot(tmpDir);
    const second = planSegmentConsolidation(tmpDir);
    expect(second.merges).toEqual([]);
    expect(second.splits).toEqual([]);
    expect(second.writtenFiles).toEqual([]);
    expect(second.removedFiles).toEqual([]);
    expect(second.addedFiles).toEqual([]);
    expect(second.stats.segmentsBefore).toBe(second.stats.segmentsAfter);

    const secondRun = executeSegmentConsolidation(tmpDir);
    expect(secondRun.written).toEqual([]);
    expect(secondRun.removed).toEqual([]);
    expect(snapshot(tmpDir)).toEqual(afterFirst);
    expectWithinBounds(tmpDir);
  });
});

describe("collision safety", () => {
  it("two splits in one plan never share a name and overwrite nothing foreign", () => {
    writeSegment(
      tmpDir,
      "0005.jsonl",
      Array.from({ length: 1500 }, (_, i) => makeLine(i)),
    );
    writeSegment(
      tmpDir,
      "0900.jsonl",
      Array.from({ length: 1500 }, (_, i) => makeLine(1_000_000 + i)),
    );
    writeSegment(tmpDir, "0910.jsonl", [makeLine(9_000_000)]);

    const before = snapshot(tmpDir);
    const order = readOrder(tmpDir);
    const plan = planSegmentConsolidation(tmpDir);

    expect(plan.splits.length).toBe(2);
    expect(new Set(plan.writtenFiles).size).toBe(plan.writtenFiles.length);
    // The two allocations are disjoint, so neither split steals the other's
    // names even though both draw from the same pool.
    const owned = new Set([
      ...plan.merges.flatMap((m) => m.inputs),
      ...plan.splits.map((s) => s.input),
    ]);
    for (const name of plan.writtenFiles) {
      if (!plan.addedFiles.includes(name)) {
        expect(owned.has(name), `${name} not owned by the plan`).toBe(true);
      }
    }

    executeSegmentConsolidation(tmpDir);

    // Files the plan did not write are byte-identical, and no written file
    // clobbered a name that was not a plan input.
    for (const [name, body] of Object.entries(before)) {
      if (plan.writtenFiles.includes(name)) continue;
      expect(fs.readFileSync(path.join(tmpDir, name), "utf8"), name).toBe(body);
    }
    expect(readOrder(tmpDir)).toEqual(order);
    expectWithinBounds(tmpDir);
  });

  it("leaves current.jsonl, non-numeric names, .parquet and .gitkeep alone", () => {
    seedTiny(tmpDir, 30, 1, 0);
    fs.writeFileSync(path.join(tmpDir, "current.jsonl"), "live\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "notes.txt"), "not a segment\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "chunk_2026.jsonl"), "legacy\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "0001.parquet"), "pq\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, ".gitkeep"), "", "utf8");

    const order = readOrder(tmpDir);
    const plan = planSegmentConsolidation(tmpDir);
    for (const name of [...plan.writtenFiles, ...plan.removedFiles]) {
      expect(name).toMatch(SEGMENT_FILE);
    }

    executeSegmentConsolidation(tmpDir);

    expect(fs.readFileSync(path.join(tmpDir, "current.jsonl"), "utf8")).toBe(
      "live\n",
    );
    expect(fs.readFileSync(path.join(tmpDir, "notes.txt"), "utf8")).toBe(
      "not a segment\n",
    );
    expect(fs.readFileSync(path.join(tmpDir, "chunk_2026.jsonl"), "utf8")).toBe(
      "legacy\n",
    );
    expect(fs.readFileSync(path.join(tmpDir, "0001.parquet"), "utf8")).toBe(
      "pq\n",
    );
    expect(fs.existsSync(path.join(tmpDir, ".gitkeep"))).toBe(true);
    expect(readOrder(tmpDir)).toEqual(order);
  });
});

describe("dry run", () => {
  it("writes nothing and leaves every byte on disk unchanged", () => {
    seedTiny(tmpDir, 25, 1, 0);
    writeSegment(
      tmpDir,
      "0100.jsonl",
      Array.from({ length: 1500 }, (_, i) => makeLine(400_000 + i)),
    );

    const before = snapshot(tmpDir);
    const plan = planSegmentConsolidation(tmpDir);
    expect(plan.merges.length).toBeGreaterThan(0);
    expect(plan.splits.length).toBe(1);

    const result = executeSegmentConsolidation(tmpDir, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.written).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.stats).toEqual(plan.stats);
    expect(snapshot(tmpDir)).toEqual(before);

    // Planning twice is also free of side effects.
    expect(planSegmentConsolidation(tmpDir)).toEqual(plan);
    expect(snapshot(tmpDir)).toEqual(before);
  });

  it("is a no-op on an already-bounded partition", () => {
    // Two segments that each sit exactly ON the line bound: neither can join a
    // merge (1000 + 1000 > 1000) and neither needs a split, so the partition is
    // already consolidated.
    writeSegment(
      tmpDir,
      "0001.jsonl",
      Array.from({ length: SEGMENT_MAX_LINES }, (_, i) => makeLine(i)),
    );
    writeSegment(
      tmpDir,
      "0002.jsonl",
      Array.from({ length: SEGMENT_MAX_LINES }, (_, i) =>
        makeLine(1_000_000 + i),
      ),
    );
    const before = snapshot(tmpDir);
    const plan = planSegmentConsolidation(tmpDir);
    expect(plan.merges).toEqual([]);
    expect(plan.splits).toEqual([]);
    expect(plan.writtenFiles).toEqual([]);
    expect(plan.removedFiles).toEqual([]);

    const result = executeSegmentConsolidation(tmpDir);
    expect(result.written).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(snapshot(tmpDir)).toEqual(before);
  });
});

describe("bound constants pinned to the writer's rotation rule", () => {
  it("SEGMENT_MAX_LINES matches resolveJsonlTargetPath's line rotation", () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "pin-lines-"));
    const target = path.join(dir, "current.jsonl");
    const incoming = makeLine(1);

    // Exactly at the bound: the writer rotates.
    writeSegment(
      dir,
      "current.jsonl",
      Array.from({ length: SEGMENT_MAX_LINES }, (_, i) => makeLine(i)),
    );
    expect(resolveJsonlTargetPath(target, incoming)).not.toBe(target);

    // One short of the bound: the writer appends in place.
    writeSegment(
      dir,
      "current.jsonl",
      Array.from({ length: SEGMENT_MAX_LINES - 1 }, (_, i) => makeLine(i)),
    );
    expect(resolveJsonlTargetPath(target, incoming)).toBe(target);

    // The planner splits on the same line count: one record past the bound.
    const plannerDir = fs.mkdtempSync(path.join(tmpDir, "pin-plan-"));
    writeSegment(
      plannerDir,
      "0001.jsonl",
      Array.from({ length: SEGMENT_MAX_LINES + 1 }, (_, i) => makeLine(i)),
    );
    const plan = planSegmentConsolidation(plannerDir);
    expect(plan.splits.length).toBe(1);
    expect(plan.splits[0].chunks.length).toBe(2);
    expect(plan.splits[0].chunks.map((c) => c.lines)).toEqual([
      SEGMENT_MAX_LINES,
      1,
    ]);
  });

  it("SEGMENT_MAX_BYTES matches resolveJsonlTargetPath's byte rotation", () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "pin-bytes-"));
    const target = path.join(dir, "current.jsonl");
    const incoming = "x".repeat(500);

    // size + incoming == SEGMENT_MAX_BYTES exactly: the writer appends in place
    // (its check is `> MAX_BYTES_PER_CHUNK`), so the constants are equal, not
    // off by one.
    writeSegment(dir, "current.jsonl", [
      "y".repeat(SEGMENT_MAX_BYTES - incoming.length - 1),
    ]);
    expect(fs.statSync(target).size + incoming.length).toBe(SEGMENT_MAX_BYTES);
    expect(resolveJsonlTargetPath(target, incoming)).toBe(target);

    // One byte more: the writer rotates.
    writeSegment(dir, "current.jsonl", [
      "y".repeat(SEGMENT_MAX_BYTES - incoming.length),
    ]);
    expect(fs.statSync(target).size + incoming.length).toBe(
      SEGMENT_MAX_BYTES + 1,
    );
    expect(resolveJsonlTargetPath(target, incoming)).not.toBe(target);

    // The planner packs on the same byte bound: two records whose combined
    // bytes exceed SEGMENT_MAX_BYTES must not share a file. 600,000 bytes each
    // = 1,200,000 > 1,048,576, while a single one is well under it.
    const plannerDir = fs.mkdtempSync(path.join(tmpDir, "pin-pack-"));
    writeSegment(plannerDir, "0001.jsonl", [makeLine(1, 600_000)]);
    writeSegment(plannerDir, "0002.jsonl", [makeLine(2, 600_000)]);
    const one = fs.statSync(path.join(plannerDir, "0001.jsonl")).size;
    expect(one).toBeLessThan(SEGMENT_MAX_BYTES);
    expect(one * 2).toBeGreaterThan(SEGMENT_MAX_BYTES);
    const plan = planSegmentConsolidation(plannerDir);
    expect(plan.merges).toEqual([]);
    expect(plan.stats.segmentsAfter).toBe(2);
  });
});
