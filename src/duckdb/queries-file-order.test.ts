/**
 * Query-layer file ordering — DB-GAP-050 (same bug class as DB-GAP-049).
 *
 * collectJsonlFiles() handed DuckDB the result of `fs.readdirSync()` with no
 * ordering, so the ingest order of a partition was filesystem-dependent (ext4
 * hash order, not creation order) and could differ between hosts or between
 * runs. Segment names past 9999 are not fixed-width, so even a lexicographic
 * sort would order them wrongly. It now uses the shared numeric comparator.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { collectJsonlFiles } from "./queries";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-collect-order-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function basenames(paths: string[]): string[] {
  return paths.map((p) => path.basename(p));
}

describe("collectJsonlFiles ordering", () => {
  it("returns numeric segments in numeric order across the 4->5 digit boundary", () => {
    const names = ["10001.jsonl", "9999.jsonl", "0002.jsonl", "10000.jsonl"];
    for (const n of names) fs.writeFileSync(path.join(root, n), "", "utf8");

    expect(basenames(collectJsonlFiles([root]))).toEqual([
      "0002.jsonl",
      "9999.jsonl",
      "10000.jsonl",
      "10001.jsonl",
    ]);
  });

  it("is stable regardless of the order files were created in", () => {
    const names = ["0007.jsonl", "0008.jsonl", "10000.jsonl", "0009.jsonl"];
    for (const n of names) fs.writeFileSync(path.join(root, n), "", "utf8");
    const first = basenames(collectJsonlFiles([root]));

    // Recreate the same set in a different creation order.
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    for (const n of [...names].reverse())
      fs.writeFileSync(path.join(root, n), "", "utf8");

    expect(basenames(collectJsonlFiles([root]))).toEqual(first);
  });

  it("keeps non-numeric names after numeric ones and ignores non-jsonl files", () => {
    for (const n of [
      "current.jsonl",
      "0001.jsonl",
      "notes.md",
      "0001.jsonl.bak",
    ]) {
      fs.writeFileSync(path.join(root, n), "", "utf8");
    }

    expect(basenames(collectJsonlFiles([root]))).toEqual([
      "0001.jsonl",
      "current.jsonl",
    ]);
  });

  it("concatenates multiple partitions in the order given", () => {
    const p1 = path.join(root, "event", "2026-08");
    const p2 = path.join(root, "event", "2026-09");
    fs.mkdirSync(p1, { recursive: true });
    fs.mkdirSync(p2, { recursive: true });
    fs.writeFileSync(path.join(p1, "0001.jsonl"), "", "utf8");
    fs.writeFileSync(path.join(p2, "0001.jsonl"), "", "utf8");

    const files = collectJsonlFiles([p1, p2]);
    expect(files).toHaveLength(2);
    expect(files[0]).toContain(path.join("2026-08", "0001.jsonl"));
    expect(files[1]).toContain(path.join("2026-09", "0001.jsonl"));
  });
});
