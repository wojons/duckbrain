/**
 * RETR-002 Unit Tests: Reciprocal Rank Fusion (src/search/fusion.ts).
 *
 * Deterministic known-rank fixtures — fixed rank lists in, exact expected
 * fused order out. Covers:
 *   - the RRF formula itself (rrf_k=60): 1/(60+rank) per retriever
 *   - the per-retriever top-k=20 cap (candidates beyond rank 20 contribute
 *     NOTHING, even when the other retriever ranked them)
 *   - recency tiebreak: equal fused scores → newer timestamp first;
 *     equal timestamps → id ascending (fully deterministic)
 *   - normalization: 1.0 = rank #1 in every ACTIVE retriever; empty
 *     retrievers are ignored for the ceiling
 *   - single-retriever and empty-input edge cases
 *
 * The E2E half (hybrid ?q= through recallTool/HTTP with a real rebuilt
 * FTS sidecar + 20-query fixture) lives in
 * src/http/routes/memories-hybrid-retr002.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  rankFused,
  RRF_K,
  FUSION_TOP_K,
  RRF_EPSILON,
  type FusionRetrieverItem,
} from "./fusion";

function doc(id: string, timestamp = "2026-08-01T00:00:00.000Z") {
  return { id, timestamp };
}

// Exact rational scores for the 2-retriever fixtures:
//   rank #1 in both   → (1/61 + 1/61) / (2/61)           = 1
//   ranks (1, 2)      → (1/61 + 1/62) / (2/61)           = 123/124
//   ranks (2, 2)      → (2/62) / (2/61)                  = 61/62
//   rank #2 in one    → (1/62) / (2/61)                  = 61/124
//   rank #3 in one    → (1/63) / (2/61)                  = 61/126
//   rank #20 in one   → (1/80) / (2/61)                  = 61/160
const TWO_RETRIEVER_MAX = 123 / 124;
const ONE_SIDE_RANK2 = 61 / 124;
const ONE_SIDE_RANK3 = 61 / 126;

describe("RETR-002: rankFused formula", () => {
  it("fuses two retrievers by reciprocal rank with rrf_k=60", () => {
    const semantic = [
      doc("A", "2026-08-01T00:00:00.000Z"),
      doc("B", "2026-08-02T00:00:00.000Z"),
      doc("C", "2026-08-03T00:00:00.000Z"),
    ];
    const keyword = [
      doc("B", "2026-08-02T00:00:00.000Z"),
      doc("A", "2026-08-01T00:00:00.000Z"),
      doc("D", "2026-08-04T00:00:00.000Z"),
    ];
    const fused = rankFused([semantic, keyword]);

    // A and B both score 1/61+1/62 (exact tie — same rank tuple, swapped
    // retrievers) → recency tiebreak: B is newer → B first.
    // C and D both score 1/63 (exact tie) → D is newer → D before C.
    expect(fused.map((f) => f.item.id)).toEqual(["B", "A", "D", "C"]);
    expect(fused[0].score).toBeCloseTo(TWO_RETRIEVER_MAX, 10);
    expect(fused[1].score).toBeCloseTo(TWO_RETRIEVER_MAX, 10);
    // Raw RRF sums are the unnormalized 1/(60+rank) totals.
    expect(fused[0].rrf).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(fused[2].score).toBeCloseTo(ONE_SIDE_RANK3, 10);
    expect(fused[3].score).toBeCloseTo(ONE_SIDE_RANK3, 10);
  });

  it("recency decides exact ties: older doc first when it is newer", () => {
    // Same rank tuples as above, timestamps flipped: A now newer than B.
    const semantic = [
      doc("A", "2026-08-09T00:00:00.000Z"),
      doc("B", "2026-08-01T00:00:00.000Z"),
      doc("C", "2026-08-02T00:00:00.000Z"),
    ];
    const keyword = [
      doc("B", "2026-08-01T00:00:00.000Z"),
      doc("A", "2026-08-09T00:00:00.000Z"),
      doc("D", "2026-08-03T00:00:00.000Z"),
    ];
    const fused = rankFused([semantic, keyword]);
    expect(fused.map((f) => f.item.id)).toEqual(["A", "B", "D", "C"]);
  });

  it("exact ties from different rank tuples fall to recency", () => {
    // A ranks (3, 4) across the two retrievers, B ranks (4, 3):
    // 1/63+1/64 vs 1/64+1/63 — an exact float tie from DIFFERENT rank
    // tuples (not the same doc ranked identically twice). Recency must
    // decide: B is newer → B first.
    const r1 = [
      doc("X", "2026-08-01T00:00:00.000Z"),
      doc("Y", "2026-08-02T00:00:00.000Z"),
      doc("A", "2026-08-03T00:00:00.000Z"),
      doc("B", "2026-08-04T00:00:00.000Z"),
    ];
    const r2 = [
      doc("X", "2026-08-01T00:00:00.000Z"),
      doc("Y", "2026-08-02T00:00:00.000Z"),
      doc("B", "2026-08-04T00:00:00.000Z"),
      doc("A", "2026-08-03T00:00:00.000Z"),
    ];
    const fused = rankFused([r1, r2]);
    expect(fused.map((f) => f.item.id)).toEqual(["X", "Y", "B", "A"]);
    expect(fused[2].rrf).toBeCloseTo(1 / 63 + 1 / 64, 12);
    expect(fused[3].rrf).toBeCloseTo(1 / 64 + 1 / 63, 12);
  });

  it("equal timestamps fall back to id ascending (deterministic)", () => {
    const sameTs = "2026-08-01T00:00:00.000Z";
    const fused = rankFused([
      [doc("A", sameTs), doc("B", sameTs)],
      [doc("B", sameTs), doc("A", sameTs)],
    ]);
    expect(fused.map((f) => f.item.id)).toEqual(["A", "B"]);
    expect(fused[0].score).toBeCloseTo(TWO_RETRIEVER_MAX, 10);
  });

  it("a doc absent from one retriever keeps its other-side contribution", () => {
    const fused = rankFused([[doc("A")], [doc("A"), doc("B")]]);
    expect(fused.map((f) => f.item.id)).toEqual(["A", "B"]);
    // A = rank #1 in BOTH retrievers → 2/61 → normalized 1.0; B = rank #2
    // in the second retriever only → (1/62)/(2/61) = 61/124.
    expect(fused[0].score).toBe(1);
    expect(fused[1].score).toBeCloseTo(ONE_SIDE_RANK2, 10);
  });
});

describe("RETR-002: per-retriever top-k cap", () => {
  it("candidates beyond rank 20 in a retriever contribute nothing", () => {
    const many = Array.from({ length: 21 }, (_, i) =>
      doc(`d${i + 1}`, `2026-08-01T00:00:${String(i).padStart(2, "0")}.000Z`),
    );
    const fused = rankFused([many, []]);
    // Only the top 20 of the single retriever survive.
    expect(fused).toHaveLength(FUSION_TOP_K);
    expect(fused.map((f) => f.item.id)).not.toContain("d21");
    expect(fused[0].item.id).toBe("d1");
    // Single active retriever: rank #1 → 1.0, rank #20 → 61/80.
    expect(fused[0].score).toBe(1);
    expect(fused[FUSION_TOP_K - 1].score).toBeCloseTo(61 / 80, 10);
  });

  it("a rank-21 contribution is not counted even when the other retriever ranks the doc", () => {
    const many = Array.from({ length: 21 }, (_, i) =>
      doc(`d${i + 1}`, `2026-08-01T00:00:${String(i).padStart(2, "0")}.000Z`),
    );
    // d21 is rank 1 in retriever 2 but rank 21 in retriever 1 (beyond the
    // cap) — its fused score must reflect ONLY the retriever-2 rank.
    const fused = rankFused([many, [doc("d21", "2026-08-02T00:00:00.000Z")]]);
    const d21 = fused.find((f) => f.item.id === "d21")!;
    // If the rank-21 contribution were (wrongly) counted: rrf = 1/61+1/81
    // → score ≈ 0.8765. With only the rank-1 contribution: (1/61)/(2/61).
    expect(d21.score).toBeCloseTo(0.5, 10);
    expect(d21.rrf).toBeCloseTo(1 / 61, 12);
  });
});

describe("RETR-002: normalization and edge cases", () => {
  it("rank #1 in every active retriever → score 1.0", () => {
    const fused = rankFused([
      [doc("A"), doc("B")],
      [doc("A"), doc("B")],
    ]);
    expect(fused[0].item.id).toBe("A");
    expect(fused[0].score).toBe(1);
    expect(fused[1].score).toBeCloseTo(61 / 62, 10);
  });

  it("empty retrievers are ignored for the normalization ceiling", () => {
    const fused = rankFused([[doc("A")], []]);
    expect(fused).toHaveLength(1);
    expect(fused[0].item.id).toBe("A");
    expect(fused[0].score).toBe(1);
    expect(rankFused([[], []])).toEqual([]);
  });

  it("single retriever re-ranks unchanged (order + relative scores)", () => {
    const fused = rankFused([[doc("A"), doc("B"), doc("C")]]);
    expect(fused.map((f) => f.item.id)).toEqual(["A", "B", "C"]);
    expect(fused[0].score).toBe(1);
    expect(fused[1].score).toBeCloseTo(61 / 62, 10);
    expect(fused[2].score).toBeCloseTo(61 / 63, 10);
  });

  it("honors custom rrfK and topK options", () => {
    const fused = rankFused([[doc("A"), doc("B")]], { rrfK: 1, topK: 1 });
    expect(fused).toHaveLength(1);
    expect(fused[0].item.id).toBe("A");
    expect(fused[0].score).toBe(1);
  });

  it("exposes the spec constants (rrf_k=60, top-k=20)", () => {
    expect(RRF_K).toBe(60);
    expect(FUSION_TOP_K).toBe(20);
    expect(RRF_EPSILON).toBeGreaterThan(0);
  });
});

describe("RETR-005: recency through fusion", () => {
  it("equal-cosine fixtures (semantic leg already recency-ordered) keep newest first", () => {
    // RETR-005 chain: semanticSearch breaks equal-cosine ties by recency,
    // so the semantic leg arrives as [fresh, old] at the same similarity.
    // A keyword leg that ranks them identically (equal BM25, recency tie)
    // must fuse to the same order — the fresh memory stays on top.
    const fresh = doc("fresh", "2026-08-10T00:00:00.000Z");
    const old = doc("old", "2026-08-01T00:00:00.000Z");
    const fused = rankFused([
      [fresh, old], // equal cosine, recency-ordered
      [fresh, old], // equal BM25, recency-ordered
    ]);
    expect(fused.map((f) => f.item.id)).toEqual(["fresh", "old"]);
    expect(fused[0].score).toBe(1); // rank #1 in both retrievers
    expect(fused[1].score).toBeCloseTo(61 / 62, 10);
  });

  it("fused exact ties resolve by recency regardless of input list order", () => {
    // Same rank TUPLE, swapped retrievers → identical RRF sums → the
    // comparator must settle the tie by timestamp, not by whichever doc
    // appeared first in the input (a caller may feed an unordered list).
    const fresh = doc("fresh", "2026-08-10T00:00:00.000Z");
    const old = doc("old", "2026-08-01T00:00:00.000Z");
    const fused = rankFused([
      [old, fresh], // equal similarity, older doc listed first
      [fresh, old], // equal similarity, newer doc listed first
    ]);
    expect(fused.map((f) => f.item.id)).toEqual(["fresh", "old"]);
    // Both are an exact RRF tie — same raw sum from swapped rank tuples.
    expect(fused[0].rrf).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(fused[1].rrf).toBeCloseTo(1 / 62 + 1 / 61, 12);
  });

  it("a fresh equal-similarity doc outranks an old one even when only one retriever sees it", () => {
    // Hybrid reality: the keyword leg may MISS the fresh doc (e.g. its
    // tokens are stopwords) while the semantic leg ties both at rank 1.
    // rankFused must not let the older doc's other-retriever contribution
    // flip the semantic recency decision.
    const fresh = doc("fresh", "2026-08-10T00:00:00.000Z");
    const old = doc("old", "2026-08-01T00:00:00.000Z");
    const fused = rankFused([
      [fresh, old], // equal cosine, recency-ordered semantic leg
      [], // keyword leg found nothing (stopword query)
    ]);
    expect(fused.map((f) => f.item.id)).toEqual(["fresh", "old"]);
    expect(fused[0].score).toBe(1);
    expect(fused[1].score).toBeCloseTo(61 / 62, 10);
  });
});

describe("RETR-002: generic payload passthrough", () => {
  it("keeps the full item payload (extra fields survive fusion)", () => {
    const itemA: FusionRetrieverItem & { snippet: string } = {
      id: "A",
      timestamp: "2026-08-01T00:00:00.000Z",
      snippet: "…alpha one discussion…",
    };
    const fused = rankFused([[itemA]]);
    expect(fused[0].item.snippet).toBe("…alpha one discussion…");
    expect(fused[0].score).toBe(1);
  });
});
