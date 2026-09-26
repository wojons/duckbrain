/**
 * DuckBrain JSONL segment consolidation — DB-GAP-051
 *
 * `src/git/squash.ts` can only convert a WHOLE partition to Parquet, and it
 * skips partitions younger than `maxAge` days, so two segment-level defects
 * had no repair path that keeps the partition readable as JSONL:
 *
 *   1. Many near-empty segments. Live (2026-09-20): the partition
 *      `scheduler/event/2026-09/` holds 16,418 numeric segments and a
 *      150-file sample was **1 line each** — 16k git tree entries for 16k
 *      records against a 1000-line/1MB bound.
 *   2. Segments far past that bound. The same partition's `10000.jsonl` held
 *      88,206 lines / 84,677,070 bytes because the DB-GAP-049 rotation freeze
 *      (since fixed) fed every write into one name — an 84MB full blob per
 *      commit.
 *
 * This module plans and applies the missing segment-level pair while keeping
 * the partition JSONL:
 *
 *   - MERGE: a contiguous run of segments is packed into one output. Output
 *     names come from the group's own members, and a group is never allowed to
 *     straddle a segment the plan is not rewriting, so no surviving segment can
 *     sort into the middle of a rewritten run — the partition's record order is
 *     unchanged. A single plan emits EVERY group the partition needs (not one
 *     per invocation), so a partition of thousands of tiny segments converges
 *     in one run instead of thousands.
 *   - SPLIT: a segment over either bound is cut into consecutive chunks, each
 *     within both bounds. Chunks may only take names inside the input's own
 *     positional slot (between the nearest surviving neighbours, or after the
 *     last segment when nothing survives above), so a chunk can never sort
 *     ahead of records that precede it or behind records that follow it.
 *
 * Guarantees, enforced by construction and re-verified at execution time:
 *   - records are never re-serialized and never re-ordered: raw lines are
 *     copied byte-for-byte in `compareChunkNames` order, and the planner
 *     refuses to return a plan whose simulated layout is not the original
 *     record sequence (a planner bug fails before anything is written);
 *   - the total record count is identical before and after, and is asserted
 *     BEFORE any deletion — a writer bug cannot destroy records;
 *   - replacement content is always written before any input is deleted, so a
 *     crash mid-run leaves duplicates, never a hole;
 *   - an input that is also an OUTPUT of the plan (a split commonly re-uses its
 *     own name; a chunk may also re-use a name a merge frees) is never listed
 *     for deletion and never removed — deleting it would destroy the output
 *     that was just written;
 *   - an existing segment name is never overwritten unless the plan owns that
 *     name: every created name comes from a free pool built from the on-disk
 *     listing plus the names this plan has already claimed;
 *   - the operation is idempotent: a merge output ends at the bound and its
 *     neighbours no longer fit, and every chunk is within the bound, so a
 *     second plan is empty.
 *
 * Out of scope by design: `current.jsonl`, non-numeric names, `.parquet`,
 * `.gitkeep`. The serving read path (`src/duckdb/queries.ts`, `readPartition`)
 * is untouched — segment names are the only thing that changes.
 *
 * A single record larger than the byte bound becomes its own segment: a
 * segment cannot be split below one record, so the bound is a target for
 * *packing*, not a hard invariant for a single oversized record. Such a
 * segment is reported in `unplaceable` (with the reason) rather than silently
 * left behind.
 */

import * as fs from "fs";
import * as path from "path";
import { compareChunkNames, getNextChunkName } from "./jsonl";
import {
  invalidateKeysCache,
  namespacePathForPartition,
} from "../keys/keyListCache";

/**
 * Maximum records per segment. Mirrors `MAX_LINES_PER_CHUNK` in `./jsonl`
 * (not exported there): the module intentionally does not change the writer,
 * and `segment-consolidation.test.ts` pins this pair to the real rotation
 * behaviour of `resolveJsonlTargetPath` so the two cannot drift apart.
 */
export const SEGMENT_MAX_LINES = 1000;

/**
 * Maximum bytes per segment (1MB). Mirrors `MAX_BYTES_PER_CHUNK` in `./jsonl`;
 * see `SEGMENT_MAX_LINES` on the drift guard.
 */
export const SEGMENT_MAX_BYTES = 1024 * 1024;

