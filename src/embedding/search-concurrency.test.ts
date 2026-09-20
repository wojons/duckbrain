/**
 * OPS-008: on-the-fly cache-miss embedding must be CONCURRENT and BOUNDED.
 *
 * `semanticSearch` used to walk candidates in a serial `for` loop and embed
 * each cache miss one text at a time, so a cold-cache slice cost
 * `misses × provider RTT`. Measured live against a healthy remote embedder
 * (2.3-7.6s per call, qwen3-embedding-8b) that is the 28-40s band OPS-008
 * recorded — well past SEMANTIC_TIMEOUT_MS (30s).
 *
 * These tests pin the pooled behavior:
 *  - in-flight provider calls rise ABOVE 1 and never exceed the concurrency,
 *  - the maxOnTheFlyEmbeds cap still holds exactly, and counts cache MISSES,
 *  - a rejecting embed does not sink the batch or abort its siblings,
 *  - `cachedOnly` performs ZERO provider calls,
 *  - warm-cache ranking is unchanged (scores + order),
 *  - pooled wall time tracks ceil(misses / concurrency) × RTT, not misses × RTT.
 *
 * Hermetic: a fake provider, a temp-dir cache, no network, no ports.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EmbeddingCache } from "./cache";
import { semanticSearch, type SearchCandidate } from "./search";

let tmpDir: string;
let cache: EmbeddingCache;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-search-conc-"));
  cache = new EmbeddingCache(path.join(tmpDir, ".embeddings"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const Q = [1, 0, 0, 0];

function fakeVec(seed: number, dims = 4): number[] {
  const v: number[] = [];
  for (let d = 0; d < dims; d++) v.push(((seed * 13 + d * 7) % 100) / 100);
  return v;
}

function candidate(id: string, text: string): SearchCandidate {
  return {
    id,
    key: `/k/${id}`,
    domain: "concept",
    timestamp: "2026-08-01T00:00:00Z",
    author: "test@example.com",
    action: "add",
    embedding_text: text,
    attributes: {},
  };
}

function candidateSet(n: number): SearchCandidate[] {
  return Array.from({ length: n }, (_, i) => candidate(`c${i}`, `text-${i}`));
}

/**
 * A provider that records call timestamps and how many calls were in flight
 * at once — the only honest way to observe concurrency (wall time alone cannot
 * distinguish "pooled" from "fast provider").
 */
function trackingProvider(opts: { latencyMs?: number; failOn?: string } = {}) {
  const latency = opts.latencyMs ?? 0;
  const state = {
    inFlight: 0,
    maxInFlight: 0,
    calls: [] as string[],
    /** [startedAt, finishedAt] per call, aligned with `calls` */
    windows: [] as Array<[number, number]>,
  };
  const provider = {
    id: "m",
    model: "t",
    dimensions: 4,
    async embed(text: string): Promise<number[]> {
      const startedAt = Date.now();
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      state.calls.push(text);
      const window: [number, number] = [startedAt, startedAt];
      state.windows.push(window);
      try {
        if (latency > 0) {
          await new Promise((resolve) => setTimeout(resolve, latency));
        }
        if (opts.failOn !== undefined && text === opts.failOn) {
          throw new Error(`embed failed for ${text}`);
        }
        return fakeVec(text.length);
      } finally {
        window[1] = Date.now();
        state.inFlight--;
      }
    },
  };
  return { provider, state };
}

