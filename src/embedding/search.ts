/**
 * Cache-Assisted Semantic Search
 *
 * Rank memories by cosine similarity of their embedding vectors, pulling
 * vectors from the gitignored content-addressed cache. No vectors live in
 * DuckDB or git — each machine uses its own configured model and cache.
 *
 * Cache assist on query: candidates whose vectors are missing from the cache
 * get embedded on the fly (up to a cap) so a cold clone still works — it just
 * takes longer the first time ("old ones can take a while").
 */

import { EmbeddingCache } from "./cache";
import type { EmbeddingProvider } from "./providers";

export interface SearchCandidate {
  id: string;
  key: string;
  domain: string;
  timestamp: string;
  author: string;
  action: string;
  embedding_text: string;
  attributes: Record<string, unknown>;
}

export interface SemanticSearchOptions {
  /** Max candidates to embed on the fly when missing from cache (default 50) */
  maxOnTheFlyEmbeds?: number;
  /** Skip on-the-fly embedding entirely (only rank cached vectors) */
  cachedOnly?: boolean;
}

export interface RankedMemory extends SearchCandidate {
  score: number;
}

/** Cosine similarity of two equal-length vectors (1.0 = identical direction) */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Rank candidates by similarity to the query vector using the embedding cache.
 *
 * @param candidates memories to rank (usually already filtered by key/domain)
 * @param queryVector embedding of the query text
 * @param cache the namespace's embedding cache
 * @param provider embedding provider (used for on-the-fly cache misses)
 * @param opts search options
 * @returns ranked memories with similarity scores, best first
 */
export async function semanticSearch(
  candidates: SearchCandidate[],
  queryVector: number[],
  cache: EmbeddingCache,
  provider: EmbeddingProvider | null,
  opts: SemanticSearchOptions = {},
): Promise<RankedMemory[]> {
  const maxOnTheFly = opts.maxOnTheFlyEmbeds ?? 50;
  const ranked: RankedMemory[] = [];
  let onTheFly = 0;

  for (const cand of candidates) {
    const text = cand.embedding_text ?? cand.key;
    if (!text) continue;
    const contentHash = EmbeddingCache.contentHash(text);
    let vector = cache.get(provider?.id ?? "", contentHash);

    if (!vector && provider && !opts.cachedOnly && onTheFly < maxOnTheFly) {
      try {
        vector = await provider.embed(text);
        cache.set(provider.id, contentHash, vector);
        onTheFly++;
      } catch {
        vector = null;
      }
    }

    if (vector) {
      ranked.push({ ...cand, score: cosineSimilarity(queryVector, vector) });
    }
  }

  return ranked.sort((a, b) => b.score - a.score);
}
