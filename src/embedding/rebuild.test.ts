/**
 * Tests for the cache-assisted embedding rebuild.
 *
 * Regressions guarded:
 *  - cache assist: unchanged content hits the cache and is NOT re-embedded
 *  - new content is embedded and stored
 *  - model switch = cold cache for that model (old ones take a while — by design)
 *  - collectEmbeddingTexts dedupes and reads embedding_text/content fields
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EmbeddingCache } from "./cache";
import {
  collectEmbeddingTexts,
  rebuildNamespace,
  type RebuildResult,
} from "./rebuild";
import type { EmbeddingProvider } from "./providers";

let tmpDir: string;
let nsPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-rebuild-"));
  nsPath = path.join(tmpDir, "ns");
  fs.mkdirSync(path.join(nsPath, "config", "2026-08"), { recursive: true });
  fs.mkdirSync(path.join(nsPath, "concept", "2026-08"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(
  dir: string,
  records: Array<Record<string, unknown>>,
): void {
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "current.jsonl"), lines);
}

/** Deterministic fake provider: hash text into a 4-dim vector */
function makeProvider(
  id = "test/model",
  dims = 4,
): EmbeddingProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id,
    model: "test-model",
    dimensions: dims,
    async embed(text: string): Promise<number[]> {
      calls.push(text);
      let h = 0;
      for (let i = 0; i < text.length; i++)
        h = (h * 31 + text.charCodeAt(i)) >>> 0;
      const v: number[] = [];
      for (let d = 0; d < dims; d++) {
        v.push(((h >> (d * 3)) & 0xff) / 255);
      }
      return v;
    },
    calls,
  };
}