/** A rotation-eligible segment: `<digits>.jsonl`, excluding `current.jsonl`. */
const NUMERIC_SEGMENT = /^\d+\.jsonl$/;

/** One planned merge: pack `inputs` (contiguous, ascending) into `output`. */
export interface SegmentMerge {
  /** Input basenames, ascending by `compareChunkNames`. */
  inputs: string[];
  /**
   * Output basename — always `inputs[0]`, so the run's records keep their
   * position and only the run's own names are rewritten.
   */
  output: string;
  /** Record lines in the output. */
  lines: number;
  /** Bytes in the output (each line plus its newline). */
  bytes: number;
}

/** One chunk of a split: the records `[from, to)` of the input, renamed. */
export interface SegmentSplitChunk {
  /** Output basename. */
  name: string;
  /** First input record in this chunk (inclusive). */
  from: number;
  /** One past the last input record in this chunk (exclusive). */
  to: number;
  /** Records in this chunk (`to - from`). */
  lines: number;
  /** Bytes in this chunk (each line plus its newline). */
  bytes: number;
}

/** One planned split: cut `input` into `chunks` (ascending, order-preserving). */
export interface SegmentSplit {
  /** Input basename. */
  input: string;
  /** Record lines in the input. */
  inputLines: number;
  /** Bytes in the input. */
  inputBytes: number;
  /**
   * Chunks in record order. `chunks[i].name` is ascending in `i` by
   * `compareChunkNames`, so writing chunk `i` to its name preserves order.
   */
  chunks: SegmentSplitChunk[];
}

/** A segment that needs work but cannot be placed without re-ordering. */
export interface SegmentSplitBlocker {
  /** Segment basename. */
  input: string;
  /** Why the plan refused it. */
  reason: string;
}

/**
 * A consolidation plan. `planSegmentConsolidation()` returns this without
 * writing anything — it is safe to inspect, log, and re-run.
 */
export interface SegmentConsolidationPlan {
  /** Partition directory the plan was computed for. */
  partitionPath: string;
  /** Segment merges, ascending. Empty when the partition is already bounded. */
  merges: SegmentMerge[];
  /** Segment splits, ascending. Empty when every segment is within bounds. */
  splits: SegmentSplit[];
  /** Segments over a bound that could not be split without re-ordering. */
  unplaceable: SegmentSplitBlocker[];
  /** Every basename the plan writes (merge outputs + split chunks), unique. */
  writtenFiles: string[];
  /** Written basenames that do not exist yet (the plan creates them). */
  addedFiles: string[];
  /**
   * Basenames the plan deletes. Never intersects `writtenFiles`: an input that
   * is also an output is REPLACED by its own write, not removed.
   */
  removedFiles: string[];
  /** Before/after counters. `recordsBefore` and `recordsAfter` must be equal. */
  stats: {
    segmentsBefore: number;
    segmentsAfter: number;
    recordsBefore: number;
    recordsAfter: number;
    bytesBefore: number;
    bytesAfter: number;
  };
}

/** Result of applying a plan (or of a dry run). */
export interface SegmentConsolidationResult {
  /** True when nothing was written (dry run). */
  dryRun: boolean;
  /** The plan that was applied (or would be). */
  plan: SegmentConsolidationPlan;
  /** Outputs written, in write order (empty on a dry run). */
  written: string[];
  /** Inputs deleted, in delete order (empty on a dry run). */
  removed: string[];
  /** Plan statistics, with `segmentsAfter` re-counted from disk. */
  stats: SegmentConsolidationPlan["stats"];
}

/** Execute-time options. */
export interface ExecuteSegmentConsolidationOptions {
  /** Compute and return the plan with zero writes. */
  dryRun?: boolean;
}

/**
 * One segment's on-disk facts plus its raw lines.
 *
 * `lines` holds the RAW line text (no trailing newline) exactly as stored, so
 * a merge/split can re-emit the identical bytes. Empty/whitespace-only lines
 * are dropped from `lines` — the same predicate `readFromJsonl` and
 * `countLines` use — so the record count this module reports is the record
 * count every reader sees.
 */
interface SegmentContent {
  name: string;
  number: number;
  sizeBytes: number;
  lines: string[];
  /** Bytes per line including the terminating newline, parallel to `lines`. */
  lineBytes: number[];
}