describe("semanticSearch on-the-fly concurrency (OPS-008)", () => {
  it("embeds cache misses concurrently: max in-flight > 1 and <= concurrency", async () => {
    const K = 8;
    const C = 4;
    const { provider, state } = trackingProvider({ latencyMs: 25 });
    const cands = candidateSet(K);

    const ranked = await semanticSearch(cands, Q, cache, provider, {
      minScore: 0,
      embedConcurrency: C,
    });

    // Every miss was embedded, every miss was ranked.
    expect(state.calls.length).toBe(K);
    expect(ranked.length).toBe(K);
    // The defect: serial code had exactly one call in flight at a time.
    expect(state.maxInFlight).toBeGreaterThan(1);
    // The bound: never more than the caller asked for.
    expect(state.maxInFlight).toBeLessThanOrEqual(C);
  });

  it("honors embedConcurrency exactly (no more in flight than configured)", async () => {
    const C = 2;
    const { provider, state } = trackingProvider({ latencyMs: 20 });
    await semanticSearch(candidateSet(6), Q, cache, provider, {
      minScore: 0,
      embedConcurrency: C,
    });
    expect(state.maxInFlight).toBeLessThanOrEqual(C);
    expect(state.maxInFlight).toBeGreaterThan(1);
  });

  it("dedupes repeated embedding_text: one request, both candidates ranked", async () => {
    // Two memories can carry identical embedding_text. The serial loop issued
    // one request for the first and found the second in the cache it had just
    // written; the pool must not turn that into two concurrent requests for
    // the same text. Ranked output is unchanged either way.
    const cands = [
      candidate("dup-a", "identical body"),
      candidate("dup-b", "identical body"),
      candidate("other", "different body"),
    ];
    const { provider, state } = trackingProvider();
    const ranked = await semanticSearch(cands, Q, cache, provider, {
      minScore: 0,
      embedConcurrency: 4,
    });

    expect(state.calls.sort()).toEqual(["different body", "identical body"]);
    expect(state.calls.length).toBe(2);
    expect(ranked.map((r) => r.id).sort()).toEqual(["dup-a", "dup-b", "other"]);
  });

  it("clamps a non-positive concurrency to serial instead of embedding nothing", async () => {
    // Mirrors rebuild.ts's `Math.max(1, opts.concurrency ?? 4)`: a 0/negative
    // override degrades to the historical one-at-a-time behavior. It must
    // never mean "no workers", which would silently drop every miss.
    for (const override of [0, -3]) {
      const freshCache = new EmbeddingCache(
        path.join(tmpDir, `.embeddings-${override}`),
      );
      const { provider, state } = trackingProvider({ latencyMs: 10 });
      const ranked = await semanticSearch(
        candidateSet(5),
        Q,
        freshCache,
        provider,
        { minScore: 0, embedConcurrency: override },
      );
      expect(state.calls.length).toBe(5);
      expect(ranked.length).toBe(5);
      expect(state.maxInFlight).toBe(1);
    }
  });

  it("still caps on-the-fly embeds to maxOnTheFlyEmbeds", async () => {
    const { provider, state } = trackingProvider();
    await semanticSearch(candidateSet(10), Q, cache, provider, {
      minScore: 0,
      maxOnTheFlyEmbeds: 4,
    });
    expect(state.calls.length).toBe(4);
  });

  it("the cap counts cache MISSES, not candidates", async () => {
    const cands = candidateSet(10);
    // Warm 6 of the 10 → only 4 misses remain, cap 3 embeds 3.
    for (let i = 0; i < 6; i++) {
      cache.set("m", EmbeddingCache.contentHash(`text-${i}`), fakeVec(i + 1));
    }
    const { provider, state } = trackingProvider();
    await semanticSearch(cands, Q, cache, provider, {
      minScore: 0,
      maxOnTheFlyEmbeds: 3,
    });
    expect(state.calls.length).toBe(3);
  });

  it("isolates a failing embed: siblings still rank, the failure is not cached", async () => {
    const { provider, state } = trackingProvider({ failOn: "text-2" });
    const ranked = await semanticSearch(candidateSet(5), Q, cache, provider, {
      minScore: 0,
      embedConcurrency: 4,
    });

    // The rejection did not reject the batch...
    const ids = ranked.map((r) => r.id).sort();
    expect(ids).toEqual(["c0", "c1", "c3", "c4"]);
    // ...did not abort the sibling embeds already in flight (all 5 attempted)...
    expect(state.calls.sort()).toEqual([
      "text-0",
      "text-1",
      "text-2",
      "text-3",
      "text-4",
    ]);
    // ...and the failed text was NOT cached (it must be retried next query).
    expect(cache.has("m", EmbeddingCache.contentHash("text-2"))).toBe(false);
    // Successful siblings WERE cached.
    expect(cache.has("m", EmbeddingCache.contentHash("text-0"))).toBe(true);
  });

  it("cachedOnly performs zero provider calls", async () => {
    const cands = candidateSet(5);
    cache.set("m", EmbeddingCache.contentHash("text-0"), fakeVec(1));
    const { provider, state } = trackingProvider();

    const ranked = await semanticSearch(cands, Q, cache, provider, {
      minScore: 0,
      cachedOnly: true,
      embedConcurrency: 4,
    });

    expect(state.calls.length).toBe(0);
    expect(ranked.map((r) => r.id)).toEqual(["c0"]);
  });

  it("warm cache: scores and order are unchanged by the pooling refactor", async () => {
    // Orthogonal/partial vectors make the cosines exact: no hash-space luck.
    cache.set("m", EmbeddingCache.contentHash("t-identical"), [1, 0, 0, 0]);
    cache.set("m", EmbeddingCache.contentHash("t-tilted"), [1, 1, 0, 0]);
    cache.set("m", EmbeddingCache.contentHash("t-orthogonal"), [0, 1, 0, 0]);
    const { provider, state } = trackingProvider();

    const ranked = await semanticSearch(
      [
        candidate("a", "t-identical"),
        candidate("b", "t-tilted"),
        candidate("c", "t-orthogonal"),
      ],
      Q,
      cache,
      provider,
      { minScore: 0 },
    );

    expect(state.calls.length).toBe(0);
    expect(ranked.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(ranked[0].score).toBe(1);
    expect(ranked[1].score).toBeCloseTo(Math.SQRT1_2, 10);
    expect(ranked[2].score).toBe(0);
  });

  it("pooled wall time tracks ceil(misses/concurrency) × RTT, not misses × RTT", async () => {
    const K = 8;
    const C = 4;
    const LAT = 100;
    const serialFloor = K * LAT; // 800ms — what the serial loop cost
    const pooledExpectation = Math.ceil(K / C) * LAT; // 200ms
    const { provider } = trackingProvider({ latencyMs: LAT });

    const t0 = Date.now();
    await semanticSearch(candidateSet(K), Q, cache, provider, {
      minScore: 0,
      embedConcurrency: C,
    });
    const elapsed = Date.now() - t0;

    // Split the budget at the midpoint so the assertion is not a hair-trigger.
    const budget = (serialFloor + pooledExpectation) / 2;
    console.log(
      `[OPS-008] K=${K} C=${C} latency=${LAT}ms → elapsed=${elapsed}ms ` +
        `(serial floor ${serialFloor}ms, pooled ≈ ${pooledExpectation}ms, budget ${budget}ms)`,
    );
    expect(elapsed).toBeLessThan(budget);
  });
});