describe("collectEmbeddingTexts", () => {
  it("collects unique embedding_text values across partitions", () => {
    writeJsonl(path.join(nsPath, "config", "2026-08"), [
      { id: "1", key: "/a", embedding_text: "alpha" },
      { id: "2", key: "/b", embedding_text: "beta" },
      { id: "3", key: "/c", embedding_text: "alpha" }, // dup
    ]);
    writeJsonl(path.join(nsPath, "concept", "2026-08"), [
      { id: "4", key: "/d", embedding_text: "delta" },
      { id: "5", key: "/e" }, // no embedding_text — skipped
      { id: "6", key: "/f", content: "fallback content" }, // content fallback
    ]);
    const texts = collectEmbeddingTexts(nsPath).sort();
    expect(texts).toEqual(["alpha", "beta", "delta", "fallback content"]);
  });

  it("skips the .embeddings cache dir and .git", () => {
    fs.mkdirSync(path.join(nsPath, ".embeddings", "m", "ab"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(nsPath, ".embeddings", "m", "ab", "x.json"),
      "{}",
    );
    writeJsonl(path.join(nsPath, "config", "2026-08"), [
      { id: "1", key: "/a", embedding_text: "alpha" },
    ]);
    expect(collectEmbeddingTexts(nsPath)).toEqual(["alpha"]);
  });
});

describe("rebuildNamespace", () => {
  it("embeds everything on cold cache (cache assist fills the gap)", async () => {
    writeJsonl(path.join(nsPath, "config", "2026-08"), [
      { id: "1", key: "/a", embedding_text: "alpha" },
      { id: "2", key: "/b", embedding_text: "beta" },
    ]);
    const cache = new EmbeddingCache(path.join(nsPath, ".embeddings"));
    const provider = makeProvider();
    const result = await rebuildNamespace(nsPath, cache, provider);
    expect(result.total).toBe(2);
    expect(result.embedded).toBe(2);
    expect(result.cacheHits).toBe(0);
    expect(provider.calls).toHaveLength(2);
    expect(cache.count()).toBe(2);
  });

  it("cache assist: second rebuild embeds NOTHING (all hits)", async () => {
    writeJsonl(path.join(nsPath, "config", "2026-08"), [
      { id: "1", key: "/a", embedding_text: "alpha" },
    ]);
    const cache = new EmbeddingCache(path.join(nsPath, ".embeddings"));
    const provider = makeProvider();
    await rebuildNamespace(nsPath, cache, provider);
    const callsAfterFirst = provider.calls.length;

    const result = await rebuildNamespace(nsPath, cache, provider);
    expect(result.total).toBe(1);
    expect(result.cacheHits).toBe(1);
    expect(result.embedded).toBe(0);
    expect(provider.calls.length).toBe(callsAfterFirst); // no new embed calls
  });

  it("only new content is embedded after additions (delta rebuild)", async () => {
    writeJsonl(path.join(nsPath, "config", "2026-08"), [
      { id: "1", key: "/a", embedding_text: "alpha" },
    ]);
    const cache = new EmbeddingCache(path.join(nsPath, ".embeddings"));
    const provider = makeProvider();
    await rebuildNamespace(nsPath, cache, provider);

    writeJsonl(path.join(nsPath, "config", "2026-08"), [
      { id: "1", key: "/a", embedding_text: "alpha" },
      { id: "2", key: "/b", embedding_text: "beta" },
    ]);
    const result = await rebuildNamespace(nsPath, cache, provider);
    expect(result.cacheHits).toBe(1);
    expect(result.embedded).toBe(1);
    expect(provider.calls).toContain("beta");
  });

  it("different model = separate cache namespace (cold for that model)", async () => {
    writeJsonl(path.join(nsPath, "config", "2026-08"), [
      { id: "1", key: "/a", embedding_text: "alpha" },
    ]);
    const cache = new EmbeddingCache(path.join(nsPath, ".embeddings"));
    const p1 = makeProvider("user-a/model");
    const p2 = makeProvider("user-b/model");
    await rebuildNamespace(nsPath, cache, p1);
    const r2 = await rebuildNamespace(nsPath, cache, p2);
    // Bane's design: different people use different models → user-b starts
    // cold ("old ones can take a while") but user-a's vectors are untouched.
    expect(r2.embedded).toBe(1);
    expect(r2.cacheHits).toBe(0);
    expect(cache.count()).toBe(2);
  });

  it("force re-embeds even cached entries", async () => {
    writeJsonl(path.join(nsPath, "config", "2026-08"), [
      { id: "1", key: "/a", embedding_text: "alpha" },
    ]);
    const cache = new EmbeddingCache(path.join(nsPath, ".embeddings"));
    const provider = makeProvider();
    await rebuildNamespace(nsPath, cache, provider);
    const result = await rebuildNamespace(nsPath, cache, provider, {
      force: true,
    });
    expect(result.embedded).toBe(1);
    expect(result.cacheHits).toBe(0);
  });

  it("no provider → skipped, no crash", async () => {
    writeJsonl(path.join(nsPath, "config", "2026-08"), [
      { id: "1", key: "/a", embedding_text: "alpha" },
    ]);
    const cache = new EmbeddingCache(path.join(nsPath, ".embeddings"));
    const result: RebuildResult = await rebuildNamespace(nsPath, cache, null);
    expect(result.total).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.embedded).toBe(0);
  });

  it("provider failures are counted, not fatal", async () => {
    writeJsonl(path.join(nsPath, "config", "2026-08"), [
      { id: "1", key: "/a", embedding_text: "alpha" },
      { id: "2", key: "/b", embedding_text: "beta" },
    ]);
    const cache = new EmbeddingCache(path.join(nsPath, ".embeddings"));
    const failing: EmbeddingProvider = {
      id: "fail/model",
      model: "fail",
      dimensions: 4,
      async embed() {
        throw new Error("provider down");
      },
    };
    const result = await rebuildNamespace(nsPath, cache, failing);
    expect(result.failed).toBe(2);
    expect(result.errors.length).toBe(2);
    expect(cache.count()).toBe(0);
  });

  it("concurrency=1 still processes everything (serial worker)", async () => {
    writeJsonl(path.join(nsPath, "config", "2026-08"), [
      { id: "1", key: "/a", embedding_text: "alpha" },
      { id: "2", key: "/b", embedding_text: "beta" },
      { id: "3", key: "/c", embedding_text: "gamma" },
    ]);
    const cache = new EmbeddingCache(path.join(nsPath, ".embeddings"));
    const provider = makeProvider();
    const result = await rebuildNamespace(nsPath, cache, provider, {
      concurrency: 1,
    });
    expect(result.embedded).toBe(3);
    expect(cache.count()).toBe(3);
  });
});