/** One packable unit: a whole segment (merge) or a single record (split). */
interface PackUnit {
  lines: number;
  bytes: number;
}

/** Half-open `[start, end)` index range of a pack group. */
type PackRange = [number, number];

/** Numeric segments of a partition, in `compareChunkNames` order. */
function listNumericSegments(partitionPath: string): string[] {
  return fs
    .readdirSync(partitionPath)
    .filter((f) => NUMERIC_SEGMENT.test(f))
    .sort(compareChunkNames);
}

/** Raw records of a file: non-blank lines, in order. */
function readLines(filePath: string): string[] {
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

/**
 * Read one segment. Byte accounting uses the bytes actually re-emitted (each
 * line plus its newline), not the stat size: a file whose last line lacks a
 * trailing newline would otherwise be measured one byte smaller than the
 * content this module writes back.
 */
function readSegment(partitionPath: string, name: string): SegmentContent {
  const buf = fs.readFileSync(path.join(partitionPath, name));
  const lines = buf
    .toString("utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  return {
    name,
    number: segmentNumber(name),
    sizeBytes: buf.length,
    lines,
    lineBytes: lines.map((l) => Buffer.byteLength(l, "utf-8") + 1),
  };
}

/** Numeric value of a `<digits>.jsonl` basename. */
function segmentNumber(name: string): number {
  return parseInt(name.replace(/\.jsonl$/, ""), 10);
}

/** Format a segment number the way `getNextChunkName()` does. */
function segmentName(n: number): string {
  return `${n.toString().padStart(4, "0")}.jsonl`;
}

/** Bytes of a segment as re-emitted (every line plus its newline). */
function segmentBytes(seg: SegmentContent): number {
  return seg.lineBytes.reduce((a, b) => a + b, 0);
}

/** True when a segment is over either bound and therefore needs a split. */
function isOversize(seg: SegmentContent): boolean {
  return (
    seg.lines.length > SEGMENT_MAX_LINES ||
    segmentBytes(seg) > SEGMENT_MAX_BYTES
  );
}

/**
 * Pack `units` into consecutive groups, each within BOTH bounds.
 *
 * The bound rule mirrors `resolveJsonlTargetPath`'s rotation, which moves the
 * incoming record to a new segment when the current segment already holds
 * `MAX_LINES_PER_CHUNK` records or when `size + record` would exceed
 * `MAX_BYTES_PER_CHUNK` — so an output may land exactly ON a bound, never past
 * it. A unit that is itself over a bound still gets a group of its own (it
 * cannot be split further); a group is never empty.
 */
function packUnits(units: PackUnit[]): PackRange[] {
  const groups: PackRange[] = [];
  let start = 0;
  let lines = 0;
  let bytes = 0;

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (
      i > start &&
      (lines + unit.lines > SEGMENT_MAX_LINES ||
        bytes + unit.bytes > SEGMENT_MAX_BYTES)
    ) {
      groups.push([start, i]);
      start = i;
      lines = 0;
      bytes = 0;
    }
    lines += unit.lines;
    bytes += unit.bytes;
  }
  if (units.length > 0) groups.push([start, units.length]);
  return groups;
}

/**
 * Build the plan for one partition. Read-only: it stats and reads segments,
 * and writes nothing.
 *
 * @param partitionPath - Absolute path to a partition directory
 * @throws Error when the partition does not exist, is not a directory, or the
 *   computed layout would not preserve the partition's record order
 */
