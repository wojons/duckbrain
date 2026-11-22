/**
 * PERF-017 — the malformed-scan cache must survive a corpus larger than its
 * cap WITHOUT going stale, and must evict boundedly instead of clearing.
 *
 * Guard for AC(3): the (size, mtimeMs) per-file invalidation is the only
 * thing that detects an appended torn line, and PERF-017 deliberately did
 * not touch it. This fixture replays the measured ground truth from the
 * perf lane's probe-cache-correctness.mjs
 * (/home/kara/.hermes/cache/scratch/perf-db-tick-102207/out/cache-correctness.txt):
 * five clean chunks, then one torn line appended to a chunk, then a second
 * torn line appended to another — five successive calls must report skipped
 * counts [0, 0, 1, 1, 2]. A cache that serves a stale clean verdict after an
 * append fails at the third observation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { resetCorruptionCache, scanMalformedLines } from "./corruption";

const TORN_JSON_LINE = '{"id":"torn1"\n';
const TORN_PLAIN_LINE = "not-json\n";

let dir: string;

beforeEach(() => {
  resetCorruptionCache();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-perf017-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Five clean chunks with two intact records each (probe fixture shape). */
function makeFiveCleanChunks(dir: string): string[] {
  const files: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const file = path.join(dir, `${String(i).padStart(4, "0")}.jsonl`);
    fs.writeFileSync(file, `{"id":"a${i}"}\n{"id":"b${i}"}\n`);
    files.push(file);
  }
  return files;
}

describe("PERF-017 cache correctness across repeated calls", () => {
  it("reports skipped counts [0, 0, 1, 1, 2] as torn lines are appended", () => {
    const files = makeFiveCleanChunks(dir);

    const skipped: number[] = [];
    const fileCounts: number[] = [];
    const observe = (): void => {
      const report = scanMalformedLines(files);
      skipped.push(report.skipped);
      fileCounts.push(report.files.length);
    };

    observe(); // clean-initial
    observe(); // clean-repeat-cached (served from the cache)

    // Append the first torn line to chunk 0002 — the (size, mtimeMs)
    // invalidation must fire and the re-scan must see it.
    fs.appendFileSync(files[2], TORN_JSON_LINE);
    observe(); // after-torn-append
    observe(); // after-torn-repeat (cached clean chunks, re-scanned torn one)

    // Append a second torn line to a DIFFERENT chunk (0004).
    fs.appendFileSync(files[4], TORN_PLAIN_LINE);
    observe(); // after-second-torn

    expect(skipped).toEqual([0, 0, 1, 1, 2]);
    expect(fileCounts).toEqual([0, 0, 1, 1, 2]);
  });

  it("names the appended chunk with its count and first bad line", () => {
    const files = makeFiveCleanChunks(dir);
    scanMalformedLines(files); // warm the cache with clean verdicts

    fs.appendFileSync(files[2], TORN_JSON_LINE);
    const report = scanMalformedLines(files);

    expect(report.files).toHaveLength(1);
    expect(report.files[0]?.path).toBe(files[2]);
    expect(report.files[0]?.line).toBe(3); // two intact records precede it
    expect(report.files[0]?.skipped).toBe(1);
  });
});
