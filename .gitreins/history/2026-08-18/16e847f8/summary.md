# Verdict: RETR-002

**Task:** Hybrid fusion BM25+semantic+RRF (Q-2)
**Evaluated:** 2026-08-18T19:11:02.318175
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: 
    ○
    │╲
    │ ○
    ○ ░
    ░    gitleaks

[90m2:08PM[0m [32mINF[0m [1mscanned ~11561947 
  ✓ lint: 
  ✓ tests: 
> duckbrain@1.0.0 test
> vitest


[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/k
- ✓ **tier2**
  - COMPLETE
  ✓ Hybrid recall: fuse RETR-001 keyword hits with embedding-cache cosine scores via Reciprocal Rank Fusion (rrf_k=60, per-retriever top-k=20), recency tiebreak; shared rankFused() in search layer; recall ?q= becomes hybrid by default. PASS: hybrid beats semantic-only and keyword-only on a 20-query fixture set; ?q= still returns items[].score; 0.25 floor preserved for semantic-only mode; full suite green.: src/search/fusion.ts exports shared rankFused() with RRF_K=60 and FUSION_TOP_K=20, capping each retriever at its top 20 and sorting by RRF sum desc, then timestamp desc (recency tiebreak), then id asc (verified in 13/13 unit tests in fusion-retr002.test.ts). src/mcp/tools/recall.ts imports { rankFused, FUSION_TOP_K } and makes ?q= hybrid by default: both legs available -> RRF fusion; FTS missing -> semantic-only with unchanged cosine scores; embeddings unavailable -> keyword-only; both fail -> legacy semantic error. E2E memories-hybrid-retr002.test.ts (9/9 passed) proves hybrid MRR 1.0 > semantic 0.75 / keyword 0.75 on the 20-query fixture (10 dual-leg + 5 keyword-only + 5 stopword), asserts ?q= returns items[].score (a1.score===1, fused 61/124 and 61/126, snippet rides along), and confirms the 0.25 floor (DEFAULT_MIN_SCORE=0.25, src/embedding/search.ts:35) still filters in semantic-only/hybrid modes (garbage query -> []). Full suite green: npx vitest run -> 63 files / 487 tests passed; tsc --noEmit exit 0; prettier --check clean; LSP diagnostics empty.
All RETR-002 requirements verified against code and green test runs: RRF fusion (k=60, top-k=20, recency tiebreak) via shared rankFused() in src/search/fusion.ts, ?q= hybrid by default in recall.ts, hybrid MRR 1.0 beating single-retriever 0.75 on the 20-query fixture, items[].score preserved, 0.25 floor intact, full suite (487 tests) green.

## Summary

Judge Result: RETR-002

Stage tier1: PASS
    ✓ secrets: 
    ○
    │╲
    │ ○
    ○ ░
    ░    gitleaks

[90m2:08PM[0m [32mINF[0m [1mscanned ~11561947 
  ✓ lint: 
  ✓ tests: 
> duckbrain@1.0.0 test
> vitest


[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/k

Stage tier2: PASS
  COMPLETE
  ✓ Hybrid recall: fuse RETR-001 keyword hits with embedding-cache cosine scores via Reciprocal Rank Fusion (rrf_k=60, per-retriever top-k=20), recency tiebreak; shared rankFused() in search layer; recall ?q= becomes hybrid by default. PASS: hybrid beats semantic-only and keyword-only on a 20-query fixture set; ?q= still returns items[].score; 0.25 floor preserved for semantic-only mode; full suite green.: src/search/fusion.ts exports shared rankFused() with RRF_K=60 and FUSION_TOP_K=20, capping each retriever at its top 20 and sorting by RRF sum desc, then timestamp desc (recency tiebreak), then id asc (verified in 13/13 unit tests in fusion-retr002.test.ts). src/mcp/tools/recall.ts imports { rankFused, FUSION_TOP_K } and makes ?q= hybrid by default: both legs available -> RRF fusion; FTS missing -> semantic-only with unchanged cosine scores; embeddings unavailable -> keyword-only; both fail -> legacy semantic error. E2E memories-hybrid-retr002.test.ts (9/9 passed) proves hybrid MRR 1.0 > semantic 0.75 / keyword 0.75 on the 20-query fixture (10 dual-leg + 5 keyword-only + 5 stopword), asserts ?q= returns items[].score (a1.score===1, fused 61/124 and 61/126, snippet rides along), and confirms the 0.25 floor (DEFAULT_MIN_SCORE=0.25, src/embedding/search.ts:35) still filters in semantic-only/hybrid modes (garbage query -> []). Full suite green: npx vitest run -> 63 files / 487 tests passed; tsc --noEmit exit 0; prettier --check clean; LSP diagnostics empty.
All RETR-002 requirements verified against code and green test runs: RRF fusion (k=60, top-k=20, recency tiebreak) via shared rankFused() in src/search/fusion.ts, ?q= hybrid by default in recall.ts, hybrid MRR 1.0 beating single-retriever 0.75 on the 20-query fixture, items[].score preserved, 0.25 floor intact, full suite (487 tests) green.

Overall: PASS ✓