export function planSegmentConsolidation(
  partitionPath: string,
): SegmentConsolidationPlan {
  if (!fs.existsSync(partitionPath)) {
    throw new Error(`Partition not found: ${partitionPath}`);
  }
  if (!fs.statSync(partitionPath).isDirectory()) {
    throw new Error(`Partition is not a directory: ${partitionPath}`);
  }

  const onDisk = fs.readdirSync(partitionPath);
  const onDiskSet = new Set(onDisk);
  const segments = listNumericSegments(partitionPath).map((n) =>
    readSegment(partitionPath, n),
  );
  const indexOf = new Map<string, number>(
    segments.map((s, i) => [s.name, i] as const),
  );
  const maxOnDisk = segments.reduce((m, s) => Math.max(m, s.number), 0);

  // An oversize segment is a split input. It is also a BARRIER: it can never
  // join a merge group (moving it would place its records ahead of segments
  // that follow it), and no merge group may straddle it.
  const splitInputs = new Set<string>();
  for (const seg of segments) {
    if (isOversize(seg)) splitInputs.add(seg.name);
  }

  // ---- merges: every contiguous run the partition needs -------------------
  // One plan emits ALL groups (a partition of thousands of tiny segments would
  // otherwise need thousands of invocations to converge).
  const merges: SegmentMerge[] = [];
  const mergedAway = new Set<number>();
  {
    let group: SegmentContent[] = [];
    let lines = 0;
    let bytes = 0;
    const flush = (): void => {
      if (group.length >= 2) {
        merges.push({
          inputs: group.map((g) => g.name),
          output: group[0].name,
          lines,
          bytes,
        });
        for (const g of group.slice(1)) mergedAway.add(g.number);
      }
      group = [];
      lines = 0;
      bytes = 0;
    };
    for (const seg of segments) {
      if (splitInputs.has(seg.name)) {
        flush(); // barrier: the group cannot cross a segment we are not moving
        continue;
      }
      const segLines = seg.lines.length;
      const segBytes = segmentBytes(seg);
      if (
        group.length > 0 &&
        (lines + segLines > SEGMENT_MAX_LINES ||
          bytes + segBytes > SEGMENT_MAX_BYTES)
      ) {
        flush();
      }
      group.push(seg);
      lines += segLines;
      bytes += segBytes;
    }
    flush();
  }

  // Names that hold records AFTER the merges. A merge output keeps its group's
  // first name, so merged-away numbers become free; everything else survives.
  const survivors = new Set<number>(segments.map((s) => s.number));
  for (const n of mergedAway) survivors.delete(n);

  // ---- splits -------------------------------------------------------------
  const splits: SegmentSplit[] = [];
  const unplaceable: SegmentSplitBlocker[] = [];
  const claimed = new Set<string>();
  const claimedNumbers = new Set<number>();

  for (const seg of segments) {
    if (!isOversize(seg)) continue;
    const n = seg.number;

    // Pack the input's own RECORDS (not whole segments: a single segment
    // always packs into one group, which is why a segment-level packer can
    // never split anything).
    const ranges = packUnits(
      seg.lineBytes.map((b) => ({ lines: 1, bytes: b })),
    );
    if (ranges.length <= 1) {
      unplaceable.push({
        input: seg.name,
        reason:
          "cannot be split below one record (a single record exceeds a bound)",
      });
      continue;
    }

    const need = ranges.length - 1;
    const prevSurvivor = greatestBelow(survivors, n);
    const nextSurvivor = leastAbove(survivors, n);

    // Names may only come from this input's own positional slot: strictly
    // between the nearest surviving neighbours (or after the last one, when
    // nothing survives above). Closest-free-first keeps the chunks beside
    // their input; names above the slot would move records past a survivor.
    const usable = (c: number): boolean =>
      c !== n && !survivors.has(c) && !claimedNumbers.has(c);

    const chosen: number[] = [];
    for (let c = n - 1; c > prevSurvivor && chosen.length < need; c--) {
      if (usable(c)) chosen.push(c);
    }
    if (chosen.length < need && nextSurvivor === null) {
      // Nothing survives above this input, so names above it are in the slot.
      // The first candidate is the append path's own rotation answer.
      let c =
        maxOnDisk === 0
          ? segmentNumber(getNextChunkName(partitionPath))
          : maxOnDisk + 1;
      c = Math.max(c, n + 1);
      for (; chosen.length < need; c++) {
        if (usable(c)) chosen.push(c);
      }
    }

    if (chosen.length < need) {
      unplaceable.push({
        input: seg.name,
        reason:
          `needs ${need} free segment name(s) in its own slot but only ` +
          `${chosen.length} available` +
          (nextSurvivor === null
            ? ""
            : ` (a retained segment sorts above it at ${segmentName(
                nextSurvivor,
              )}, so names above it would re-order the partition)`),
      });
      continue;
    }

    for (const c of chosen) {
      claimed.add(segmentName(c));
      claimedNumbers.add(c);
    }

    const names = [...chosen, n].map(segmentName).sort(compareChunkNames);

    splits.push({
      input: seg.name,
      inputLines: seg.lines.length,
      inputBytes: segmentBytes(seg),
      chunks: ranges.map(([from, to], i) => ({
        name: names[i],
        from,
        to,
        lines: to - from,
        bytes: seg.lineBytes.slice(from, to).reduce((a, b) => a + b, 0),
      })),
    });
  }

  // ---- counters -----------------------------------------------------------
  // D2: a name the plan WRITES is never also a name the plan deletes. A split
  // input is rewritten under its own name (usually), and a chunk may legally
  // re-use a name a merge frees — deleting either would destroy output records.
  const writtenFiles = [
    ...merges.map((m) => m.output),
    ...splits.flatMap((s) => s.chunks.map((c) => c.name)),
  ];
  const written = new Set(writtenFiles);
  const candidateRemovals = [
    ...merges.flatMap((m) => m.inputs.slice(1)),
    ...splits.map((s) => s.input),
  ];
  const removedFiles = [
    ...new Set(candidateRemovals.filter((n) => !written.has(n))),
  ];
  const addedFiles = writtenFiles.filter((n) => !onDiskSet.has(n));

  const recordsBefore = segments.reduce((a, s) => a + s.lines.length, 0);
  const bytesBefore = segments.reduce((a, s) => a + segmentBytes(s), 0);

  const plan: SegmentConsolidationPlan = {
    partitionPath,
    merges,
    splits,
    unplaceable,
    writtenFiles,
    addedFiles,
    removedFiles,
    stats: {
      segmentsBefore: segments.length,
      segmentsAfter: segments.length - removedFiles.length + addedFiles.length,
      recordsBefore,
      // A merge/split is a re-filing of the same records: the totals must be
      // identical, and a mismatch means the PLANNER is wrong.
      recordsAfter: recordsBefore,
      bytesBefore,
      bytesAfter: bytesBefore,
    },
  };

  assertPlanLayout(plan, segments, indexOf);

  if (plan.stats.recordsAfter !== plan.stats.recordsBefore) {
    throw new Error(
      `Segment plan is not record-preserving for ${partitionPath}: ` +
        `${plan.stats.recordsBefore} before, ${plan.stats.recordsAfter} after`,
    );
  }

  return plan;
}

