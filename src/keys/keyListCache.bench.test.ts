/**
 * PERF-001 benchmark (brief AC#1): warm list_keys must be >=10x faster than
 * the cold full scan on a synthetic namespace with >=20,000 records and
 * >=5MB, and both outputs must be DEEP-EQUAL.
 *
 * Runs as a vitest test under CI-representative conditions (same harness,
 * same limits as the rest of the suite). The corpus is written directly to
 * partition JSONLs (bulk-ingest shape; the per-call write path is covered by
 * the unit/integration suites). Timings are printed for the report.
 *
 *   cold       — DUCKBRAIN_KEYS_CACHE=off: the SQL path (read_json GROUP BY)
 *   warm-build — cache on, first call (rebuild; expected ~ cold)
 *   warm       — cache on, second call (serves the artifact; the AC target)
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { listKeysTool } from "../mcp/tools/list_keys";
import { keysCacheDir } from "./keyListCache";

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const NS = "perf001-bench";
const nsPath = path.join(NS_ROOT, NS);

const RECORDS = 50_000; // > 20,000 (brief minimum)
const PARTITIONS = ["concept/2026-08", "concept/2026-09"];

function buildCorpus(): { bytes: number; keys: string[] } {
  fs.rmSync(nsPath, { recursive: true, force: true });
  fs.mkdirSync(nsPath, { recursive: true });
  const keys: string[] = [];
  let bytes = 0;
  const perPartition = Math.floor(RECORDS / PARTITIONS.length);
  PARTITIONS.forEach((rel, p) => {
    const dir = path.join(nsPath, rel);
    fs.mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < perPartition; i++) {
      const n = p * perPartition + i;
      const key = `/bench/p${String(n % 500).padStart(3, "0")}/item/${String(n).padStart(6, "0")}`;
      keys.push(key);
      // A handful of tombstone rows — filtered by BOTH paths (parity).
      const action = n % 5000 === 4242 ? "tombstone" : "add";
      const rec = {
        id: crypto.randomUUID(),
        key,
        domain: "concept",
        timestamp: new Date(
          Date.UTC(2026, 7 + p, 1 + (i % 28), i % 24, i % 60, i % 60, i % 1000),
        ).toISOString(),
        author: "bench@duckbrain",
        action,
        embedding_text:
          "benchmark payload with a realistic embedding_text body ~100 chars " +
          crypto.randomUUID(),
        attributes: { n, partition: p },
      };
      lines.push(JSON.stringify(rec));
    }
    // One torn line for the resilient-read parity (DB-GAP-035).
    lines.splice(3, 0, `{"id":"66db7ec5-d847-4f23-864a${lines[0]}`);
    const content = lines.join("\n") + "\n";
    bytes += Buffer.byteLength(content);
    fs.writeFileSync(path.join(dir, "current.jsonl"), content, "utf-8");
  });
  fs.writeFileSync(
    path.join(nsPath, "manifest.json"),
    JSON.stringify({ partitions: PARTITIONS }),
    "utf-8",
  );
  return { bytes, keys };
}

async function listWithCache(
  input: Record<string, unknown>,
  cache: "on" | "off",
) {
  const prev = process.env.DUCKBRAIN_KEYS_CACHE;
  process.env.DUCKBRAIN_KEYS_CACHE = cache;
  try {
    const t0 = performance.now();
    const result = await listKeysTool({ namespace: NS, ...input });
    const ms = performance.now() - t0;
    expect(result.error).toBeUndefined();
    return { result, ms };
  } finally {
    if (prev === undefined) delete process.env.DUCKBRAIN_KEYS_CACHE;
    else process.env.DUCKBRAIN_KEYS_CACHE = prev;
  }
}

describe("PERF-001 benchmark: warm >= 10x vs cold, deep-equal outputs", () => {
  it("meets the brief's AC#1 on a 50k-record corpus", async () => {
    const { bytes } = buildCorpus();
    expect(RECORDS).toBeGreaterThanOrEqual(20_000);
    expect(bytes).toBeGreaterThanOrEqual(5 * 1024 * 1024);

    const queries = [
      { prefix: "/", maxDepth: 3, limit: 50, offset: 0 },
      { prefix: "/", maxDepth: 3, limit: 50, offset: 50 },
      { prefix: "/bench/p007/", maxDepth: 3, limit: 50, offset: 0 },
      { prefix: "/", maxDepth: 1, limit: 50, offset: 0 },
    ];

    // COLD: SQL path on every query.
    const cold: { ms: number; result: unknown }[] = [];
    for (const q of queries) {
      const { result, ms } = await listWithCache(q, "off");
      cold.push({ ms, result });
    }
    const coldTotal = cold.reduce((s, c) => s + c.ms, 0);

    // WARM-BUILD: first cache-on call (includes the rebuild).
    const warmBuild = await listWithCache(queries[0], "on");
    expect(fs.existsSync(path.join(keysCacheDir(nsPath), "meta.json"))).toBe(
      true,
    );

    // WARM: artifact-served calls.
    const warm: { ms: number; result: unknown }[] = [];
    for (const q of queries) {
      const { result, ms } = await listWithCache(q, "on");
      warm.push({ ms, result });
    }
    const warmTotal = warm.reduce((s, c) => s + c.ms, 0);

    // DEEP-EQUAL: every warm answer identical to its cold answer.
    for (let i = 0; i < queries.length; i++) {
      expect(warm[i].result).toEqual(cold[i].result);
    }

    const speedup = coldTotal / warmTotal;
    console.log(
      `[PERF-001] corpus=${(bytes / 1024 / 1024).toFixed(1)}MB records=${RECORDS} ` +
        `cold_total=${coldTotal.toFixed(1)}ms (per-query ${cold
          .map((c) => c.ms.toFixed(1))
          .join("/")}) ` +
        `warm_build=${warmBuild.ms.toFixed(1)}ms ` +
        `warm_total=${warmTotal.toFixed(1)}ms (per-query ${warm
          .map((w) => w.ms.toFixed(1))
          .join("/")}) ` +
        `speedup=${speedup.toFixed(1)}x`,
    );
    expect(speedup).toBeGreaterThanOrEqual(10);
  }, 60_000);
});
