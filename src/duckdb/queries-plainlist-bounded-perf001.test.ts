/**
 * PERF-DUCKBRAIN-001 — bounded top-k plain-list read.
 *
 * The plain-list path (no query/embedding/attr/time-range) replaced the
 * whole-corpus dedup sort (ROW_NUMBER over every id) with a bounded
 * recency-ordered top-k + code-side dedupe + refill, and derives `total`
 * from an arg_max hash aggregation instead of the window sort. This file
 * proves the new path is byte-equivalent to the untouched fused statement
 * (queryMemoriesWithTotalFused) across duplicate ids, tombstones, boundary
 * straddles, offsets, and that `total` equals a brute-force deduped count.
 *
 * Rows are seeded as RAW JSONL (not via insertMemory) so the test can pin
 * exact timestamps and tombstones the write path would not emit, exactly
 * like queries-dedup-mixed-timestamp.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDuckDB, closeDuckDB } from "./connection";
import {
  queryMemoriesWithTotal,
  queryMemoriesWithTotalFused,
  collectJsonlFiles,
} from "./queries";
import path from "path";
import fs from "fs";
import os from "os";

interface SeedRow {
  id: string;
  key: string;
  timestamp: string;
  action?: "add" | "update" | "tombstone";
}

function line(row: SeedRow): string {
  return (
    JSON.stringify({
      id: row.id,
      key: row.key,
      domain: "event",
      timestamp: row.timestamp,
      author: "test@example.com",
      action: row.action ?? "add",
      embedding_text: `record ${row.id}`,
      attributes: {},
    }) + "\n"
  );
}

function fixtureId(label: string): string {
  return `00000000-0000-4000-8000-${Buffer.from(label)
    .toString("hex")
    .padEnd(12, "0")
    .slice(0, 12)}`;
}

const A = fixtureId("a");
const B = fixtureId("b");
const C = fixtureId("c");
const D = fixtureId("d");
const E = fixtureId("e");

/** Corpus 1: duplicate id (update chain), a tombstoned id, distinct ids. */
function corpus1(): SeedRow[] {
  return [
    { id: A, key: "/p/a", timestamp: "2026-09-01T10:00:00.000Z" },
    { id: A, key: "/p/a", timestamp: "2026-09-01T11:00:00.000Z", action: "update" },
    { id: B, key: "/p/b", timestamp: "2026-09-02T10:00:00.000Z" },
    { id: C, key: "/p/c", timestamp: "2026-09-03T10:00:00.000Z" },
    { id: C, key: "/p/c", timestamp: "2026-09-03T11:00:00.000Z", action: "tombstone" },
    { id: D, key: "/p/d", timestamp: "2026-09-04T10:00:00.000Z" },
    { id: E, key: "/p/e", timestamp: "2026-09-05T10:00:00.000Z" },
  ];
}

/**
 * Corpus 2: 60 duplicate versions of one id (newest `add`, 59 `update`s)
 * followed by 5 distinct ids. With limit=10 the initial bounded window
 * (60 raw rows) collapses to a single live row, forcing a REFILL that must
 * recover the 5 distinct ids cut off by the boundary.
 */
function corpus2(): SeedRow[] {
  const rows: SeedRow[] = [];
  const dupId = fixtureId("dup");
  const base = Date.parse("2026-08-01T01:00:00.000Z");
  // Newest first: 60 versions of one id, one second apart (i=0 is newest).
  for (let i = 0; i < 60; i += 1) {
    rows.push({
      id: dupId,
      key: "/p/dup",
      timestamp: new Date(base - i * 1000).toISOString(),
      action: i === 0 ? "add" : "update",
    });
  }
  // 5 distinct ids, older than every duplicate version.
  for (let i = 0; i < 5; i += 1) {
    rows.push({
      id: fixtureId(`d${i}`),
      key: `/p/d${i}`,
      timestamp: new Date(base - (60 + i) * 1000).toISOString(),
    });
  }
  return rows;
}

