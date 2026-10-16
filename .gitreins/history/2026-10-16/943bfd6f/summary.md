# Verdict: DF-1013-04

**Task:** Fix concurrent FTS sidecar rebuild corruption
**Evaluated:** 2026-10-16T05:18:44.930371
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ Concurrent rebuildNamespaceIndex calls corrupt the FTS cache: 53 of 813 sidecars came out EMPTY. Add per-namespace rebuild lock (or serialize rebuilds) so parallel invocations cannot interleave writes to the same .search/ index files. PASS: (1) concurrent rebuild test (Promise.all on 5+ namespaces) produces non-empty indexes for all; (2) existing search tests still pass; (3) full suite + tsc clean + guard PASS.: Fix in commit 74bae7bf, src/search/index.ts: module-level `const rebuildInFlight = new Map<string, Promise<IndexMeta>>()` keyed by `path.resolve(namespacePath)`; `rebuildNamespaceIndex` (line ~416) returns the owner's in-flight promise to joiners and clears the entry in `.finally()` only if still owner, so N concurrent same-namespace calls cost one wipe/build/rename. Cross-process serialization via `.search.rebuild.lock` (REBUILD_LOCK_NAME, line 68) held by `acquireRebuildLockAndRebuild`; `inFlightRebuildNamespaces()` exported (line 401). (1) Test src/search/concurrent-rebuild-df101304.test.ts lines 176-184: `Promise.all(Array.from({length:5}, () => rebuildNamespaceIndex(nsPath)))` asserts rowCount=2 for all and inspectSidecar memories=true/ftsSchema=true/rowCount=2; lines 231-240 assert 5 concurrent callers share ONE rebuild (inFlightRebuildNamespaces()==[resolved path], identical meta objects); lines 253-300 assert 3 different namespaces rebuild concurrently with each sidecar complete. Ran `npx vitest run src/search/concurrent-rebuild-df101304.test.ts` => EXIT=0, 'Test Files 1 passed (1), Tests 9 passed (9)'. (2) `npx vitest run src/search/` => EXIT=0, 'Test Files 9 passed (9), Tests 96 passed (96)'. (3) `npx tsc --noEmit` => EXIT=0 (clean, no output). `gitreins guard --full` => 'Tier 1 Guards: PASS (test mode: full, whole tree)', tests(full) lane exit_code=0, 'Test Files 225 passed (225), Tests 1876 passed (1876)'. (A standalone `npx vitest run` under loadavg 53-69 showed 6-17 15s-timeout failures in unrelated files — ddl-*, namespace-warmup-aug096, memories-dogfood010, embedding/search-concurrency; all 6 files pass in isolation 'Test Files 6 passed (6), Tests 20 passed (20)', and the guard's full run is green, confirming load-induced flakiness, not this change.)


## Summary

Judge Result: DF-1013-04

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ Concurrent rebuildNamespaceIndex calls corrupt the FTS cache: 53 of 813 sidecars came out EMPTY. Add per-namespace rebuild lock (or serialize rebuilds) so parallel invocations cannot interleave writes to the same .search/ index files. PASS: (1) concurrent rebuild test (Promise.all on 5+ namespaces) produces non-empty indexes for all; (2) existing search tests still pass; (3) full suite + tsc clean + guard PASS.: Fix in commit 74bae7bf, src/search/index.ts: module-level `const rebuildInFlight = new Map<string, Promise<IndexMeta>>()` keyed by `path.resolve(namespacePath)`; `rebuildNamespaceIndex` (line ~416) returns the owner's in-flight promise to joiners and clears the entry in `.finally()` only if still owner, so N concurrent same-namespace calls cost one wipe/build/rename. Cross-process serialization via `.search.rebuild.lock` (REBUILD_LOCK_NAME, line 68) held by `acquireRebuildLockAndRebuild`; `inFlightRebuildNamespaces()` exported (line 401). (1) Test src/search/concurrent-rebuild-df101304.test.ts lines 176-184: `Promise.all(Array.from({length:5}, () => rebuildNamespaceIndex(nsPath)))` asserts rowCount=2 for all and inspectSidecar memories=true/ftsSchema=true/rowCount=2; lines 231-240 assert 5 concurrent callers share ONE rebuild (inFlightRebuildNamespaces()==[resolved path], identical meta objects); lines 253-300 assert 3 different namespaces rebuild concurrently with each sidecar complete. Ran `npx vitest run src/search/concurrent-rebuild-df101304.test.ts` => EXIT=0, 'Test Files 1 passed (1), Tests 9 passed (9)'. (2) `npx vitest run src/search/` => EXIT=0, 'Test Files 9 passed (9), Tests 96 passed (96)'. (3) `npx tsc --noEmit` => EXIT=0 (clean, no output). `gitreins guard --full` => 'Tier 1 Guards: PASS (test mode: full, whole tree)', tests(full) lane exit_code=0, 'Test Files 225 passed (225), Tests 1876 passed (1876)'. (A standalone `npx vitest run` under loadavg 53-69 showed 6-17 15s-timeout failures in unrelated files — ddl-*, namespace-warmup-aug096, memories-dogfood010, embedding/search-concurrency; all 6 files pass in isolation 'Test Files 6 passed (6), Tests 20 passed (20)', and the guard's full run is green, confirming load-induced flakiness, not this change.)


Overall: FAIL ✗
