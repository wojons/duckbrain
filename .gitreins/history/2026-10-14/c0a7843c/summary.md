# Verdict: DF-1013-02

**Task:** corrupt manifest graded as warmup failure
**Evaluated:** 2026-10-14T14:01:30.217675
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ namespace with unparseable manifest.json reports failed/skipped at warm-up, counted in skipped total, corrupt-manifest test cell green: src/http/namespace-warmup.ts:203-215: a PRESENT but unparseable manifest.json throws `manifest.json is corrupt (unparseable): ...`, caught by the outer handler (lines 240-250) which evicts the half-open connection and returns warmed:false + error. logNamespaceWarmup (lines 418-420) emits `[duckbrain] Namespace warm-up: namespace 'X' failed in Nms and was skipped: <error>` and the summary line (line 443) counts failures in the `N skipped` total with `X=0ms SKIPPED` in the detail list. Tests: src/http/namespace-warmup-aug096.test.ts:372-381 asserts warmed:false, scanned:false, error contains 'manifest.json is corrupt', connection evicted; :384-419 asserts exactly one 'failed in ... skipped' line naming the namespace and that the summary line contains `${failureCount} skipped` plus `broken-ns=\d+ms SKIPPED`. Ran `npx vitest run src/http/namespace-warmup-aug096.test.ts` → exit_code 0, output `Test Files 1 passed (1) / Tests 16 passed (16)`; verbose reporter shows both `DF-1013-02: an unparseable manifest is a warm-up FAILURE (warmed:false, error, evicted)` and `DF-1013-02: a corrupt-manifest namespace logs one skipped line and counts in the skipped total` as ✓. Live log confirms: `19 namespace(s) warmed, 2 skipped, 2323ms total [broken-ns=0ms SKIPPED, ..., waraug-corrupt=0ms SKIPPED, ...]`. [resolution 0.29; manifest.json]
Corrupt manifest.json is now graded as a warm-up failure (warmed:false, error, connection evicted), logged as a skipped warning and counted in the skipped total, with both DF-1013-02 test cells green (16/16 passing).

## Summary

Judge Result: DF-1013-02

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ namespace with unparseable manifest.json reports failed/skipped at warm-up, counted in skipped total, corrupt-manifest test cell green: src/http/namespace-warmup.ts:203-215: a PRESENT but unparseable manifest.json throws `manifest.json is corrupt (unparseable): ...`, caught by the outer handler (lines 240-250) which evicts the half-open connection and returns warmed:false + error. logNamespaceWarmup (lines 418-420) emits `[duckbrain] Namespace warm-up: namespace 'X' failed in Nms and was skipped: <error>` and the summary line (line 443) counts failures in the `N skipped` total with `X=0ms SKIPPED` in the detail list. Tests: src/http/namespace-warmup-aug096.test.ts:372-381 asserts warmed:false, scanned:false, error contains 'manifest.json is corrupt', connection evicted; :384-419 asserts exactly one 'failed in ... skipped' line naming the namespace and that the summary line contains `${failureCount} skipped` plus `broken-ns=\d+ms SKIPPED`. Ran `npx vitest run src/http/namespace-warmup-aug096.test.ts` → exit_code 0, output `Test Files 1 passed (1) / Tests 16 passed (16)`; verbose reporter shows both `DF-1013-02: an unparseable manifest is a warm-up FAILURE (warmed:false, error, evicted)` and `DF-1013-02: a corrupt-manifest namespace logs one skipped line and counts in the skipped total` as ✓. Live log confirms: `19 namespace(s) warmed, 2 skipped, 2323ms total [broken-ns=0ms SKIPPED, ..., waraug-corrupt=0ms SKIPPED, ...]`. [resolution 0.29; manifest.json]
Corrupt manifest.json is now graded as a warm-up failure (warmed:false, error, connection evicted), logged as a skipped warning and counted in the skipped total, with both DF-1013-02 test cells green (16/16 passing).

Overall: PASS ✓
