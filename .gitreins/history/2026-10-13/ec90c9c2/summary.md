# Verdict: AUG-096

**Task:** namespace-scoped semantic query 3.6-5s vs 0.1-0.2s unscoped — warm the per-namespace DuckDB scratch connection at boot
**Evaluated:** 2026-10-13T10:52:27.147605
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: scanners: nice=nice -n 10
- ✗ **tier2**
  - INCOMPLETE
  ✗ GET /api/memories?namespace=X&q= on a namespace with zero prior traffic must not pay a >1s cold-scan penalty vs the same query unscoped; warm-up covers all manifest namespaces; tests cover warm-up + no regression on scoped/unscoped search: Implementation is present and plausible: src/http/namespace-warmup.ts warmNamespace() creates the singleton DuckDB connection, forces a limit-1 partition scan, runs the SAME ensureFreshIndex seam the ?q= path calls (src/search/query.ts:382 keywordSearch), and inits EmbeddingCache.forNamespace; wired fire-and-forget at src/cli/http.ts:1129 startNamespaceWarmup() after listen(); enumeration uses listNamespaces (manifest.json dirs) primary + censusOnDiskNamespaces fallback, so all manifest namespaces are covered. The scoped ?q= E2E test (src/http/namespace-warmup-aug096.test.ts:444) passes in isolation (`npx vitest run ... -t "SCOPED"` -> 1 passed) and asserts autoBuildCount/indexedAt/fts.duckdb mtime unchanged + no rows.tmp.jsonl. HOWEVER the criterion's test requirement is not met: (1) the delivered test file is reproducibly FLAKY — `npx vitest run src/http/namespace-warmup-aug096.test.ts` gave 15/15 pass on run 1 but 13 passed | 2 failed on runs 2, 3 and 4; the failures are 'per-namespace timeout knob...' (AssertionError expected false to be true at line 611, waraug-quick.warmed) and 'concurrency knob is honored...' (Test timed out in 15000ms at line 617), caused by the 1500ms DUCKBRAIN_WARM_PER_NAMESPACE_TIMEOUT_MS bound sitting below real DuckDB warm-up latency (log: waraug-quick=1500ms SKIPPED). The broader run `npx vitest run src/http src/search src/duckdb` -> Test Files 1 failed | 73 passed (74); Tests 2 failed | 604 passed (606), the only failures being these 2 new tests. (2) There is NO unscoped-search test in the new file — grep for 'unscoped'/'regression' in src/http/namespace-warmup-aug096.test.ts returns nothing; only the scoped leg is covered by this change's tests, so 'no regression on scoped/unscoped search' is not covered as required. (3) No test asserts startHttpMode actually wires startNamespaceWarmup at boot.
Warm-up implementation and scoped E2E test exist and the scoped test passes, but the criterion fails because the new test file is reproducibly flaky (2/15 fail in 3 of 4 runs, including the broader suite) and contains no unscoped-search regression test.

## Summary

Judge Result: AUG-096

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: scanners: nice=nice -n 10

Stage tier2: FAIL
  INCOMPLETE
  ✗ GET /api/memories?namespace=X&q= on a namespace with zero prior traffic must not pay a >1s cold-scan penalty vs the same query unscoped; warm-up covers all manifest namespaces; tests cover warm-up + no regression on scoped/unscoped search: Implementation is present and plausible: src/http/namespace-warmup.ts warmNamespace() creates the singleton DuckDB connection, forces a limit-1 partition scan, runs the SAME ensureFreshIndex seam the ?q= path calls (src/search/query.ts:382 keywordSearch), and inits EmbeddingCache.forNamespace; wired fire-and-forget at src/cli/http.ts:1129 startNamespaceWarmup() after listen(); enumeration uses listNamespaces (manifest.json dirs) primary + censusOnDiskNamespaces fallback, so all manifest namespaces are covered. The scoped ?q= E2E test (src/http/namespace-warmup-aug096.test.ts:444) passes in isolation (`npx vitest run ... -t "SCOPED"` -> 1 passed) and asserts autoBuildCount/indexedAt/fts.duckdb mtime unchanged + no rows.tmp.jsonl. HOWEVER the criterion's test requirement is not met: (1) the delivered test file is reproducibly FLAKY — `npx vitest run src/http/namespace-warmup-aug096.test.ts` gave 15/15 pass on run 1 but 13 passed | 2 failed on runs 2, 3 and 4; the failures are 'per-namespace timeout knob...' (AssertionError expected false to be true at line 611, waraug-quick.warmed) and 'concurrency knob is honored...' (Test timed out in 15000ms at line 617), caused by the 1500ms DUCKBRAIN_WARM_PER_NAMESPACE_TIMEOUT_MS bound sitting below real DuckDB warm-up latency (log: waraug-quick=1500ms SKIPPED). The broader run `npx vitest run src/http src/search src/duckdb` -> Test Files 1 failed | 73 passed (74); Tests 2 failed | 604 passed (606), the only failures being these 2 new tests. (2) There is NO unscoped-search test in the new file — grep for 'unscoped'/'regression' in src/http/namespace-warmup-aug096.test.ts returns nothing; only the scoped leg is covered by this change's tests, so 'no regression on scoped/unscoped search' is not covered as required. (3) No test asserts startHttpMode actually wires startNamespaceWarmup at boot.
Warm-up implementation and scoped E2E test exist and the scoped test passes, but the criterion fails because the new test file is reproducibly flaky (2/15 fail in 3 of 4 runs, including the broader suite) and contains no unscoped-search regression test.

Overall: FAIL ✗
