/**
 * Tests for embedding provider registry + semantic search.
 *
 * Regressions guarded:
 *  - provider selection via env/config (model-agnostic)
 *  - cosine similarity ranking order
 *  - cache-assisted search: cached vectors ranked; on-the-fly embeds fill gaps
 *  - no provider → search returns only cached vectors (no crash)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EmbeddingCache } from "./cache";
import { semanticSearch, cosineSimilarity, DEFAULT_MIN_SCORE } from "./search";
import { createProvider, resolveEmbeddingConfig } from "./providers";

let tmpDir: string;
let cache: EmbeddingCache;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-search-"));
  cache = new EmbeddingCache(path.join(tmpDir, ".embeddings"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fakeVec(seed: number, dims = 4): number[] {
  const v: number[] = [];
  for (let d = 0; d < dims; d++) v.push(((seed * 13 + d * 7) % 100) / 100);
  return v;
}

function candidate(
  id: string,
  text: string,
  overrides: Partial<{ domain: string }> = {},
) {
  return {
    id,
    key: `/k/${id}`,
    domain: overrides.domain ?? "concept",
    timestamp: "2026-08-01T00:00:00Z",
    author: "test@example.com",
    action: "add",
    embedding_text: text,
    attributes: {},
  };
}

describe("cosineSimilarity", () => {
  it("identical vectors → 1", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
  });
  it("orthogonal vectors → 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });
  it("opposite vectors → -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });
  it("zero vector → 0 (no NaN)", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
  it("empty vector → throws (DOGFOOD-002: no silent score-0 results)", () => {
    expect(() => cosineSimilarity([], [1, 1])).toThrow(/empty vector/);
    expect(() => cosineSimilarity([1, 1], [])).toThrow(/empty vector/);
  });
});

describe("semanticSearch", () => {
  it("ranks cached vectors best-first", async () => {
    const q = fakeVec(1);
    // seed 2 is closest to seed 1 in this hash space — verify by construction:
    // seed 2 → [26,33,40,47]/100, seed 1 → [13,20,27,34]/100
    const near = candidate("near", "similar text");
    const far = candidate("far", "completely different topic");
    cache.set("m", EmbeddingCache.contentHash("similar text"), fakeVec(2));
    cache.set(
      "m",
      EmbeddingCache.contentHash("completely different topic"),
      fakeVec(50),
    );

    const provider = {
      id: "m",
      model: "t",
      dimensions: 4,
      async embed() {
        throw new Error("all cached — should not embed");
      },
    };
    const ranked = await semanticSearch([near, far], q, cache, provider);
    expect(ranked.length).toBe(2);
    expect(ranked[0].id).toBe("near");
    expect(ranked[1].id).toBe("far");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("fills cache gaps with on-the-fly embeds when provider present", async () => {
    const provider = {
      id: "m",
      model: "t",
      dimensions: 4,
      async embed(text: string) {
        return fakeVec(text.length);
      },
    };
    const a = candidate("a", "aaa");
    const b = candidate("b", "bbbbbbbbbb");
    // a cached, b missing → b gets embedded on the fly
    cache.set("m", EmbeddingCache.contentHash("aaa"), fakeVec(1));

    const ranked = await semanticSearch([a, b], fakeVec(1), cache, provider);
    expect(ranked.length).toBe(2);
    // b now cached for next time
    expect(cache.has("m", EmbeddingCache.contentHash("bbbbbbbbbb"))).toBe(true);
  });

  it("cachedOnly skips on-the-fly embeds (missing vectors excluded)", async () => {
    const provider = {
      id: "m",
      model: "t",
      dimensions: 4,
      async embed() {
        throw new Error("should not be called");
      },
    };
    const a = candidate("a", "aaa");
    cache.set("m", EmbeddingCache.contentHash("aaa"), fakeVec(1));
    const b = candidate("b", "bbbb");
    const ranked = await semanticSearch([a, b], fakeVec(1), cache, provider, {
      cachedOnly: true,
    });
    expect(ranked.map((r) => r.id)).toEqual(["a"]);
  });

  it("caps on-the-fly embeds to maxOnTheFlyEmbeds", async () => {
    let calls = 0;
    const provider = {
      id: "m",
      model: "t",
      dimensions: 4,
      async embed(text: string) {
        calls++;
        return fakeVec(text.length);
      },
    };
    const cands = Array.from({ length: 10 }, (_, i) =>
      candidate(`c${i}`, `text-${i}`),
    );
    await semanticSearch(cands, fakeVec(1), cache, provider, {
      maxOnTheFlyEmbeds: 3,
    });
    expect(calls).toBe(3);
  });
});

describe("semanticSearch recency tiebreak (RETR-005)", () => {
  // Identical vectors → identical cosine: only recency can decide the
  // order (previously the sort kept candidate order, i.e. the caller's
  // insertion order — oldest-first on appended JSONL).
  const q = [1, 0, 0, 0];
  const provider = {
    id: "m",
    model: "t",
    dimensions: 4,
    async embed() {
      throw new Error("all cached — should not embed");
    },
  };

  function equalCosinePair() {
    const old = candidate("old", "same text");
    const fresh = candidate("fresh", "same text");
    old.timestamp = "2026-08-01T00:00:00.000Z";
    fresh.timestamp = "2026-08-10T00:00:00.000Z";
    return { old, fresh };
  }

  it("equal-cosine candidates rank by recency — newest wins", async () => {
    const { old, fresh } = equalCosinePair();
    cache.set("m", EmbeddingCache.contentHash("same text"), q); // both score 1.0

    // Oldest-first input order (the pre-RETR-005 candidate fetch order).
    const ranked = await semanticSearch([old, fresh], q, cache, provider, {
      minScore: 0,
    });
    expect(ranked.map((r) => r.id)).toEqual(["fresh", "old"]);
    expect(ranked[0].score).toBe(ranked[1].score); // genuine tie, not a score difference
  });

  it("equal cosine AND equal timestamp fall back to id ascending", async () => {
    const a = candidate("b-id", "same text");
    const b = candidate("a-id", "same text");
    cache.set("m", EmbeddingCache.contentHash("same text"), q);

    const ranked = await semanticSearch([a, b], q, cache, provider, {
      minScore: 0,
    });
    expect(ranked.map((r) => r.id)).toEqual(["a-id", "b-id"]);
  });
});

describe("semanticSearch relevance threshold (DOGFOOD-011)", () => {
  // Orthogonal query/candidate vectors make scores exact: identical
  // direction → 1.0, orthogonal → 0.0. No hash-space luck involved.
  const q = [1, 0, 0, 0];
  const provider = {
    id: "m",
    model: "t",
    dimensions: 4,
    async embed() {
      throw new Error("all cached — should not embed");
    },
  };

  it("default floor (DEFAULT_MIN_SCORE) drops below-threshold candidates", async () => {
    expect(DEFAULT_MIN_SCORE).toBeGreaterThan(0);
    expect(DEFAULT_MIN_SCORE).toBeLessThanOrEqual(0.3);
    const relevant = candidate("rel", "similar text");
    const noise = candidate("noise", "unrelated text");
    cache.set("m", EmbeddingCache.contentHash("similar text"), [1, 0, 0, 0]); // score 1.0
    cache.set("m", EmbeddingCache.contentHash("unrelated text"), [0, 1, 0, 0]); // score 0.0

    const ranked = await semanticSearch([relevant, noise], q, cache, provider);
    expect(ranked.map((r) => r.id)).toEqual(["rel"]);
  });

  it("minScore: 0 disables filtering (everything ranked is returned)", async () => {
    const a = candidate("a", "aaa");
    const b = candidate("b", "bbb");
    cache.set("m", EmbeddingCache.contentHash("aaa"), [1, 0, 0, 0]); // score 1.0
    cache.set("m", EmbeddingCache.contentHash("bbb"), [0, 1, 0, 0]); // score 0.0

    const ranked = await semanticSearch([a, b], q, cache, provider, {
      minScore: 0,
    });
    expect(ranked.map((r) => r.id)).toEqual(["a", "b"]);
    expect(ranked[1].score).toBe(0);
  });

  it("explicit minScore overrides the default", async () => {
    const a = candidate("a", "aaa");
    const b = candidate("b", "bbb");
    cache.set("m", EmbeddingCache.contentHash("aaa"), [1, 0, 0, 0]); // score 1.0
    cache.set("m", EmbeddingCache.contentHash("bbb"), [0, 1, 0, 0]); // score 0.0

    const ranked = await semanticSearch([a, b], q, cache, provider, {
      minScore: 0.5,
    });
    expect(ranked.map((r) => r.id)).toEqual(["a"]);
  });

  it("boundary is inclusive: a candidate exactly at the floor is kept", async () => {
    const exact = candidate("exact", "identical text");
    cache.set("m", EmbeddingCache.contentHash("identical text"), [1, 0, 0, 0]);

    const ranked = await semanticSearch([exact], q, cache, provider, {
      minScore: 1,
    });
    expect(ranked.map((r) => r.id)).toEqual(["exact"]);
    expect(ranked[0].score).toBe(1);
  });

  it("reported scores are the raw cosine similarities", async () => {
    const a = candidate("a", "aaa");
    cache.set("m", EmbeddingCache.contentHash("aaa"), [1, 0, 0, 0]);

    const ranked = await semanticSearch([a], q, cache, provider);
    expect(ranked[0].score).toBe(1);
  });
});

describe("resolveEmbeddingConfig", () => {
  const OLD = { ...process.env };

  afterEach(() => {
    process.env = { ...OLD };
  });

  it("defaults to auto + qwen3 model + 384 dims", () => {
    delete process.env.DUCKBRAIN_EMBEDDING_PROVIDER;
    delete process.env.DUCKBRAIN_EMBEDDING_MODEL;
    const cfg = resolveEmbeddingConfig();
    // DOGFOOD-002: the default is "auto" (probe + fallback) — matching the
    // config schema default and the test's own name. The old "lmstudio"
    // assertion locked in drifted behavior that disabled the auto path.
    expect(cfg.provider).toBe("auto");
    expect(cfg.model).toBe("text-embedding-qwen3-embedding-0.6b");
    expect(cfg.dimensions).toBe(384);
  });

  it("env overrides win over defaults", () => {
    process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "ollama";
    process.env.DUCKBRAIN_EMBEDDING_MODEL = "nomic-embed-text";
    const cfg = resolveEmbeddingConfig();
    expect(cfg.provider).toBe("ollama");
    expect(cfg.model).toBe("nomic-embed-text");
  });

  it("explicit args beat env", () => {
    process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "ollama";
    const cfg = resolveEmbeddingConfig({
      provider: "openai",
      model: "text-embedding-3-small",
    });
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("text-embedding-3-small");
  });
});

describe("createProvider", () => {
  it("throws on unknown provider", () => {
    expect(() => createProvider({ provider: "does-not-exist" })).toThrow(
      /Unknown embedding provider/,
    );
  });

  it("builds an lmstudio provider with correct id", () => {
    const p = createProvider({ provider: "lmstudio", model: "qwen3" });
    expect(p.id).toBe("lmstudio/qwen3");
    expect(p.model).toBe("qwen3");
    expect(p.dimensions).toBe(384);
  });

  it("builds an ollama provider", () => {
    const p = createProvider({
      provider: "ollama",
      model: "nomic",
      dimensions: 768,
    });
    expect(p.id).toBe("ollama/nomic");
    expect(p.dimensions).toBe(768);
  });

  it("openai provider requires no immediate key but id is correct", () => {
    const p = createProvider({
      provider: "openai",
      model: "text-embedding-3-small",
    });
    expect(p.id).toBe("openai/text-embedding-3-small");
  });
});
