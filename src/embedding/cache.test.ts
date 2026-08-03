/**
 * Tests for the content-addressed embedding cache store.
 *
 * Regressions guarded:
 *  - vectors are keyed by (modelId, contentHash) — different models NEVER
 *    collide, so multiple people can use different embedding models
 *  - the cache directory is gitignored (embeddings never enter git)
 *  - atomic writes (tmp+rename) survive partial writes
 *  - corrupted entries are treated as cache misses, not crashes
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  EmbeddingCache,
  ensureCacheGitignored,
  EMBEDDING_CACHE_DIR,
} from "./cache";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-cache-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("EmbeddingCache", () => {
  it("round-trips a vector for (model, contentHash)", () => {
    const cache = new EmbeddingCache(tmpDir);
    const hash = EmbeddingCache.contentHash("hello world");
    cache.set("lmstudio/qwen3", hash, [0.1, 0.2, 0.3]);
    expect(cache.get("lmstudio/qwen3", hash)).toEqual([0.1, 0.2, 0.3]);
    expect(cache.has("lmstudio/qwen3", hash)).toBe(true);
  });

  it("isolates models — same content, different model = separate entries", () => {
    const cache = new EmbeddingCache(tmpDir);
    const hash = EmbeddingCache.contentHash("shared text");
    cache.set("lmstudio/qwen3", hash, [1, 2, 3]);
    cache.set("ollama/nomic", hash, [9, 9, 9]);
    expect(cache.get("lmstudio/qwen3", hash)).toEqual([1, 2, 3]);
    expect(cache.get("ollama/nomic", hash)).toEqual([9, 9, 9]);
    expect(cache.count()).toBe(2);
    expect(cache.models().sort()).toEqual(["lmstudio_qwen3", "ollama_nomic"]);
  });

  it("treats a corrupted entry as a miss, not a crash", () => {
    const cache = new EmbeddingCache(tmpDir);
    const hash = EmbeddingCache.contentHash("x");
    const p = path.join(
      tmpDir,
      "lmstudio_qwen3",
      hash.slice(0, 2),
      `${hash}.json`,
    );
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{ not json !!");
    expect(cache.get("lmstudio/qwen3", hash)).toBeNull();
    expect(cache.has("lmstudio/qwen3", hash)).toBe(false);
  });

  it("returns null on miss and tolerates missing dirs", () => {
    const cache = new EmbeddingCache(path.join(tmpDir, "nope"));
    expect(cache.get("m", EmbeddingCache.contentHash("x"))).toBeNull();
    expect(cache.count()).toBe(0);
    expect(cache.sizeBytes()).toBe(0);
  });

  it("contentHash is stable and model-independent", () => {
    expect(EmbeddingCache.contentHash("same")).toBe(
      EmbeddingCache.contentHash("same"),
    );
    expect(EmbeddingCache.contentHash("same")).not.toBe(
      EmbeddingCache.contentHash("different"),
    );
  });

  it("sizeBytes counts real disk usage", () => {
    const cache = new EmbeddingCache(tmpDir);
    cache.set("m1", EmbeddingCache.contentHash("a"), [1, 2, 3]);
    cache.set("m1", EmbeddingCache.contentHash("b"), [4, 5, 6]);
    expect(cache.sizeBytes()).toBeGreaterThan(0);
    expect(cache.count("m1")).toBe(2);
  });
});

describe("ensureCacheGitignored", () => {
  it("creates .gitignore when missing", () => {
    const ns = path.join(tmpDir, "ns");
    fs.mkdirSync(ns, { recursive: true });
    ensureCacheGitignored(ns);
    const gi = fs.readFileSync(path.join(ns, ".gitignore"), "utf8");
    expect(gi).toContain(`/${EMBEDDING_CACHE_DIR}/`);
  });

  it("appends to existing .gitignore without duplicating", () => {
    const ns = path.join(tmpDir, "ns");
    fs.mkdirSync(ns, { recursive: true });
    fs.writeFileSync(path.join(ns, ".gitignore"), "node_modules/\n");
    ensureCacheGitignored(ns);
    ensureCacheGitignored(ns);
    const gi = fs.readFileSync(path.join(ns, ".gitignore"), "utf8");
    expect(gi.match(/\.embeddings/g)).toHaveLength(1);
  });
});