/** Greatest member of `numbers` strictly below `n`, or 0 when there is none. */
function greatestBelow(numbers: Set<number>, n: number): number {
  let best = 0;
  for (const c of numbers) {
    if (c < n && c > best) best = c;
  }
  return best;
}

/** Least member of `numbers` strictly above `n`, or null when there is none. */
function leastAbove(numbers: Set<number>, n: number): number | null {
  let best: number | null = null;
  for (const c of numbers) {
    if (c > n && (best === null || c < best)) best = c;
  }
  return best;
}

/**
 * Prove the planned layout IS the partition's record sequence.
 *
 * Each planned file is described as runs of the ORIGINAL segments (a merge
 * concatenates its members; a split takes `[from, to)` of its input). Walking
 * the files in `compareChunkNames` order and requiring each run to continue the
 * global record counter proves, without touching the disk, that no record was
 * dropped, duplicated, or moved. This is the check that makes the planner's
 * ordering claims structural instead of aspirational.
 */
function assertPlanLayout(
  plan: SegmentConsolidationPlan,
  segments: SegmentContent[],
  indexOf: Map<string, number>,
): void {
  const base: number[] = [];
  let total = 0;
  for (const seg of segments) {
    base.push(total);
    total += seg.lines.length;
  }

  interface Run {
    seg: number;
    from: number;
    to: number;
  }
  const files: Array<{ name: string; runs: Run[] }> = [];
  // Every merge input is absorbed into its group's output (including the first
  // one, whose NAME the output takes).
  const absorbed = new Set<string>(plan.merges.flatMap((m) => m.inputs));
  const splitOf = new Map(plan.splits.map((s) => [s.input, s] as const));

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (absorbed.has(seg.name)) continue; // its records moved into a merge output
    const split = splitOf.get(seg.name);
    if (split) {
      for (const chunk of split.chunks) {
        files.push({
          name: chunk.name,
          runs: [{ seg: i, from: chunk.from, to: chunk.to }],
        });
      }
      continue;
    }
    files.push({
      name: seg.name,
      runs: [{ seg: i, from: 0, to: seg.lines.length }],
    });
  }
  for (const merge of plan.merges) {
    files.push({
      name: merge.output,
      runs: merge.inputs.map((n) => {
        const i = indexOf.get(n) as number;
        return { seg: i, from: 0, to: segments[i].lines.length };
      }),
    });
  }

  const names = files.map((f) => f.name);
  if (new Set(names).size !== names.length) {
    throw new Error(
      `Segment plan writes the same basename twice for ${plan.partitionPath}: ` +
        `${names.join(", ")}`,
    );
  }
  files.sort((a, b) => compareChunkNames(a.name, b.name));

  let cursor = 0;
  for (const file of files) {
    for (const run of file.runs) {
      const start = base[run.seg] + run.from;
      if (start !== cursor) {
        throw new Error(
          `Segment plan for ${plan.partitionPath} would re-order records: ` +
            `file ${file.name} starts at record ${start} but record ` +
            `${cursor} is next`,
        );
      }
      cursor = base[run.seg] + run.to;
    }
  }
  if (cursor !== total) {
    throw new Error(
      `Segment plan for ${plan.partitionPath} loses records: covers ` +
        `${cursor} of ${total}`,
    );
  }
}

