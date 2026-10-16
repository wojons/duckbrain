# Verdict: DF-1013-04

**Task:** Fix concurrent FTS sidecar rebuild corruption
**Evaluated:** 2026-10-16T06:32:44.529765
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ Concurrent rebuildNamespaceIndex calls corrupt the FTS cache: 53 of 813 sidecars came out EMPTY. Add per-namespace rebuild lock (or serialize rebuilds) so parallel invocations cannot interleave writes to the same .search/ index files. PASS: (1) concurrent rebuild test (Promise.all on 5+ namespaces) produces non-empty indexes for all; (2) existing search tests still pass; (3) full suite + tsc clean + guard PASS.: Implementation: src/search/index.ts:417-430 rebuildNamespaceIndex uses a module-level Map `rebuildInFlight` keyed by path.resolve(namespacePath) for in-process single-flight (joiners reuse the owner's promise), and acquireRebuildLockAndRebuild takes a cross-process lock file REBUILD_LOCK_NAME=".search.rebuild.lock" via openSync(lockPath,"wx") (O_CREAT|O_EXCL) placed in the namespace ROOT (outside the wiped .search/ dir) with a stale-dead-pid reaper — exactly the requested per-namespace rebuild lock. (1) Test src/search/concurrent-rebuild-df101304.test.ts: 'N=5 concurrent rebuilds all report full rowCount and one complete sidecar' does Promise.all of 5 rebuildNamespaceIndex calls and asserts each meta.rowCount===2 plus inspectSidecar memories=true/ftsSchema=true/rowCount=2 (non-empty); 'N concurrent callers for ONE namespace share one rebuild' asserts inFlightRebuildNamespaces()===[resolved path] and a real keywordSearch hit; 'rebuilds of DIFFERENT namespaces run concurrently' does Promise.all over 3 distinct namespaces each with a complete sidecar. Ran `npx vitest run src/search/concurrent-rebuild-df101304.test.ts` -> Test Files 1 passed (1), Tests 9 passed (9), exit 0. (2) Ran `npx vitest run src/search/` -> Test Files 9 passed (9), Tests 96 passed (96), exit 0. (3) Ran `npx tsc --noEmit` -> exit 0, clean. Guard log .gitreins/logs/guard-20261016T051747.864285Z.log (run 2026-10-16T05:17:47Z, after commit 74bae7bf and after task completion 05:03:38Z): overall: PASS; [PASS] tests (full) exit_code=0; 'Test Files 225 passed (225)'; 'Tests 1876 passed (1876)'; secrets clean. Minor: the criterion's literal 'Promise.all on 5+ namespaces' is met as 5 concurrent calls to one namespace plus 3 distinct namespaces (no single test uses 5+ distinct namespaces), but the intent — non-empty indexes for all under concurrency — is fully verified.
Per-namespace rebuild lock (in-process single-flight map + cross-process .search.rebuild.lock) is implemented and verified: concurrent-rebuild test 9/9 pass, search suite 96/96 pass, tsc clean, and the post-commit guard run shows full suite 225 files/1876 tests PASS.

## Summary

Judge Result: DF-1013-04

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ Concurrent rebuildNamespaceIndex calls corrupt the FTS cache: 53 of 813 sidecars came out EMPTY. Add per-namespace rebuild lock (or serialize rebuilds) so parallel invocations cannot interleave writes to the same .search/ index files. PASS: (1) concurrent rebuild test (Promise.all on 5+ namespaces) produces non-empty indexes for all; (2) existing search tests still pass; (3) full suite + tsc clean + guard PASS.: Implementation: src/search/index.ts:417-430 rebuildNamespaceIndex uses a module-level Map `rebuildInFlight` keyed by path.resolve(namespacePath) for in-process single-flight (joiners reuse the owner's promise), and acquireRebuildLockAndRebuild takes a cross-process lock file REBUILD_LOCK_NAME=".search.rebuild.lock" via openSync(lockPath,"wx") (O_CREAT|O_EXCL) placed in the namespace ROOT (outside the wiped .search/ dir) with a stale-dead-pid reaper — exactly the requested per-namespace rebuild lock. (1) Test src/search/concurrent-rebuild-df101304.test.ts: 'N=5 concurrent rebuilds all report full rowCount and one complete sidecar' does Promise.all of 5 rebuildNamespaceIndex calls and asserts each meta.rowCount===2 plus inspectSidecar memories=true/ftsSchema=true/rowCount=2 (non-empty); 'N concurrent callers for ONE namespace share one rebuild' asserts inFlightRebuildNamespaces()===[resolved path] and a real keywordSearch hit; 'rebuilds of DIFFERENT namespaces run concurrently' does Promise.all over 3 distinct namespaces each with a complete sidecar. Ran `npx vitest run src/search/concurrent-rebuild-df101304.test.ts` -> Test Files 1 passed (1), Tests 9 passed (9), exit 0. (2) Ran `npx vitest run src/search/` -> Test Files 9 passed (9), Tests 96 passed (96), exit 0. (3) Ran `npx tsc --noEmit` -> exit 0, clean. Guard log .gitreins/logs/guard-20261016T051747.864285Z.log (run 2026-10-16T05:17:47Z, after commit 74bae7bf and after task completion 05:03:38Z): overall: PASS; [PASS] tests (full) exit_code=0; 'Test Files 225 passed (225)'; 'Tests 1876 passed (1876)'; secrets clean. Minor: the criterion's literal 'Promise.all on 5+ namespaces' is met as 5 concurrent calls to one namespace plus 3 distinct namespaces (no single test uses 5+ distinct namespaces), but the intent — non-empty indexes for all under concurrency — is fully verified.
Per-namespace rebuild lock (in-process single-flight map + cross-process .search.rebuild.lock) is implemented and verified: concurrent-rebuild test 9/9 pass, search suite 96/96 pass, tsc clean, and the post-commit guard run shows full suite 225 files/1876 tests PASS.

Overall: PASS ✓
