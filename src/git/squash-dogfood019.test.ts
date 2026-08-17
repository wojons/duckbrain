/**
 * DOGFOOD-019 P0 Regression Tests: git squash over partitions whose JSONL
 * contains duplicate keys inside `attributes` must NEVER abort the process.
 *
 * Root cause: src/git/squash.ts ran
 *   CREATE TEMP TABLE records AS SELECT * FROM read_json_auto('...')
 * with schema auto-inference. Auto-inference types a heterogeneous
 * `attributes` object as MAP(...); when a record's JSON object then contains
 * duplicate keys (valid per RFC 8259, produced by external writers — JSON.parse
 * in-process silently collapses them), MAP conversion fails with
 * `duckdb::InvalidInputException: Map keys must be unique.` thrown from native
 * code. node-duckdb's RunPreparedTask::DoWork() (the db.all() path) has NO
 * try/catch around Execute(), so the C++ throw escapes the libuv worker thread
 * → std::terminate → SIGABRT → the whole process dies. A JS try/catch cannot
 * intercept it (probe on unfixed code: `terminate called after throwing an
 * instance of 'duckdb::InvalidInputException'`, exit 134). Same crash class as
 * DOGFOOD-010 (queries.ts ?q= path, commit 471f3de) and DOGFOOD-018
 * (activity.ts, commit d921515).
 *
 * Fix (mirrors DOGFOOD-010/018 exactly): read_json with an explicit all-VARCHAR
 * column schema (attributes arrives as raw JSON text, never MAP) +
 * ignore_errors=true, with the READ_JSON_COLUMNS constant shared from
 * src/duckdb/queries.ts. This is the git-squash admin path (squashPartition →
 * MCP squash tool / compaction routes).
 *
 * The tests call squashPartition directly on scratch partitions under a temp
 * dir — no HTTP server, no DUCKBRAIN_NAMESPACES_PATH needed (squash takes an
 * absolute partition path and finds the manifest by walking up). The
 * "process survives" assertion is implicit and strict: on the unfixed code the
 * first poisoned-partition squash SIGABRTs the whole vitest worker — the suite
 * dies mid-file, which IS the failing assertion. On fixed code, the parquet
 * read-back AFTER the squash additionally proves the DuckDB layer is still
 * serving.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { squashPartition } from "./squash";
import { getDuckDBConnection } from "../duckdb/connection";

let scratchDir: string;

/**
 * Build a partition whose JSONL would crash the unfixed reader (same data
 * shape as memories-dogfood010.test.ts / activity-dogfood018.test.ts):
 *  - attributes objects with 220 DISTINCT keys across the file (DuckDB's
 *    map_inference_threshold default) — forces auto-inference to type the
 *    column MAP(VARCHAR, VARCHAR) instead of a nullable STRUCT
 *  - one row whose `attributes` object contains DUPLICATE keys — written raw
 *    to the file, because JSON.stringify of a JS object can't express them
 *    (that is exactly how real-world external writers produced them)
 *  - a tombstone row to exercise the `action NOT IN ('tombstone', 'forget')`
 *    filter in the COPY
 *
 * Returns the JS-side expected counts (recordsKept / recordsRemoved), which is
 * what the parquet must contain after the DuckDB-side filter.
 */
