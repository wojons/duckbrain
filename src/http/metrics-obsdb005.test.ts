/**
 * OBSDB-005 — storage growth, ledger churn and recall usefulness on the scrape
 * surface.
 *
 * What is under test (`docs/observability-spec.md` §2 blind spots #7-#8, §3.2):
 *   1. `duckbrain_storage_namespaces_bytes` is the real footprint of the
 *      configured store — within 5 % of `du -sb` on the same tree — and
 *      `duckbrain_storage_embedding_cache_bytes` is the `.embeddings/` subset,
 *      so "will the disk fill?" and "can a rebuild reclaim this?" are numbers.
 *   2. The gauges are sampled AT COLLECT TIME (a scrape), not by a background
 *      timer: a file written after the first scrape appears in the next one,
 *      and a process with no declared store emits NO sample rather than a
 *      fabricated 0.
 *   3. `duckbrain_read_ledger_rotation_total` counts real seals of the 10 MB
 *      read ledger — and only seals (a ledger that never rotates stays 0).
 *   4. `duckbrain_recall_packs_total` / `..._nonempty_total` mirror the recall
 *      counter FILE, because the MCP server that appends events is a different
 *      process from the HTTP daemon: events appended after a scrape move the
 *      counters on the next scrape, and re-rendering without new events adds
 *      nothing (monotonic, idempotent).
 *
 * Hermetic: every path is a scratch temp directory; the health evaluator is a
 * stub, so no provider is probed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { createHttpMetrics } from "./metrics";
import {
  createReadLedgerStore,
  flushReadLedgerForTests,
  resetReadLedgerMetrics,
} from "./readLedger";
import {
  measureStorageUsage,
  createStorageSampler,
  isEmbeddingCachePath,
} from "../metrics/storage";
import {
  recallCounterFileFor,
  resetRecallMetrics,
  syncRecallPacksFromCounterFile,
  RECALL_PACKS_TOTAL,
  RECALL_PACKS_NONEMPTY_TOTAL,
} from "../metrics/recall";

const HEALTHY = {
  status: "healthy" as const,
  providers: [],
  durationsMs: { embedding: 0, keys: 0, total: 0 },
};

/** Read one sample value out of a Prometheus text exposition body. */
function sampleValue(text: string, name: string): number | null {
  const line = text
    .split("\n")
    .find((candidate) => candidate.startsWith(`${name} `));
  if (!line) return null;
  const value = Number(line.slice(line.lastIndexOf(" ") + 1));
  return Number.isFinite(value) ? value : null;
}

const scratchDirs: string[] = [];

function scratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function writeFile(file: string, bytes: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x61));
}

