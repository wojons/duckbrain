/**
 * Cache-Assisted Embedding Rebuild
 *
 * Walks a namespace's JSONL partitions, hashes every unique embedding_text,
 * and embeds ONLY cache misses via the configured provider. Unchanged content
 * hits the cache (fast); new/changed content and foreign-model entries get
 * embedded (slow on cold start — "old ones can take a while").
 *
 * The rebuild is triggered:
 *   - manually: `duckbrain embeddings rebuild [--namespace X]`
 *   - automatically: git hooks (post-checkout / post-merge / post-rewrite)
 *     installed via `duckbrain embeddings install-hooks` — after clone/pull,
 *     the hook fires a detached rebuild so the cache catches up with cache
 *     assist.
 */

import fs from "fs";
import path from "path";
import { EmbeddingCache } from "./cache";
import type { EmbeddingProvider } from "./providers";

export interface RebuildOptions {
  /** Concurrent embedding requests (default 4) */
  concurrency?: number;
  /** Re-embed even cached entries (default false) */
  force?: boolean;
  /** Progress callback: (done, total, embedded, cacheHits, skipped) */
  onProgress?: (p: {
    done: number;
    total: number;
    embedded: number;
    cacheHits: number;
    skipped: number;
  }) => void;
}

export interface RebuildResult {
  total: number;
  embedded: number;
  cacheHits: number;
  skipped: number;
  failed: number;
  modelId: string;
  cacheDir: string;
  durationMs: number;
  errors: string[];
}

/** Collect unique embedding_text values from all JSONL partitions in a namespace */
export function collectEmbeddingTexts(namespacePath: string): string[] {
  const seen = new Set<string>();
  const texts: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === ".embeddings" || ent.name === ".git") continue;
        walk(full);
      } else if (ent.name.endsWith(".jsonl")) {
        try {
          const lines = fs.readFileSync(full, "utf8").split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const rec = JSON.parse(line);
              const text = rec?.embedding_text ?? rec?.content ?? "";
              if (typeof text === "string" && text.trim() && !seen.has(text)) {
                seen.add(text);
                texts.push(text);
              }
            } catch {
              // unparseable line — skip
            }
          }
        } catch {
          // unreadable file — skip
        }
      }
    }
  };
  walk(namespacePath);
  return texts;
}

/**
 * Rebuild the embedding cache for a namespace with cache assist.
 *
 * @param namespacePath absolute path to the namespace
 * @param cache EmbeddingCache instance
 * @param provider embedding provider (auto-detected when null)
 * @param opts rebuild options
 */
export async function rebuildNamespace(
  namespacePath: string,
  cache: EmbeddingCache,
  provider: EmbeddingProvider | null,
  opts: RebuildOptions = {},
): Promise<RebuildResult> {
  const start = Date.now();
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const texts = collectEmbeddingTexts(namespacePath);
  const result: RebuildResult = {
    total: texts.length,
    embedded: 0,
    cacheHits: 0,
    skipped: 0,
    failed: 0,
    modelId: provider?.id ?? "none",
    cacheDir: cache.root,
    durationMs: 0,
    errors: [],
  };

  if (!provider) {
    result.skipped = texts.length;
    result.durationMs = Date.now() - start;
    return result;
  }

  let done = 0;
  let nextIdx = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= texts.length) return;
      const text = texts[idx];
      const contentHash = EmbeddingCache.contentHash(text);

      if (!opts.force && cache.has(provider.id, contentHash)) {
        result.cacheHits++;
      } else {
        try {
          const vector = await provider.embed(text);
          cache.set(provider.id, contentHash, vector);
          result.embedded++;
        } catch (e) {
          result.failed++;
          result.errors.push(
            `${text.slice(0, 60)}…: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      done++;
      opts.onProgress?.({
        done,
        total: texts.length,
        embedded: result.embedded,
        cacheHits: result.cacheHits,
        skipped: result.skipped,
      });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  result.durationMs = Date.now() - start;
  return result;
}
