# Verdict: PERF-013

**Task:** P2 batch embed: add embedMany to openai/lmstudio providers
**Evaluated:** 2026-10-20T12:52:27.640984
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ Give the openai/lmstudio providers a batch embed (only ollama exposes embedMany today at src/embedding/providers.ts), then npx vitest run src/embedding/providers-dogfood002.test.ts must exit 0 including the new embedMany batch test, and a live DUCKBRAIN_SEARCH_TIMING=1 curl must log a [search-timing] line containing batch_supported=true.: (1) Implementation: src/embedding/providers.ts adds makeHttpBatchEmbed (line 151) and wires embedMany into lmstudio (line 410) and openai (line 511); ollama retains makeOllamaBatchEmbed (line 460); interface declares embedMany? at line 31. (2) Tests: `npx vitest run src/embedding/providers-dogfood002.test.ts` -> EXIT_CODE=0, 'Test Files 1 passed (1)', 'Tests 26 passed (26)'; batch-specific verbose run shows 'sends OpenAI-compatible batch embed and preserves input order' PASS and 'sends LM Studio batch embed and preserves input order' PASS (plus reject-incomplete variants for both). (3) Live curl: rebuilt dist via `npx tsc -p tsconfig.build.json` (BUILD_EXIT=0; dist/src/embedding/providers.js then contains 3 embedMany entries at lines 262/300/338), started server with DUCKBRAIN_SEARCH_TIMING=1 on :3999, `curl 'http://localhost:3999/api/memories?q=embedding%20provider&limit=2&debug=search'` -> HTTP=200 and stderr logged '[search-timing] cache_candidates=100 cache_hits=20 unique_misses=2 miss_text_chars=1365 max_miss_text_chars=1204 batch_supported=true candidate_cache_ms=12.1 candidate_embed_ms=1906.7 scoring_ms=4.6'. Note: the pre-existing dist build was stale (only ollama had embedMany) and the long-running :3000 daemon predates the change, so the live check required a rebuild — after which it passes. [resolution 0.00; src/embedding/providers.ts, src/embedding/providers-dogfood002.test.ts]
openai and lmstudio now expose embedMany via makeHttpBatchEmbed, the dogfood002 suite exits 0 with 26 passing tests including the new batch tests, and a live DUCKBRAIN_SEARCH_TIMING=1 curl logs batch_supported=true.

## Summary

Judge Result: PERF-013

Stage tier1: FAIL
    ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ Give the openai/lmstudio providers a batch embed (only ollama exposes embedMany today at src/embedding/providers.ts), then npx vitest run src/embedding/providers-dogfood002.test.ts must exit 0 including the new embedMany batch test, and a live DUCKBRAIN_SEARCH_TIMING=1 curl must log a [search-timing] line containing batch_supported=true.: (1) Implementation: src/embedding/providers.ts adds makeHttpBatchEmbed (line 151) and wires embedMany into lmstudio (line 410) and openai (line 511); ollama retains makeOllamaBatchEmbed (line 460); interface declares embedMany? at line 31. (2) Tests: `npx vitest run src/embedding/providers-dogfood002.test.ts` -> EXIT_CODE=0, 'Test Files 1 passed (1)', 'Tests 26 passed (26)'; batch-specific verbose run shows 'sends OpenAI-compatible batch embed and preserves input order' PASS and 'sends LM Studio batch embed and preserves input order' PASS (plus reject-incomplete variants for both). (3) Live curl: rebuilt dist via `npx tsc -p tsconfig.build.json` (BUILD_EXIT=0; dist/src/embedding/providers.js then contains 3 embedMany entries at lines 262/300/338), started server with DUCKBRAIN_SEARCH_TIMING=1 on :3999, `curl 'http://localhost:3999/api/memories?q=embedding%20provider&limit=2&debug=search'` -> HTTP=200 and stderr logged '[search-timing] cache_candidates=100 cache_hits=20 unique_misses=2 miss_text_chars=1365 max_miss_text_chars=1204 batch_supported=true candidate_cache_ms=12.1 candidate_embed_ms=1906.7 scoring_ms=4.6'. Note: the pre-existing dist build was stale (only ollama had embedMany) and the long-running :3000 daemon predates the change, so the live check required a rebuild — after which it passes. [resolution 0.00; src/embedding/providers.ts, src/embedding/providers-dogfood002.test.ts]
openai and lmstudio now expose embedMany via makeHttpBatchEmbed, the dogfood002 suite exits 0 with 26 passing tests including the new batch tests, and a live DUCKBRAIN_SEARCH_TIMING=1 curl logs batch_supported=true.

Overall: FAIL ✗
