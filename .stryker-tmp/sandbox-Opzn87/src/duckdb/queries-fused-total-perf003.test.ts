/**
 * PERF-003 Regression Tests: the fused recall count leg.
 *
 * Guards the combined queryMemoriesWithTotal API in src/duckdb/queries.ts
 * and its use by the recall list path (src/mcp/tools/recall.ts):
 *   - rows AND total are BYTE-IDENTICAL to the old two-scan path
 *     (queryMemories + countMemories) across every filter shape;
 *   - the total is the DEDUPED match count (GAP-024 semantics), NOT the raw
 *     scan count — the foreman measured 246,075 raw vs the correct deduped
 *     total on the live namespace, so the test pins a corpus where the two
 *     diverge (duplicate ids + tombstones) and asserts the deduped number;
 *   - an offset beyond the end (empty page) still carries the row-level
 *     __total;
 *   - the fused SQL contains exactly ONE read_json mount (the old path
 *     mounted every chunk file twice per request);
 *   - the recall tool actually calls the combined API (no silent regression
 *     back to the two-scan pair).
 */
// @ts-nocheck


import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDuckDB, closeDuckDB } from "./connection";
import {
  insertMemory,
  queryMemories,
  countMemories,
  queryMemoriesWithTotal,
  collectJsonlFiles,
} from "./queries";
import type { MemoryType } from "../schema/memory";
import path from "path";
import os from "os";
import fs from "fs";

const RECALL_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "..", "mcp", "tools", "recall.ts"),
  "utf-8",
);
const QUERIES_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "queries.ts"),
  "utf-8",
);

function fixtureId(label: string): string {
  const suffix = Buffer.from(label)
    .toString("hex")
    .padEnd(12, "0")
    .slice(0, 12);
  return `00000000-0000-4000-8000-${suffix}`;
}

function memory(
  id: string,
  key: string,
  timestamp: string,
  action: "add" | "update" | "tombstone" = "add",
): MemoryType {
  return {
    id: fixtureId(id),
    key,
    domain: "message",
    timestamp,
    author: "test@example.com",
    action,
    embedding_text: `Record ${id}`,
    attributes: { fixture_id: id },
  };
}

/** The PERF-003 corpus: duplicate ids (update chains), a tombstone, gaps. */
function perf003Corpus(): MemoryType[] {
  return [
    memory("m1", "/p/one", "2026-09-01T10:00:00.000Z"),
    memory("m1", "/p/one", "2026-09-01T11:00:00.000Z", "update"),
    memory("m2", "/p/two", "2026-09-02T10:00:00.000Z"),
    memory("m3", "/p/three", "2026-09-03T10:00:00.000Z"),
    memory("m3", "/p/three", "2026-09-03T11:00:00.000Z", "update"),
    memory("m4", "/p/gone", "2026-09-04T10:00:00.000Z"),
    memory("m4", "/p/gone", "2026-09-04T11:00:00.000Z", "tombstone"),
  ];
}