/**
 * Apply a consolidation plan to a partition.
 *
 * Order of operations is the crash-safety contract:
 *   1. read EVERY input before writing anything — a split may re-use a name a
 *      merge frees, so a write can clobber an input another operation still
 *      has to read;
 *   2. write every output (temp file + rename, so a reader never sees a
 *      half-written segment) — the partition is now a superset of its records;
 *   3. re-verify the partition's record count against the plan; throw BEFORE
 *      any deletion if it disagrees, leaving every input in place;
 *   4. delete the superseded inputs (never a name this run wrote);
 *   5. re-verify that the partition still reads as the exact record sequence it
 *      did before.
 *
 * @param partitionPath - Partition directory
 * @param options - `{ dryRun: true }` computes the plan and writes nothing
 * @throws Error when the partition is missing, a plan invariant fails, or the
 *   record count/order would change
 */
export function executeSegmentConsolidation(
  partitionPath: string,
  options: ExecuteSegmentConsolidationOptions = {},
): SegmentConsolidationResult {
  const dryRun = options.dryRun === true;
  const plan = planSegmentConsolidation(partitionPath);

  if (dryRun) {
    return { dryRun: true, plan, written: [], removed: [], stats: plan.stats };
  }

  // D2 precondition: refuse a plan that would delete something it wrote. The
  // planner never emits such a plan; this is the executor's own guard.
  const clobbered = plan.removedFiles.filter((n) =>
    plan.writtenFiles.includes(n),
  );
  if (clobbered.length > 0) {
    throw new Error(
      `Refusing to execute: the plan both writes and deletes ` +
        `${clobbered.join(", ")} (partition ${partitionPath})`,
    );
  }

  const orderBefore = readOrderedLines(partitionPath);

  // ---- 1. read every input up front --------------------------------------
  const mergeInputs = plan.merges.map((m) => ({
    merge: m,
    sources: m.inputs.map((n) => readSegment(partitionPath, n)),
  }));
  const splitInputs = plan.splits.map((s) => ({
    split: s,
    source: readSegment(partitionPath, s.input),
  }));

  // ---- 2. write every replacement before deleting anything ---------------
  const written: string[] = [];
  for (const { merge, sources } of mergeInputs) {
    writeSegmentAtomic(
      partitionPath,
      merge.output,
      sources.flatMap((s) => s.lines),
    );
    written.push(merge.output);
  }
  for (const { split, source } of splitInputs) {
    for (const chunk of split.chunks) {
      writeSegmentAtomic(
        partitionPath,
        chunk.name,
        source.lines.slice(chunk.from, chunk.to),
      );
      written.push(chunk.name);
    }
  }

  // ---- 3. verify BEFORE deleting: every record is in a replacement or in a
  // file the plan leaves alone. Writes are additive until step 4 (a split may
  // re-use a name a merge frees), so the check cannot be the whole-partition
  // count; it must account for the inputs that are still on disk but are about
  // to be superseded.
  const superseded = new Set([...plan.writtenFiles, ...plan.removedFiles]);
  const untouched = listNumericSegments(partitionPath).filter(
    (n) => !superseded.has(n),
  );
  const accounted =
    countRecordsIn(partitionPath, plan.writtenFiles) +
    countRecordsIn(partitionPath, untouched);
  if (accounted !== plan.stats.recordsBefore) {
    throw new Error(
      `Refusing to delete: replacements + untouched files account for ` +
        `${accounted} record(s), expected ${plan.stats.recordsBefore} ` +
        `(partition ${partitionPath}). All inputs are untouched.`,
    );
  }

  // ---- 4. delete superseded inputs ---------------------------------------
  const removed: string[] = [];
  for (const name of plan.removedFiles) {
    fs.unlinkSync(path.join(partitionPath, name));
    removed.push(name);
  }

  // ---- 5. verify the final state -----------------------------------------
  const after = countPartitionRecords(partitionPath);
  if (after !== plan.stats.recordsBefore) {
    throw new Error(
      `Record count changed: ${plan.stats.recordsBefore} before, ${after} ` +
        `after (partition ${partitionPath})`,
    );
  }
  assertOrderPreserved(partitionPath, orderBefore);

  // PERF-001: consolidation renames/splits/merges segment files — invalidate
  // the key-list cache so the next list_keys read rebuilds (best-effort).
  const perfNsPath = namespacePathForPartition(partitionPath);
  if (perfNsPath) invalidateKeysCache(perfNsPath);

  const stats = {
    ...plan.stats,
    segmentsAfter: listNumericSegments(partitionPath).length,
  };

  return { dryRun: false, plan, written, removed, stats };
}

