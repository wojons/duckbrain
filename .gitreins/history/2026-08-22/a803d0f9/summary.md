# Verdict: DB-GAP-036

**Task:** Semantic endpoints 503 when embeddings down
**Evaluated:** 2026-08-22T00:03:29.707700
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m7:02PM[0m [32mINF[0m [1mscanned ~12243396 bytes (12.24 MB) in 4.07s[0m
[90m7:02PM[0m [3
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s
- ✓ **tier2**
  - COMPLETE
  ✓ GET /api/memories?q= returns HTTP 503 with explicit embeddings-down message when no embedding provider is healthy; still 200 with items when >=1 provider healthy; /health keeps per-provider embedding block; README documents embedding prerequisites; suite green: Implemented in commit a9c6561. (1) src/http/routes/memories.ts: throwRecallError() maps embeddings-down errors (prefixes 'Semantic search requires an embedding provider' / 'Embedding generation failed') to ApiError(error, 503, 'EMBEDDINGS_UNAVAILABLE'); test memories-dogfood001.test.ts asserts status 503, body.code 'EMBEDDINGS_UNAVAILABLE', explicit message, items undefined. (2) 200-with-items path preserved: memories-dogfood001.test.ts:113-127 asserts status 200 + items on successful semantic recall. (3) /health keeps per-provider embedding block: src/cli/http.ts:120-156 returns embedding block with providers[] (id/healthy/note) — untouched by this commit. (4) README.md:188 documents prerequisites & 503 EMBEDDINGS_UNAVAILABLE behavior. (5) Suite green: `npx vitest run` exit 0 — 92 test files / 788 tests passed.
DB-GAP-036 fully implemented and verified: semantic endpoints return 503 EMBEDDINGS_UNAVAILABLE when embeddings down, 200 with items when healthy, /health per-provider block intact, README documents prerequisites, and the full 788-test suite passes.

## Summary

Judge Result: DB-GAP-036

Stage tier1: PASS
    ✓ secrets: [90m7:02PM[0m [32mINF[0m [1mscanned ~12243396 bytes (12.24 MB) in 4.07s[0m
[90m7:02PM[0m [3
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s

Stage tier2: PASS
  COMPLETE
  ✓ GET /api/memories?q= returns HTTP 503 with explicit embeddings-down message when no embedding provider is healthy; still 200 with items when >=1 provider healthy; /health keeps per-provider embedding block; README documents embedding prerequisites; suite green: Implemented in commit a9c6561. (1) src/http/routes/memories.ts: throwRecallError() maps embeddings-down errors (prefixes 'Semantic search requires an embedding provider' / 'Embedding generation failed') to ApiError(error, 503, 'EMBEDDINGS_UNAVAILABLE'); test memories-dogfood001.test.ts asserts status 503, body.code 'EMBEDDINGS_UNAVAILABLE', explicit message, items undefined. (2) 200-with-items path preserved: memories-dogfood001.test.ts:113-127 asserts status 200 + items on successful semantic recall. (3) /health keeps per-provider embedding block: src/cli/http.ts:120-156 returns embedding block with providers[] (id/healthy/note) — untouched by this commit. (4) README.md:188 documents prerequisites & 503 EMBEDDINGS_UNAVAILABLE behavior. (5) Suite green: `npx vitest run` exit 0 — 92 test files / 788 tests passed.
DB-GAP-036 fully implemented and verified: semantic endpoints return 503 EMBEDDINGS_UNAVAILABLE when embeddings down, 200 with items when healthy, /health per-provider block intact, README documents prerequisites, and the full 788-test suite passes.

Overall: PASS ✓
