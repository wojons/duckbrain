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
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  EmbeddingCache,
  ensureCacheGitignored,
  EMBEDDING_CACHE_DIR,
} from "./cache";

/** Replicates the private entryKey(): sha256(modelId \0 contentHash) */
function keyFor(modelId: string, contentHash: string): string {
  return crypto
    .createHash("sha256")
    .update(`${modelId}\x00${contentHash}`, "utf8")
    .digest("hex");
}

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
    const got = cache.get("lmstudio/qwen3", hash);
    // float32 storage: exact equality is NOT the contract anymore
    expect(got!.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs([0.1, 0.2, 0.3][i] - got![i])).toBeLessThanOrEqual(1e-6);
    }
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

  it("round-trips a 4096-dim float32 vector within tolerance (DB-GAP-054)", () => {
    const cache = new EmbeddingCache(tmpDir);
    const hash = EmbeddingCache.contentHash("big vector");
    const vector = Array.from({ length: 4096 }, (_, i) => {
      // non-trivial values incl. irrationals that need float32 rounding;
      // magnitude ≤ 1 keeps float32 abs error well under the 1e-6 tolerance
      return Math.sin(i + 1) * Math.pow(10, (i % 4) - 3);
    });
    cache.set("lmstudio/qwen3", hash, vector);
    const got = cache.get("lmstudio/qwen3", hash);
    expect(got).not.toBeNull();
    expect(got!.length).toBe(4096);
    let maxDiff = 0;
    for (let i = 0; i < vector.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(vector[i] - got![i]));
    }
    expect(maxDiff).toBeLessThanOrEqual(1e-6);
    // new-format file must exist on disk and the JSON legacy file must not
    const key = keyFor("lmstudio/qwen3", hash);
    const binPath = path.join(tmpDir, "lmstudio_qwen3", key.slice(0, 2), `${key}.bin`);
    expect(fs.existsSync(binPath)).toBe(true);
    // magic check
    const buf = fs.readFileSync(binPath);
    expect(buf.readUInt32LE(0)).toBe(0x44424633);
  });

  it("on-disk 4096-dim entry is < 20,000 bytes (vs ~88 KB JSON)", () => {
    const cache = new EmbeddingCache(tmpDir);
    const hash = EmbeddingCache.contentHash("size check");
    cache.set(
      "m",
      hash,
      Array.from({ length: 4096 }, (_, i) => i / 4096),
    );
    const binPath = path.join(
      tmpDir,
      "m",
      keyFor("m", hash).slice(0, 2),
      `${keyFor("m", hash)}.bin`,
    );
    expect(fs.statSync(binPath).size).toBeLessThan(20000);
  });

  it("reads a legacy JSON entry and migrates it to .bin", () => {
    const cache = new EmbeddingCache(tmpDir);
    const hash = EmbeddingCache.contentHash("legacy");
    const vector = [0.1, 0.2, 0.3, Math.PI, 1e-8];
    const jsonPath = path.join(
      tmpDir,
      "lmstudio_qwen3",
      keyFor("lmstudio/qwen3", hash).slice(0, 2),
      `${keyFor("lmstudio/qwen3", hash)}.json`,
    );
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        modelId: "lmstudio/qwen3",
        contentHash: hash,
        dimensions: vector.length,
        vector,
        createdAt: new Date().toISOString(),
      }),
    );
    // backward compat: legacy entry still readable
    expect(cache.get("lmstudio/qwen3", hash)).toEqual(vector);
    // migrate converts it
    const result = cache.migrate();
    expect(result.converted).toBe(1);
    expect(result.skipped).toBe(0);
    expect(fs.existsSync(jsonPath)).toBe(false);
    const binPath = path.join(
      tmpDir,
      "lmstudio_qwen3",
      keyFor("lmstudio/qwen3", hash).slice(0, 2),
      `${keyFor("lmstudio/qwen3", hash)}.bin`,
    );
    expect(fs.existsSync(binPath)).toBe(true);
    const got = cache.get("lmstudio/qwen3", hash)!;
    expect(got.length).toBe(vector.length);
    for (let i = 0; i < vector.length; i++) {
      expect(Math.abs(vector[i] - got[i])).toBeLessThanOrEqual(1e-6);
    }
  });

  it("migrate skips corrupt JSON and does not touch .bin entries", () => {
    const cache = new EmbeddingCache(tmpDir);
    const hash = EmbeddingCache.contentHash("mixed");
    cache.set("m", hash, [1, 2, 3]); // writes .bin
    const shard = path.join(tmpDir, "m", keyFor("m", hash).slice(0, 2));
    fs.writeFileSync(path.join(shard, "deadbeef.json"), "{ not json !!");
    const result = cache.migrate();
    expect(result.converted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(fs.existsSync(path.join(shard, `${keyFor("m", hash)}.bin`))).toBe(
      true,
    );
    expect(cache.count("m")).toBe(2); // .bin + corrupt .json counted
  });

  it("count() sees .bin entries", () => {
    const cache = new EmbeddingCache(tmpDir);
    cache.set("m", EmbeddingCache.contentHash("x"), [1]);
    expect(cache.count()).toBe(1);
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