function buildPoisonedPartition(
  nsDir: string,
  partitionRel: string,
): { expectedKept: number; expectedRemoved: number } {
  const partitionPath = path.join(nsDir, partitionRel);
  fs.mkdirSync(partitionPath, { recursive: true });
  fs.writeFileSync(
    path.join(nsDir, "manifest.json"),
    JSON.stringify({
      version: "1.0",
      createdAt: "2026-08-17T00:00:00.000Z",
      partitions: [partitionRel],
      lastUpdated: "2026-08-17T00:00:00.000Z",
    }),
    "utf-8",
  );

  // 220 distinct attribute keys (>= map_inference_threshold 200) with
  // string values, so detection infers MAP(VARCHAR, VARCHAR).
  const KEYS = Array.from({ length: 220 }, (_, i) => `key_${i}`);
  const attrsFor = (i: number): string => {
    const start = (i * 7) % 200;
    const picked = KEYS.slice(start, start + 10);
    return `{${picked.map((k, j) => `"${k}":"v${(i + j) % 97}"`).join(",")}}`;
  };
  // The trigger: duplicate "key_0" inside one attributes object.
  const DUP_ATTRS = '{"key_0":"confirmed","key_1":"high","key_0":"dup-key"}';

  const row = (
    idx: number,
    id: string,
    key: string,
    action: string,
    text: string,
    attrs: string,
  ) =>
    JSON.stringify({
      id,
      key,
      domain: "raw_note",
      timestamp: `2026-08-${String((idx % 9) + 1).padStart(2, "0")}T12:00:00.000Z`,
      author: "dogfood@test.local",
      action,
      embedding_text: text,
    }).slice(0, -1) + `,"attributes":${attrs}}\n`;

  let out = "";
  for (let i = 0; i < 300; i++) {
    out += row(
      i,
      `d${i}`,
      `/alpha/mem/${i}`,
      "add",
      `alpha memory number ${i}`,
      attrsFor(i),
    );
  }
  // Dup-key row (MAP already inferred across the file) + a normal sentinel.
  out += row(301, "dup1", "/alpha/dup", "add", "alpha dup row", DUP_ATTRS);
  out += row(
    302,
    "sentinel1",
    "/alpha/sentinel",
    "add",
    "alpha sentinel row",
    attrsFor(42),
  );
  // Tombstone row — must be filtered out of the parquet.
  out += row(
    303,
    "t1",
    "/beta/tomb",
    "tombstone",
    "beta tombstone target",
    '{"tombstone_reason":"test"}',
  );
  fs.writeFileSync(path.join(partitionPath, "current.jsonl"), out, "utf-8");

  // JS-side counts (what squashPartition reports): the dup-key row parses
  // fine via JSON.parse (last key wins), only the tombstone is removed.
  return { expectedKept: 302, expectedRemoved: 1 };
}

/**
 * Build a normal partition (few attribute keys, no duplicates) — the plain
 * regression case that must keep working.
 */
function buildNormalPartition(
  nsDir: string,
  partitionRel: string,
): { expectedKept: number; expectedRemoved: number } {
  const partitionPath = path.join(nsDir, partitionRel);
  fs.mkdirSync(partitionPath, { recursive: true });
  fs.writeFileSync(
    path.join(nsDir, "manifest.json"),
    JSON.stringify({
      version: "1.0",
      createdAt: "2026-08-17T00:00:00.000Z",
      partitions: [partitionRel],
      lastUpdated: "2026-08-17T00:00:00.000Z",
    }),
    "utf-8",
  );

  let out = "";
  for (let i = 0; i < 10; i++) {
    out +=
      JSON.stringify({
        id: `n${i}`,
        key: `/normal/mem/${i}`,
        domain: "concept",
        timestamp: `2026-08-${String((i % 9) + 1).padStart(2, "0")}T12:00:00.000Z`,
        author: "dogfood@test.local",
        action: "add",
        embedding_text: `normal memory ${i}`,
      }).slice(0, -1) + `,"attributes":{"tick":${i},"kind":"normal"}}\n`;
  }
  out +=
    JSON.stringify({
      id: "n-tomb",
      key: "/normal/tomb",
      domain: "event",
      timestamp: "2026-08-16T12:00:00.000Z",
      author: "dogfood@test.local",
      action: "tombstone",
      embedding_text: "normal tombstone",
    }).slice(0, -1) + ',"attributes":{"tombstone_reason":"test"}}\n';
  fs.writeFileSync(path.join(partitionPath, "current.jsonl"), out, "utf-8");

  return { expectedKept: 10, expectedRemoved: 1 };
}