/** Brute-force deduped live count: newest version per id, tombstones excluded. */
function bruteForceLiveCount(files: string[]): number {
  const newest = new Map<string, { ts: number; action: string }>();
  for (const file of files) {
    for (const text of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!text.trim()) continue;
      const row = JSON.parse(text);
      const ts = Date.parse(row.timestamp);
      const cur = newest.get(row.id);
      if (cur === undefined || ts > cur.ts) {
        newest.set(row.id, { ts, action: row.action ?? "add" });
      }
    }
  }
  let live = 0;
  for (const { action } of newest.values()) {
    if (action !== "tombstone") live += 1;
  }
  return live;
}

describe("PERF-DUCKBRAIN-001: bounded plain-list read matches the fused statement", () => {
  let db: any;
  const partition = fs.mkdtempSync(
    path.join(os.tmpdir(), "duckbrain-perf001-"),
  );

  beforeAll(async () => {
    db = await initDuckDB(":memory:");
  });

  beforeEach(() => {
    // Fresh single chunk file per test so seeded rows never accumulate.
    const f = path.join(partition, "current.jsonl");
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  });

  afterAll(async () => {
    if (db) await closeDuckDB(db);
    fs.rmSync(partition, { recursive: true, force: true });
  });

  function seed(rows: SeedRow[]): void {
    fs.appendFileSync(
      path.join(partition, "current.jsonl"),
      rows.map(line).join(""),
      "utf-8",
    );
  }

  it("plain-list page and total are byte-identical to the fused statement (dups + tombstone + straddle)", async () => {
    seed(corpus1());
    const files = collectJsonlFiles([partition]);

    const shapes: Array<Parameters<typeof queryMemoriesWithTotal>[2]> = [
      { limit: 10 },
      { limit: 3 }, // the idC tombstone/add collapse straddles this boundary
      { limit: 2 },
      { limit: 2, offset: 1 },
      { key: "/p/a", limit: 10 },
      { author: "test@example.com", limit: 10 },
      { domain: "event", limit: 10 },
      { limit: 0 },
    ];

    for (const filters of shapes) {
      const bounded = await queryMemoriesWithTotal(db, [partition], filters);
      const fused = await queryMemoriesWithTotalFused(db, files, filters);
      expect(JSON.stringify(bounded.memories)).toBe(JSON.stringify(fused.memories));
      expect(bounded.total).toBe(fused.total);
    }
  });

  it("recovers rows cut off by a duplicate/tombstone collapse boundary via refill", async () => {
    seed(corpus2());
    const files = collectJsonlFiles([partition]);

    const bounded = await queryMemoriesWithTotal(db, [partition], { limit: 10 });
    const fused = await queryMemoriesWithTotalFused(db, files, { limit: 10 });

    // 6 live rows: the 60-dup id collapses to one, plus the 5 distinct ids.
    expect(bounded.memories).toHaveLength(6);
    expect(bounded.memories[0].id).toBe(fixtureId("dup"));
    expect(JSON.stringify(bounded.memories)).toBe(JSON.stringify(fused.memories));
    expect(bounded.total).toBe(6);
  });

  it("filtered/attribute/time-range requests keep the fused path verbatim", async () => {
    seed(corpus1());
    const files = collectJsonlFiles([partition]);

    const filteredShapes: Array<Parameters<typeof queryMemoriesWithTotal>[2]> = [
      { attr: { tag: "m2" }, limit: 10 },
      { after: "2026-09-03", before: "2026-09-05", limit: 10 },
      { after: "2026-09-01", limit: 10 },
    ];

    for (const filters of filteredShapes) {
      const viaPublic = await queryMemoriesWithTotal(db, [partition], filters);
      const fused = await queryMemoriesWithTotalFused(db, files, filters);
      expect(JSON.stringify(viaPublic.memories)).toBe(JSON.stringify(fused.memories));
      expect(viaPublic.total).toBe(fused.total);
    }
  });

  it("total equals a brute-force deduped live count", async () => {
    seed(corpus1());
    const files = collectJsonlFiles([partition]);
    const bounded = await queryMemoriesWithTotal(db, [partition], { limit: 10 });
    expect(bounded.total).toBe(bruteForceLiveCount(files));

    // Corpus 2 too (exercises the refill path's total).
    const f = path.join(partition, "current.jsonl");
    fs.rmSync(f, { force: true });
    seed(corpus2());
    const bounded2 = await queryMemoriesWithTotal(db, [partition], { limit: 10 });
    expect(bounded2.total).toBe(bruteForceLiveCount(collectJsonlFiles([partition])));
  });
});