/** Every record of a partition's numeric segments, in read order. */
function readOrderedLines(partitionPath: string): string[] {
  const out: string[] = [];
  for (const name of listNumericSegments(partitionPath)) {
    for (const line of readLines(path.join(partitionPath, name))) {
      out.push(line);
    }
  }
  return out;
}

/**
 * The partition must read back as exactly the sequence it read before, record
 * for record. This is what makes "no record survives a rename/loss" a checked
 * property instead of a claim: a split that wrote one chunk over another, or a
 * delete that removed an output, fails here.
 */
function assertOrderPreserved(
  partitionPath: string,
  orderBefore: string[],
): void {
  let i = 0;
  for (const name of listNumericSegments(partitionPath)) {
    for (const line of readLines(path.join(partitionPath, name))) {
      if (i >= orderBefore.length || orderBefore[i] !== line) {
        throw new Error(
          `Record ${i} changed after consolidation (partition ` +
            `${partitionPath}, file ${name})`,
        );
      }
      i += 1;
    }
  }
  if (i !== orderBefore.length) {
    throw new Error(
      `Record count changed: ${orderBefore.length} before, ${i} after ` +
        `(partition ${partitionPath})`,
    );
  }
}

/**
 * Write a segment as the concatenation of `lines`, in order.
 *
 * Lines are copied byte-for-byte (no re-serialization) and each gets exactly
 * one trailing newline. The write goes to a temporary sibling and is renamed
 * into place, so a concurrent reader sees either the old segment or the
 * complete new one, never a partial file.
 */
function writeSegmentAtomic(
  partitionPath: string,
  name: string,
  lines: string[],
): void {
  const body = lines.length === 0 ? "" : lines.join("\n") + "\n";
  const tmp = path.join(partitionPath, `.${name}.tmp`);
  fs.writeFileSync(tmp, body, "utf-8");
  fs.renameSync(tmp, path.join(partitionPath, name));
}

/** Record count across the partition's numeric segments. */
function countPartitionRecords(partitionPath: string): number {
  let total = 0;
  for (const name of listNumericSegments(partitionPath)) {
    total += readLines(path.join(partitionPath, name)).length;
  }
  return total;
}

/** Record count across a named set of segment files (all must exist). */
function countRecordsIn(partitionPath: string, names: string[]): number {
  let total = 0;
  for (const name of names) {
    total += readLines(path.join(partitionPath, name)).length;
  }
  return total;
}