function parquetRows(parquetPath: string): Promise<any[]> {
  const db = getDuckDBConnection("singleton", path.dirname(parquetPath));
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, key, action, attributes FROM read_parquet('${parquetPath.replace(/\\/g, "/")}')`,
      (err: any, rows: any[]) => {
        if (err) reject(err);
        else resolve(rows || []);
      },
    );
  });
}

describe("DOGFOOD-019: git squash survives duplicate-key attributes (no abort)", () => {
  beforeAll(() => {
    scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-dogfood019-"),
    );
  });

  afterAll(() => {
    if (scratchDir) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("squash of a duplicate-key partition completes, filters tombstones, and the process survives", async () => {
    const nsDir = path.join(scratchDir, "poisoned");
    const partitionRel = "raw_note/2026-06";
    const partitionPath = path.join(nsDir, partitionRel);
    const { expectedKept, expectedRemoved } = buildPoisonedPartition(
      nsDir,
      partitionRel,
    );

    const result = await squashPartition(partitionPath, {
      dryRun: false,
      squashCommits: false,
    });

    // Reaching this point means the process did NOT abort — on the unfixed
    // code the read_json_auto MAP conversion SIGABRTs the whole vitest
    // worker mid-call (exit 134, `terminate called after throwing an
    // instance of 'duckdb::InvalidInputException'`).
    expect(result.success).toBe(true);
    if (!result.success) return; // guard for TS narrowing below
    expect(result.recordsKept).toBe(expectedKept);
    expect(result.recordsRemoved).toBe(expectedRemoved);
    expect(result.error).toBeUndefined();

    // Squash completed: parquet written, JSONL sources removed.
    expect(result.parquetPath).toBeDefined();
    expect(fs.existsSync(result.parquetPath as string)).toBe(true);
    expect(fs.existsSync(path.join(partitionPath, "current.jsonl"))).toBe(
      false,
    );

    // The parquet read-back is itself a fresh DuckDB query AFTER the squash —
    // explicit proof the native layer is still alive and serving.
    const rows = await parquetRows(result.parquetPath as string);
    expect(rows.length).toBe(expectedKept);

    // The duplicate-key row survived; its attributes are RAW JSON TEXT in the
    // all-VARCHAR parquet column (duplicate keys preserved, never a MAP).
    const dup = rows.find((r: any) => r.id === "dup1");
    expect(dup).toBeDefined();
    expect(dup.key ?? "").toBe("/alpha/dup");
    expect(dup.attributes).toContain("dup-key");

    // Tombstone row filtered out by the COPY's action filter.
    expect(rows.find((r: any) => r.id === "t1")).toBeUndefined();

    // A normal row keeps its attributes too (attrsFor(42) → keys 94..103).
    const normal = rows.find((r: any) => r.id === "sentinel1");
    expect(normal).toBeDefined();
    expect(normal.attributes).toContain("key_94");
  });

  it("squash of a normal partition still works", async () => {
    const nsDir = path.join(scratchDir, "normal");
    const partitionRel = "concept/2026-07";
    const partitionPath = path.join(nsDir, partitionRel);
    const { expectedKept, expectedRemoved } = buildNormalPartition(
      nsDir,
      partitionRel,
    );

    const result = await squashPartition(partitionPath, {
      dryRun: false,
      squashCommits: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.recordsKept).toBe(expectedKept);
    expect(result.recordsRemoved).toBe(expectedRemoved);
    expect(fs.existsSync(result.parquetPath as string)).toBe(true);

    const rows = await parquetRows(result.parquetPath as string);
    expect(rows.length).toBe(expectedKept);
    expect(rows.find((r: any) => r.id === "n-tomb")).toBeUndefined();
  });

  it("dryRun over a duplicate-key partition returns counts without touching DuckDB or files", async () => {
    const nsDir = path.join(scratchDir, "poisoned-dryrun");
    const partitionRel = "raw_note/2026-06";
    const partitionPath = path.join(nsDir, partitionRel);
    const { expectedKept, expectedRemoved } = buildPoisonedPartition(
      nsDir,
      partitionRel,
    );

    const result = await squashPartition(partitionPath, {
      dryRun: true,
      squashCommits: false,
    });

    expect(result.success).toBe(true);
    expect(result.recordsKept).toBe(expectedKept);
    expect(result.recordsRemoved).toBe(expectedRemoved);
    expect(result.parquetPath).toBeUndefined();

    // dryRun must not modify anything: JSONL still present, no parquet.
    expect(fs.existsSync(path.join(partitionPath, "current.jsonl"))).toBe(true);
    expect(
      fs.readdirSync(partitionPath).some((f: string) => f.endsWith(".parquet")),
    ).toBe(false);
  });
});
