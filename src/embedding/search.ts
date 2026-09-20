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
 *
 * OPS-008: those on-the-fly misses are embedded through a BOUNDED WORKER POOL
 * (the rebuild.ts shape), so a cold-cache slice costs
 * `ceil(misses / concurrency) × provider RTT` instead of `misses × RTT`.
 * Measured live against a healthy remote embedder (2.3-7.6s per call), the
 * serial version spent 28-40s in local overhead per query — past the 30s
 * semantic budget — and paid it again on a repeated query whenever the slice
 * was still cold.
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

/**
 * Default minimum cosine similarity for a candidate to be returned by
 * semantic search (DOGFOOD-011). Candidates below this relevance floor are
 * dropped — a garbage query must return "no match", not every memory ranked.
 * 0.25 sits in the sensible 0.2-0.3 band: high enough to reject unrelated
 * text (typical cosine ~0.0-0.15 against 384-dim embeddings), low enough to
 * keep genuinely related text (typically 0.3+).
 */
export const DEFAULT_MIN_SCORE = 0.25;

/**
 * Default concurrent embedding requests for on-the-fly cache misses
 * (OPS-008). Mirrors the rebuild worker pool's default (rebuild.ts) — one
 * request in flight per worker, so a cold slice takes
 * `ceil(misses / concurrency)` provider round trips instead of one per miss.
 * 4 is the same value the cache rebuild has used on this host without
 * tripping the provider's rate limits.
 */
export const DEFAULT_EMBED_CONCURRENCY = 4;

export interface SemanticSearchOptions {
  /** Max candidates to embed on the fly when missing from cache (default 50) */
  maxOnTheFlyEmbeds?: number;
  /** Skip on-the-fly embedding entirely (only rank cached vectors) */
  cachedOnly?: boolean;
  /**
   * Minimum cosine similarity for a candidate to be returned (default
   * DEFAULT_MIN_SCORE = 0.25). Candidates scoring below the floor are
   * dropped. Pass 0 to disable filtering (return everything ranked).
   */
  minScore?: number;
  /**
   * Concurrent embedding requests for on-the-fly cache misses (OPS-008,
   * default DEFAULT_EMBED_CONCURRENCY = 4). Clamped to >= 1, so 0/negative
   * degrades to the historical serial behavior rather than embedding nothing.
   */
  embedConcurrency?: number;
}

export interface RankedMemory extends SearchCandidate {
  score: number;
}

/** Cosine similarity of two equal-length vectors (1.0 = identical direction) */
export function cosineSimilarity(a: number[], b: number[]): number {
  // DOGFOOD-002: a zero-length vector (e.g. a provider that returned a 200
  // with {"embedding":[]}) must never produce silent score-0 "results" — it
  // is a failed embed, not a valid query. Callers are expected to reject
  // empty vectors earlier; this guard makes the failure loud instead of
  // silently ranking everything at 0.
  if (a.length === 0 || b.length === 0) {
    throw new Error("cosineSimilarity: empty vector (embedding failed?)");
  }
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
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  // OPS-008: same clamp as the rebuild pool (rebuild.ts) — a 0/negative
  // override degrades to serial embedding, it never spawns zero workers.
  const embedConcurrency = Math.max(
    1,
    opts.embedConcurrency ?? DEFAULT_EMBED_CONCURRENCY,
  );
  const embedder = opts.cachedOnly ? null : provider;
  const modelId = provider?.id ?? "";

  // Pass 1 (OPS-008): resolve candidates from the cache first and collect the
  // misses that will be embedded on the fly, instead of interleaving
  // cache-resolve → embed → score inside one serial loop.
  //
  // Misses are deduped by content hash: two candidates sharing an
  // embedding_text share a hash, and the serial loop embedded that text once
  // (the second candidate hit the cache entry the first had just written).
  // Deduping keeps that single request per unique text, and keeps the cap
  // counting MISSES rather than candidate slots.
  const hits: Array<{ cand: SearchCandidate; vector: number[] }> = [];
  const misses: Array<{ text: string; contentHash: string }> = [];
  const pending: Array<{ cand: SearchCandidate; contentHash: string }> = [];
  const queued = new Set<string>();

  for (const cand of candidates) {
    const text = cand.embedding_text ?? cand.key;
    if (!text) continue;
    const contentHash = EmbeddingCache.contentHash(text);

    const cached = cache.get(modelId, contentHash);
    if (cached) {
      hits.push({ cand, vector: cached });
      continue;
    }

    // No vector and no on-the-fly path (cachedOnly, or no provider at all) →
    // the candidate cannot be ranked, exactly as before.
    if (!embedder) continue;

    if (!queued.has(contentHash)) {
      // Cap applies to the unique miss texts actually handed to the pool, so
      // no more than maxOnTheFly embedding requests are ever issued.
      if (misses.length >= maxOnTheFly) continue;
      queued.add(contentHash);
      misses.push({ text, contentHash });
    }
    pending.push({ cand, contentHash });
  }

  // Pass 2 (OPS-008): embed the miss set through a bounded worker pool — the
  // same shape as rebuildNamespace (rebuild.ts): a shared index, N workers,
  // Promise.all over the workers. Each text's failure is contained inside its
  // own worker iteration, so one rejection neither rejects the batch nor
  // aborts the sibling embeds already in flight. The provider's own
  // AbortSignal.timeout (providers.ts) is the only latency budget — a slow
  // embed cannot hold the pool past it, and no retry loop is added here.
  const fresh = new Map<string, number[]>();
  if (embedder && misses.length > 0) {
    const providerId = embedder.id;
    let nextIdx = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const idx = nextIdx++;
        if (idx >= misses.length) return;
        const miss = misses[idx];
        try {
          const vector = await embedder.embed(miss.text);
          cache.set(providerId, miss.contentHash, vector);
          fresh.set(miss.contentHash, vector);
        } catch {
          // Failure isolation: the miss stays unranked and is NOT cached, so
          // the next query retries it — the serial `catch { vector = null }`
          // contract, preserved per text instead of per candidate.
        }
      }
    };

    await Promise.all(Array.from({ length: embedConcurrency }, worker));
  }

  // Pass 3: rank cache hits and newly embedded vectors together. Scoring is
  // deliberately OUTSIDE the pool: cosineSimilarity throws on an empty vector
  // (DOGFOOD-002) and that throw must still surface from semanticSearch
  // rather than being swallowed as an embed failure.
  const ranked: RankedMemory[] = [];
  const push = (cand: SearchCandidate, vector: number[]): void => {
    const score = cosineSimilarity(queryVector, vector);
    // DOGFOOD-011: enforce the relevance floor. Candidates below it are
    // dropped, so a nonsense query yields "no match" instead of every
    // memory ranked. Boundary is inclusive (score exactly at the floor is
    // kept); minScore 0 disables filtering.
    if (score >= minScore) {
      ranked.push({ ...cand, score });
    }
  };

  for (const hit of hits) push(hit.cand, hit.vector);
  for (const miss of pending) {
    const vector = fresh.get(miss.contentHash);
    if (vector) push(miss.cand, vector);
  }

  return ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // RETR-005: equal-similarity ties break by recency — a fresh memory
    // outranks an old one at the same cosine. This ordering feeds both the
    // semantic-only path and the hybrid fusion semantic leg, so rankFused
    // sees recency-resolved ranks for equal-cosine candidates. Identical
    // timestamps fall back to id ascending (fully deterministic).
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return tb - ta;
    return a.id.localeCompare(b.id);
  });
}
