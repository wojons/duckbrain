/**
 * SCHED-GAP-1574 — the audit ledger must NOT duplicate the full memory row.
 *
 * Measured (2026-09-23 DuckBrain disk audit): the scheduler namespace carried
 * 287 MB of `_audit/` — a second copy of every memory write, because the
 * change record embedded the full row image next to the canonical data
 * partition. The contract after the fix:
 *
 *   - the writer emits change records carrying `rowHash` (sha256 of the
 *     stable serialization of the row) and NEVER a `row` image;
 *   - the record still carries who/what/when (`ts`, `ns`, `table`, `op`,
 *     `principal`, `outcome`, `seq`), the declared key material, the
 *     physical `targetPath`, the tombstone flag, and the schema version;
 *   - replay rehydrates the row from the committed data file `targetPath`
 *     names and verifies it against the hash — a record whose row is missing
 *     from, or hash-mismatched against, the data partition is
 *     `CHANGELOG_CORRUPT`, never a skipped event;
 *   - legacy `row`-shaped records (pre-dedup ledgers) still replay;
 *   - the derived change surface keeps exposing the row (the feed's
 *     `duckbrain.change.v1` payload is unchanged for consumers).
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  AUDIT_CURRENT_SEGMENT,
  AUDIT_DIR,
} from "../../serialization/auditLedger";
import {
  changeRecordShape,
  rowHashOf,
  stableStringify,
} from "../../serialization/changeRecord";
import { deriveCommitChanges } from "../realtime/replay";
import {
  createRealtimeFixture,
  memoryInput,
  type RealtimeFixture,
} from "../realtime/fixtures";

const fixtures: RealtimeFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function fixtureFor(): RealtimeFixture {
  const fixture = createRealtimeFixture("duckbrain-schedgap1574-", {
    commitOnFlush: false,
  });
  fixtures.push(fixture);
  return fixture;
}

/** Accepted change records of the active audit segment, parsed off disk. */
function ledgerRecords(nsPath: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(path.join(nsPath, AUDIT_DIR, AUDIT_CURRENT_SEGMENT), "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("SCHED-GAP-1574 audit ledger stores hash, not the full row", () => {
  it("accepted change records carry rowHash and never the row image", async () => {
    const fixture = fixtureFor();
    const input = memoryInput(1, fixture.ns);
    await fixture.writer.enqueue(input);
    await fixture.writer.flush();

    const changes = ledgerRecords(fixture.nsPath).filter(
      (entry) => entry.outcome === "accepted" && entry.op === "insert",
    );
    expect(changes).toHaveLength(1);
    const change = changes[0];

    // The dedup: the payload reference is a hash, the payload itself is not
    // present anywhere in the ledger line.
    const record = input.record as { id: string; embedding_text: string };
    expect(change.rowHash).toBe(rowHashOf(input.record));
    expect(change.row).toBeUndefined();
    expect(changeRecordShape(change)).toBe("rowHash");
    expect(
      fs
        .readFileSync(
          path.join(fixture.nsPath, AUDIT_DIR, AUDIT_CURRENT_SEGMENT),
          "utf-8",
        )
        .includes(record.embedding_text),
    ).toBe(false);

    // Accountability metadata is intact.
    expect(change.ts).toEqual(expect.any(String));
    expect(change.ns).toBe(fixture.ns);
    expect(change.table).toBe("memories");
    expect(change.op).toBe("insert");
    expect(change.key).toEqual({ id: record.id });
    expect(change.tombstone).toBe(false);
    expect(change.schemaVersion).toBe(1);
    expect(change.targetPath).toBe("concept/2026-09/current.jsonl");
    expect(change.principal).toBeNull();
  });

  it("rowHash is stable under key-order changes and sensitive to values", () => {
    expect(rowHashOf({ a: 1, b: 2 })).toBe(rowHashOf({ b: 2, a: 1 }));
    expect(stableStringify({ a: 1, b: { c: 2, d: 3 } })).toBe(
      stableStringify({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(rowHashOf({ a: 1 })).not.toBe(rowHashOf({ a: 2 }));
  });

  it("replay rehydrates the row from the committed data partition by hash", async () => {
    const fixture = fixtureFor();
    const input = memoryInput(2, fixture.ns);
    await fixture.writer.enqueue(input);
    await fixture.writer.flush();
    fixture.commit("test: insert commit");

    const changes = deriveCommitChanges(fixture.nsPath, "HEAD", {
      ns: fixture.ns,
      namespacePath: fixture.nsPath,
    });
    expect(changes).toHaveLength(1);
    // The derived surface keeps the row (feed contract), while the LEDGER
    // line itself carries only the hash.
    expect(changes[0].record.row).toEqual(input.record);
    expect(changes[0].record.rowHash).toBe(rowHashOf(input.record));
    expect(changes[0].record.op).toBe("insert");
    expect(changes[0].ordinal).toBe(1);
  });

  it("replay fails closed when the hashed row is absent from the data partition", async () => {
    const fixture = fixtureFor();
    await fixture.writer.enqueue(memoryInput(3, fixture.ns));
    await fixture.writer.flush();

    // Corrupt BEFORE the commit: the record enters git history already
    // pointing at a target that does not contain the hashed payload, so the
    // first commit that publishes the record must fail closed.
    const targetPath = ledgerRecords(fixture.nsPath).find(
      (entry) => entry.outcome === "accepted",
    )!.targetPath as string;
    fs.writeFileSync(path.join(fixture.nsPath, targetPath), "", "utf-8");
    fixture.commit("test: record published without its payload");

    expect(() =>
      deriveCommitChanges(fixture.nsPath, "HEAD", {
        ns: fixture.ns,
        namespacePath: fixture.nsPath,
        parentRef: null,
      }),
    ).toThrow(/rowHash.*matches no row|does not exist/s);
  });

  it("replay fails closed on a hash mismatch between ledger and data row", async () => {
    const fixture = fixtureFor();
    await fixture.writer.enqueue(memoryInput(4, fixture.ns));
    await fixture.writer.flush();

    // Tamper with the data row BEFORE the commit: the published record's
    // hash matches no row in the committed target.
    const targetPath = ledgerRecords(fixture.nsPath).find(
      (entry) => entry.outcome === "accepted",
    )!.targetPath as string;
    const dataFile = path.join(fixture.nsPath, targetPath);
    const dataLines = fs
      .readFileSync(dataFile, "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    const row = JSON.parse(dataLines[0]) as Record<string, unknown>;
    row.embedding_text = "tampered payload";
    dataLines[0] = JSON.stringify(row);
    fs.writeFileSync(dataFile, dataLines.join("\n") + "\n", "utf-8");
    fixture.commit("test: tampered row published with its record");

    expect(() =>
      deriveCommitChanges(fixture.nsPath, "HEAD", {
        ns: fixture.ns,
        namespacePath: fixture.nsPath,
        parentRef: null,
      }),
    ).toThrow(/matches no row/);
  });

  it("legacy row-shaped records still replay", async () => {
    const fixture = fixtureFor();
    const input = memoryInput(5, fixture.ns);
    await fixture.writer.enqueue(input);
    await fixture.writer.flush();

    // Rewrite the freshly written hash-shaped record into the LEGACY shape
    // (embedded row, no rowHash) — what a pre-SCHED-GAP-1574 ledger holds.
    const segment = path.join(
      fixture.nsPath,
      AUDIT_DIR,
      AUDIT_CURRENT_SEGMENT,
    );
    const lines = fs
      .readFileSync(segment, "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    const legacy: Record<string, unknown> = { ...last, row: input.record };
    delete legacy.rowHash;
    lines[lines.length - 1] = JSON.stringify(legacy);
    fs.writeFileSync(segment, lines.join("\n") + "\n", "utf-8");
    fixture.commit("test: legacy-shaped ledger");

    const changes = deriveCommitChanges(fixture.nsPath, "HEAD", {
      ns: fixture.ns,
      namespacePath: fixture.nsPath,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0].record.row).toEqual(input.record);
    expect(changes[0].record.rowHash).toBeUndefined();
    expect(changeRecordShape(changes[0].record)).toBe("row");
  });

  it("tombstone (delete) records carry the hash form too", async () => {
    const fixture = fixtureFor();
    const input = memoryInput(6, fixture.ns);
    await fixture.writer.enqueue(input);
    await fixture.writer.flush();

    const record = input.record as { id: string };
    await fixture.writer.enqueue({
      ns: fixture.ns,
      table: "memories",
      op: "delete",
      record: { ...record, action: "tombstone" } as typeof input.record,
      principal: undefined,
      targetPath: "concept/2026-09/current.jsonl",
    });
    await fixture.writer.flush();

    const changes = ledgerRecords(fixture.nsPath);
    const last = changes[changes.length - 1];
    expect(last.op).toBe("delete");
    expect(last.tombstone).toBe(true);
    expect(last.row).toBeUndefined();
    expect(last.rowHash).toEqual(expect.any(String));
    expect(last.key).toEqual({ id: record.id });
  });
});