/** `du -sb <dir> | cut -f1` — the number the AC compares against. */
function duBytes(dir: string): number {
  return Number(execSync(`du -sb ${JSON.stringify(dir)} | cut -f1`).toString().trim());
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("OBSDB-005: storage measurement", () => {
  it("sums every regular file and separates the .embeddings subset", async () => {
    const root = scratchDir("duckbrain-obsdb005-store-");
    writeFile(path.join(root, "default", "memories.jsonl"), 1000);
    writeFile(path.join(root, "default", ".duckbrain-audit", "reads.jsonl"), 500);
    writeFile(path.join(root, "hermes", ".embeddings", "m1", "a.bin"), 700);
    writeFile(path.join(root, "hermes", ".embeddings", "m1", "b.bin"), 300);

    const usage = await measureStorageUsage(root);
    expect(usage.namespacesBytes).toBe(2500);
    expect(usage.embeddingCacheBytes).toBe(1000);
    expect(usage.files).toBe(4);

    // The cache gauge is a SUBSET of the total, never a separate population.
    expect(usage.embeddingCacheBytes).toBeLessThanOrEqual(usage.namespacesBytes);
    expect(isEmbeddingCachePath(root, path.join(root, "hermes", ".embeddings", "m1", "a.bin"))).toBe(true);
    expect(isEmbeddingCachePath(root, path.join(root, "default", "memories.jsonl"))).toBe(false);

    // The whole point of the gauge: it is the `du -sb` number (directory
    // entries add a few hundred bytes; the 5 % band is the row's own bound).
    const du = duBytes(root);
    expect(Math.abs(usage.namespacesBytes - du) / du).toBeLessThan(0.05);
  });

  it("does not follow symlinks (du does not either)", async () => {
    const outside = scratchDir("duckbrain-obsdb005-outside-");
    writeFile(path.join(outside, "big.bin"), 4096);
    const root = scratchDir("duckbrain-obsdb005-links-");
    writeFile(path.join(root, "real.bin"), 10);
    fs.symlinkSync(path.join(outside, "big.bin"), path.join(root, "link.bin"));

    const usage = await measureStorageUsage(root);
    expect(usage.namespacesBytes).toBe(10);
    expect(usage.files).toBe(1);
  });

  it("re-measures only after the TTL, never on a timer", async () => {
    let now = 1_000;
    let calls = 0;
    const sampler = createStorageSampler({
      namespacesPath: () => "/nonexistent",
      ttlMs: 60_000,
      now: () => now,
      measure: async () => {
        calls += 1;
        return { namespacesBytes: calls * 100, embeddingCacheBytes: 0, files: calls };
      },
    });

    expect((await sampler.read())?.namespacesBytes).toBe(100);
    expect((await sampler.read())?.namespacesBytes).toBe(100); // warm cache
    expect(calls).toBe(1);

    now += 60_001; // clock seam: the reuse window expired on its own
    expect((await sampler.read())?.namespacesBytes).toBe(200);
    expect(calls).toBe(2);
  });

  it("returns no measurement (not 0) when the walk cannot run", async () => {
    const sampler = createStorageSampler({
      namespacesPath: () => "/definitely/not/a/store",
      measure: async () => {
        throw new Error("EACCES");
      },
    });
    expect(await sampler.read()).toBeNull();
  });
});

describe("OBSDB-005: the gauges on /metrics", () => {
  beforeEach(() => {
    resetReadLedgerMetrics();
    resetRecallMetrics();
  });

  it("publishes the store footprint and the cache subset", async () => {
    const root = scratchDir("duckbrain-obsdb005-metrics-");
    writeFile(path.join(root, "default", "memories.jsonl"), 2048);
    writeFile(path.join(root, "default", ".embeddings", "m", "v.bin"), 512);

    const metrics = createHttpMetrics({
      evaluateHealth: async () => HEALTHY,
      namespacesPath: root,
    });
    const text = await metrics.render();

    expect(sampleValue(text, "duckbrain_storage_namespaces_bytes")).toBe(2560);
    expect(sampleValue(text, "duckbrain_storage_embedding_cache_bytes")).toBe(512);
    const du = duBytes(root);
    const gauge = sampleValue(text, "duckbrain_storage_namespaces_bytes") as number;
    expect(Math.abs(gauge - du) / du).toBeLessThan(0.05);
  });

  it("samples at collect time: a file written after one scrape shows in the next", async () => {
    const root = scratchDir("duckbrain-obsdb005-collect-");
    writeFile(path.join(root, "default", "a.jsonl"), 100);
    let now = 10_000;
    const metrics = createHttpMetrics({
      evaluateHealth: async () => HEALTHY,
      namespacesPath: root,
      now: () => now,
    });

    const first = sampleValue(await metrics.render(), "duckbrain_storage_namespaces_bytes");
    expect(first).toBe(100);

    writeFile(path.join(root, "default", "b.jsonl"), 900);
    now += 60_001; // past the reuse window — a scrape re-walks, no timer involved
    const second = sampleValue(await metrics.render(), "duckbrain_storage_namespaces_bytes");
    expect(second).toBe(1000);
  });

  it("emits NO storage sample when the app declared no store", async () => {
    const metrics = createHttpMetrics({ evaluateHealth: async () => HEALTHY });
    const text = await metrics.render();
    expect(text).not.toMatch(/^duckbrain_storage_namespaces_bytes /m);
    expect(text).not.toMatch(/^duckbrain_storage_embedding_cache_bytes /m);
  });

  it("counts real read-ledger seals and leaves a quiet ledger at zero", async () => {
    const root = scratchDir("duckbrain-obsdb005-ledger-");
    const metrics = createHttpMetrics({
      evaluateHealth: async () => HEALTHY,
      namespacesPath: root,
    });

    // A roomy bound: nothing rotates, the counter stays 0.
    const quiet = createReadLedgerStore(root, { maxBytes: 1_000_000 });
    await quiet.append({ ts: new Date().toISOString(), route: "GET /api/memories", method: "GET", ns: null, status: 200, dur_ms: 3 });
    await flushReadLedgerForTests();
    expect(sampleValue(await metrics.render(), "duckbrain_read_ledger_rotation_total")).toBe(0);

    // A tight bound: the next rows seal the segment and the counter moves.
    const tight = createReadLedgerStore(root, { maxBytes: 200 });
    for (let i = 0; i < 3; i++) {
      await tight.append({ ts: new Date().toISOString(), route: "GET /api/memories", method: "GET", ns: null, status: 200, dur_ms: 3 });
    }
    await flushReadLedgerForTests();
    const rotations = sampleValue(await metrics.render(), "duckbrain_read_ledger_rotation_total");
    expect(rotations).toBeGreaterThanOrEqual(1);
    const sealed = fs
      .readdirSync(path.join(root, ".duckbrain-audit"))
      .filter((name) => /^reads\.\d{4,}\.jsonl$/.test(name));
    expect(sealed.length).toBe(rotations);
  });
});

describe("OBSDB-005: recall usefulness counters", () => {
  beforeEach(() => {
    resetRecallMetrics();
  });

  function event(recordsReturned: number): string {
    const ts = new Date().toISOString();
    return `${JSON.stringify({
      ts,
      day: ts.slice(0, 10),
      namespaces: ["default"],
      calls: 1,
      callsAnswered: 1,
      nonEmptyPacks: recordsReturned > 0 ? 1 : 0,
      recordsReturned,
    })}\n`;
  }

  it("mirrors the counter file another process appends to, idempotently", async () => {
    const root = scratchDir("duckbrain-obsdb005-recall-");
    const counterFile = recallCounterFileFor(root);
    fs.mkdirSync(path.dirname(counterFile), { recursive: true });
    fs.writeFileSync(counterFile, event(3) + event(0));

    const metrics = createHttpMetrics({
      evaluateHealth: async () => HEALTHY,
      namespacesPath: root,
      recallCounterFile: counterFile,
    });

    const first = await metrics.render();
    expect(sampleValue(first, RECALL_PACKS_TOTAL)).toBe(2);
    expect(sampleValue(first, RECALL_PACKS_NONEMPTY_TOTAL)).toBe(1);

    // A second scrape with no new events must not double-count.
    const second = await metrics.render();
    expect(sampleValue(second, RECALL_PACKS_TOTAL)).toBe(2);
    expect(sampleValue(second, RECALL_PACKS_NONEMPTY_TOTAL)).toBe(1);

    // The MCP process appends one more recalled pack: the next scrape sees it
    // WITHOUT any in-process call to recordRecallMetric.
    fs.appendFileSync(counterFile, event(5));
    const third = await metrics.render();
    expect(sampleValue(third, RECALL_PACKS_TOTAL)).toBe(3);
    expect(sampleValue(third, RECALL_PACKS_NONEMPTY_TOTAL)).toBe(2);
  });

  it("leaves a partial trailing line for the next scrape instead of mis-counting it", () => {
    const root = scratchDir("duckbrain-obsdb005-recall-partial-");
    const counterFile = recallCounterFileFor(root);
    fs.mkdirSync(path.dirname(counterFile), { recursive: true });
    fs.writeFileSync(counterFile, event(2));

    expect(syncRecallPacksFromCounterFile(counterFile).packs).toBe(1);

    // A half-written row (the append is not atomic at the line level).
    fs.appendFileSync(counterFile, event(1).slice(0, 20));
    expect(syncRecallPacksFromCounterFile(counterFile).packs).toBe(1);

    fs.appendFileSync(counterFile, `${event(1).slice(20)}`);
    expect(syncRecallPacksFromCounterFile(counterFile).packs).toBe(2);
  });

  it("keeps totals monotonic when the counter file is truncated", () => {
    const root = scratchDir("duckbrain-obsdb005-recall-truncate-");
    const counterFile = recallCounterFileFor(root);
    fs.mkdirSync(path.dirname(counterFile), { recursive: true });
    fs.writeFileSync(counterFile, event(4) + event(4));
    expect(syncRecallPacksFromCounterFile(counterFile).packs).toBe(2);

    fs.writeFileSync(counterFile, ""); // rotated/truncated under us
    const after = syncRecallPacksFromCounterFile(counterFile);
    expect(after.packs).toBe(2); // a counter never goes down
  });
});
