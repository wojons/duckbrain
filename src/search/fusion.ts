/**
 * Reciprocal Rank Fusion (RETR-002) — the shared hybrid-search fusion
 * module.
 *
 * Fuses the ranked outputs of independent retrievers (the keyword FTS leg
 * and the embedding-cosine leg) into one ranked list. Each retriever
 * contributes at most its top `topK` (default 20) candidates, scored by
 * the standard RRF formula (Cormack et al., 2009):
 *
 *   rrf(doc) = Σ_retrievers 1 / (rrf_k + rank_retriever(doc))
 *
 * with rrf_k = 60 (the widely used default). A document ranked #1 by
 * EVERY active retriever scores 1.0; a document seen by only one
 * retriever at rank r scores (rrf_k+1)/(rrf_k+r) against that ceiling.
 * The normalized 0..1 scale is what recallTool reports as items[].score
 * on the hybrid ?q= path — NOT the raw cosine or BM25 score.
 *
 * Recency tiebreak: when two documents' fused scores are equal (within
 * RRF_EPSILON), the more recent memory (timestamp) ranks first;
 * identical timestamps fall back to id ascending so the order is fully
 * deterministic.
 *
 * The module is pure arithmetic — no DuckDB, no network, no
 * dependencies. The orchestration that feeds it (which retrievers are
 * available, the semantic 0.25 floor, the fallback ladder) lives in
 * src/mcp/tools/recall.ts.
 */

/** RRF constant k — the rank-offset denominator (60). */
export const RRF_K = 60;

/** Per-retriever candidate cap — each retriever contributes at most its
 *  top 20 by its own ranking; candidates beyond rank 20 contribute
 *  nothing (even when the other retriever ranked them). */
export const FUSION_TOP_K = 20;

/** Scores closer than this are treated as ties (floating-point guard). */
export const RRF_EPSILON = 1e-12;

/** The minimal shape a retriever item needs for fusion: an id to match
 *  across retrievers and a timestamp for the recency tiebreak. */
export interface FusionRetrieverItem {
  id: string;
  timestamp: string;
}

/** One fused entry: the item plus its scores. */
export interface FusedResult<T extends FusionRetrieverItem> {
  item: T;
  /**
   * Normalized fused RRF score on a 0..1 scale: 1.0 = ranked #1 by every
   * active retriever (an "active" retriever is one that returned at
   * least one candidate). This is the score callers report to users.
   */
  score: number;
  /** Raw (unnormalized) RRF sum — exposed for tests and debugging. */
  rrf: number;
}

export interface RankFusedOptions {
  /** RRF denominator offset (default RRF_K = 60). */
  rrfK?: number;
  /** Per-retriever candidate cap (default FUSION_TOP_K = 20). */
  topK?: number;
}

/**
 * Fuse the ranked outputs of one or more retrievers via Reciprocal Rank
 * Fusion.
 *
 * @param retrieverRankings one ranked list per retriever, best first
 *   (e.g. [semanticTop20, keywordTop20]); each list is truncated to its
 *   top `topK` before scoring. Empty lists are ignored for normalization
 *   (an empty retriever contributed nothing, so it cannot set the
 *   ceiling).
 * @param opts rrfK / topK overrides (defaults RRF_K / FUSION_TOP_K)
 * @returns fused results sorted by rrf desc, then timestamp desc
 *   (recency tiebreak), then id asc (deterministic final tie)
 */
export function rankFused<T extends FusionRetrieverItem>(
  retrieverRankings: T[][],
  opts: RankFusedOptions = {},
): FusedResult<T>[] {
  const rrfK = opts.rrfK ?? RRF_K;
  const topK = opts.topK ?? FUSION_TOP_K;

  // Accumulate per-document RRF sums. `item` keeps the FIRST occurrence's
  // payload — retriever callers pass identical-shaped items for the same
  // id, so which copy survives only matters for extra fields (e.g. the
  // keyword leg's snippet), which hybrid recall re-attaches by id anyway.
  const sums = new Map<string, { item: T; rrf: number }>();
  let activeRetrievers = 0;

  for (const ranking of retrieverRankings) {
    if (ranking.length === 0) continue;
    activeRetrievers += 1;
    const top = ranking.slice(0, topK);
    for (let i = 0; i < top.length; i++) {
      const item = top[i];
      const contribution = 1 / (rrfK + i + 1);
      const existing = sums.get(item.id);
      if (existing) {
        existing.rrf += contribution;
      } else {
        sums.set(item.id, { item, rrf: contribution });
      }
    }
  }

  // Normalize against the best possible score: rank #1 in every active
  // retriever. With zero active retrievers there is nothing to return.
  const maxRrf = activeRetrievers / (rrfK + 1);
  if (maxRrf <= 0) return [];

  const fused: FusedResult<T>[] = [];
  for (const { item, rrf } of sums.values()) {
    fused.push({ item, rrf, score: rrf / maxRrf });
  }

  fused.sort((a, b) => {
    if (Math.abs(a.rrf - b.rrf) > RRF_EPSILON) return b.rrf - a.rrf;
    // Recency tiebreak: newer timestamp first.
    const ta = Date.parse(a.item.timestamp);
    const tb = Date.parse(b.item.timestamp);
    if (Number.isNaN(ta) || Number.isNaN(tb)) {
      // Unparseable timestamp (defensive — memories are schema-validated
      // ISO) — fall back to the deterministic id order.
      return a.item.id.localeCompare(b.item.id);
    }
    if (ta !== tb) return tb - ta;
    return a.item.id.localeCompare(b.item.id);
  });

  return fused;
}
