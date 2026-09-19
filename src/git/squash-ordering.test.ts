/**
 * Compaction ordering/naming regressions — same bug class as DB-GAP-049.
 *
 * The squash/compaction path lists partition files with `fs.readdirSync()`,
 * whose order is filesystem-dependent (on ext4 it is hash order, not creation
 * order). Three consequences, all fixed here:
 *
 *  1. removeTombstones() merged records in listing order and then named its
 *     output after `jsonlFiles[0]` — an ARBITRARY chunk. The name was
 *     therefore non-deterministic, and because the name ends in "-cleaned"
 *     every repeat run appended another one:
 *     `0007-cleaned-cleaned-cleaned.jsonl`.
 *  2. The merged record order was listing order, so a partition written
 *     9999.jsonl -> 10000.jsonl could come back reordered.
 *  3. squashPartition()/getCompactionStats() fed the same unsorted listing to
 *     DuckDB and the stats scan.
 *
 * Fixed by ordering every listing with the shared numeric comparator
 * (src/storage/jsonl.ts compareChunkNames) and by naming removeTombstones()
 * output after the LOWEST numeric segment it replaces, which keeps numbering
 * contiguous and makes the operation idempotent.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { removeTombstones, squashPartition } from "./squash";

let root: string;
let nsDir: string;
let partitionPath: string;

function record(id: number, action = "add"): string {
  return JSON.stringify({
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    key: `/event/order/${id}`,
    domain: "event",
    timestamp: new Date(1700000000000 + id * 1000).toISOString(),
    author: "test@example.com",
    action,
    embedding_text: `order record ${id}`,
    attributes: {},
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-squash-order-"));
  nsDir = path.join(root, "default");
  partitionPath = path.join(nsDir, "event", "2026-09");
  fs.mkdirSync(partitionPath, { recursive: true });
  fs.writeFileSync(
    path.join(nsDir, "manifest.json"),
    JSON.stringify({
      version: "1.0",
      createdAt: "2026-09-01T00:00:00.000Z",
      partitions: ["event/2026-09"],
      lastUpdated: "2026-09-01T00:00:00.000Z",
    }),
    "utf-8",
  );
  // Segments straddling the 4->5 digit boundary, written in append order.
  fs.writeFileSync(
    path.join(partitionPath, "9999.jsonl"),
    `${record(1)}\n${record(99, "tombstone")}\n`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(partitionPath, "10000.jsonl"),
    `${record(2)}\n${record(3)}\n`,
    "utf-8",
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("removeTombstones ordering and naming", () => {
  it("keeps records in append order and names the output after a numeric segment", async () => {
    const result = await removeTombstones(partitionPath);

    expect(result.error).toBeUndefined();
    expect(result.removed).toBe(1);
    expect(result.totalRecords).toBe(4);

    const files = fs
      .readdirSync(partitionPath)
      .filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    // A numeric segment name — before the fix this was "<arbitrary>-cleaned.jsonl".
    expect(files[0]).toMatch(/^\d+\.jsonl$/);

    const keys = fs
      .readFileSync(path.join(partitionPath, files[0]), "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l).key);
    expect(keys).toEqual([
      "/event/order/1",
      "/event/order/2",
      "/event/order/3",
    ]);
  });

  it("is idempotent — repeated runs do not accumulate '-cleaned' segment names", async () => {
    await removeTombstones(partitionPath);
    const first = fs
      .readdirSync(partitionPath)
      .filter((f) => f.endsWith(".jsonl"));
    const before = fs.readFileSync(path.join(partitionPath, first[0]), "utf-8");

    const second = await removeTombstones(partitionPath);
    expect(second.error).toBeUndefined();
    expect(second.removed).toBe(0);

    const files = fs
      .readdirSync(partitionPath)
      .filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(first[0]);
    expect(files[0]).toMatch(/^\d+\.jsonl$/);
    expect(fs.readFileSync(path.join(partitionPath, files[0]), "utf-8")).toBe(
      before,
    );
  });

  it("preserves records when the listing order is hostile (files created out of order)", async () => {
    // Recreate the partition with the higher segment written first: a listing
    // that mirrors creation order would merge 10000 before 9999.
    fs.rmSync(partitionPath, { recursive: true, force: true });
    fs.mkdirSync(partitionPath, { recursive: true });
    fs.writeFileSync(
      path.join(partitionPath, "10000.jsonl"),
      `${record(3)}\n`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(partitionPath, "9999.jsonl"),
      `${record(1)}\n`,
      "utf-8",
    );

    await removeTombstones(partitionPath);

    const files = fs
      .readdirSync(partitionPath)
      .filter((f) => f.endsWith(".jsonl"));
    const keys = fs
      .readFileSync(path.join(partitionPath, files[0]), "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l).key);
    expect(keys).toEqual(["/event/order/1", "/event/order/3"]);
  });
});

describe("squashPartition across the 9999 -> 10000 boundary", () => {
  it("compacts every segment and writes the parquet, dropping tombstones", async () => {
    const result = await squashPartition(partitionPath, {
      dryRun: false,
      squashCommits: false,
    });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    if (!result.success) return; // TS narrowing
    expect(result.recordsKept).toBe(3);
    expect(result.recordsRemoved).toBe(1);
    expect(fs.existsSync(result.parquetPath as string)).toBe(true);
    expect(
      new Date(fs.statSync(result.parquetPath as string).mtime).getTime(),
    ).toBeGreaterThan(0);

    // The JSONL segments are replaced by the parquet.
    const leftover = fs
      .readdirSync(partitionPath)
      .filter((f) => f.endsWith(".jsonl"));
    expect(leftover).toHaveLength(0);
  });
});