describe("PERF-003: fused recall count leg (queryMemoriesWithTotal)", () => {
  let db: any;
  const testPartition = fs.mkdtempSync(
    path.join(os.tmpdir(), "test-memory-perf003-"),
  );

  beforeEach(async () => {
    db = await initDuckDB(":memory:");
    if (fs.existsSync(testPartition)) {
      fs.rmSync(testPartition, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    if (db) {
      await closeDuckDB(db);
    }
    if (fs.existsSync(testPartition)) {
      fs.rmSync(testPartition, { recursive: true, force: true });
    }
  });

  async function seed(records: MemoryType[]): Promise<void> {
    for (const r of records) await insertMemory(db, r, testPartition);
  }

  it("returns rows AND total byte-identical to the old two-scan path", async () => {
    await seed(perf003Corpus());

    // Every filter shape the recall list path can build (no semantic leg —
    // that path does not use the fused API).
    const filterShapes: Parameters<typeof queryMemoriesWithTotal>[2][] = [
      { limit: 10 },
      { limit: 2 },
      { limit: 2, offset: 1 },
      { key: "/p/one", limit: 10 },
      { keyPrefix: "/p/", limit: 10 },
      { author: "test@example.com", limit: 10 },
      { after: "2026-09-02", before: "2026-09-03", limit: 10 },
      { attr: { fixture_id: "m2" }, limit: 10 },
      { historical: true, limit: 10 },
      { limit: 0 },
    ];

    for (const filters of filterShapes) {
      const fused = await queryMemoriesWithTotal(db, [testPartition], filters);
      const oldRows = await queryMemories(db, [testPartition], filters);
      const oldTotal = await countMemories(db, [testPartition], filters);

      // Byte-identical rows: same order, same ids, same shape.
      expect(JSON.stringify(fused.memories)).toBe(JSON.stringify(oldRows));
      // Identical GAP-024 total.
      expect(fused.total).toBe(oldTotal);
    }
  });

  it("reports the DEDUPED match count, not the raw scan count", async () => {
    await seed(perf003Corpus());
    // 7 written records; dedup collapses m1 and m3 update chains and the
    // m4 tombstone removes its memory: 3 live memories vs 7 raw rows.
    expect(await countMemories(db, [testPartition])).toBe(3);

    const fused = await queryMemoriesWithTotal(db, [testPartition], {
      limit: 2,
    });
    expect(fused.total).toBe(3);

    // The divergence the trap warned about: the raw scan count is NOT the
    // total. Mount the same files the fused query mounts and count raw.
    const files = collectJsonlFiles([testPartition]);
    expect(files.length).toBeGreaterThan(0);
    const fileList = files.map((f) => `'${f}'`).join(", ");
    const raw = await new Promise<number>((resolve, reject) => {
      db.all(
        `SELECT COUNT(*) AS n FROM read_json([${fileList}], format='newline_delimited', ignore_errors=true, columns={id:'VARCHAR', key:'VARCHAR', domain:'VARCHAR', timestamp:'VARCHAR', valid_from:'VARCHAR', valid_until:'VARCHAR', author:'VARCHAR', action:'VARCHAR', embedding_text:'VARCHAR', attributes:'VARCHAR'})`,
        (err: any, result: any) =>
          err ? reject(err) : resolve(Number(result?.[0]?.n ?? 0)),
      );
    });
    expect(raw).toBe(7);
    expect(fused.total).not.toBe(raw);
  });

  it("carries the total on an EMPTY page (offset beyond the end)", async () => {
    await seed(perf003Corpus());

    // Offset 10 with limit 2: no rows match the window, total still 3.
    const beyond = await queryMemoriesWithTotal(db, [testPartition], {
      limit: 2,
      offset: 10,
    });
    expect(beyond.memories).toEqual([]);
    expect(beyond.total).toBe(3);

    // Empty namespace shape (no match at all): empty page, total 0.
    const none = await queryMemoriesWithTotal(db, [testPartition], {
      key: "/p/none",
      limit: 5,
    });
    expect(none.memories).toEqual([]);
    expect(none.total).toBe(0);

    // Pagination arithmetic: page1 + page2 reconstruct the full set.
    const page1 = await queryMemoriesWithTotal(db, [testPartition], {
      limit: 2,
      offset: 0,
    });
    const page2 = await queryMemoriesWithTotal(db, [testPartition], {
      limit: 2,
      offset: 2,
    });
    expect(page1.memories.length + page2.memories.length).toBe(page1.total);
    expect(page1.total).toBe(3);
  });

  it("returns an empty result for empty partitions without scanning", async () => {
    expect(await queryMemoriesWithTotal(db, [], { limit: 5 })).toEqual({
      memories: [],
      total: 0,
    });
    expect(
      await queryMemoriesWithTotal(db, [testPartition], { limit: 5 }),
    ).toEqual({ memories: [], total: 0 });
  });

  it("mounts the chunk files with exactly ONE read_json in the fused SQL", () => {
    // Extract the fused function's body and count its read_json mounts: the
    // count leg must read the MATERIALIZED dedup set, never re-mount files.
    const fnStart = QUERIES_SOURCE.indexOf(
      "export async function queryMemoriesWithTotal",
    );
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = QUERIES_SOURCE.slice(
      fnStart,
      QUERIES_SOURCE.indexOf("export async function insertMemory", fnStart),
    );
    expect(fnBody).toContain("MATERIALIZED");
    expect(fnBody.split("read_json(").length - 1).toBe(1);
  });

  it("recall list path uses the combined API (no two-scan pair)", () => {
    // The hot path must call queryMemoriesWithTotal; the only remaining
    // countMemories call in recall.ts is the limit=0 count-only branch
    // (a single-scan request by definition).
    expect(RECALL_SOURCE).toContain("queryMemoriesWithTotal(");
    const hotPath = RECALL_SOURCE.slice(
      RECALL_SOURCE.indexOf("Execute query — retry once on connection-lost"),
    );
    expect(hotPath).toContain("queryMemoriesWithTotal(");
    expect(hotPath).not.toContain("countMemories(");
  });
});
