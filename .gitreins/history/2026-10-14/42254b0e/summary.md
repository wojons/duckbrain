# Verdict: DF-1013-02

**Task:** corrupt manifest graded as warmup failure
**Evaluated:** 2026-10-14T13:51:57.516350
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: scanners: nice=nice -n 10
- ✗ **tier2**
  - INCOMPLETE
  ✗ namespace with unparseable manifest.json reports failed/skipped at warm-up, counted in skipped total, corrupt-manifest test cell green: The fix is NOT present in the evaluated working tree. HEAD is c95dd5e0 (main); `git merge-base --is-ancestor 83b3e0f2 HEAD` returns NO — commit 83b3e0f2 'fix(df-1013-02): corrupt manifest graded as warmup failure (not warmed)' exists only on the unmerged branch wt/DF-1013-02 (worktree /home/kara/worktrees/duckbrain-DF-1013-02). In the evaluated tree, src/http/namespace-warmup.ts:203-207 still contains the OLD `catch { partitionPaths = []; }` (connection-only warm-up), and `grep -n 'manifest.json is corrupt' src/http/namespace-warmup.ts src/http/namespace-warmup-aug096.test.ts` exits 1 (no matches). Running `npx vitest run src/http/namespace-warmup-aug096.test.ts --reporter=verbose` on HEAD shows the old grading: log line 'waraug-corrupt=0ms connection-only idx=fresh' with '0 skipped' — the corrupt namespace is reported WARMED, not failed/skipped. The only corrupt-manifest test cell in the tree is the old one at src/http/namespace-warmup-aug096.test.ts:372 ('a corrupted manifest degrades to connection-only warm-up (no throw)') which asserts `result.warmed).toBe(true)` — the opposite of the criterion. For reference, on branch wt/DF-1013-02 the fix does work (16/16 tests pass; logs 'namespace \'broken-ns\' failed in 0ms and was skipped: manifest.json is corrupt (unparseable)' and '2 skipped ... broken-ns=0ms SKIPPED'), but that code was never merged into the evaluated tree, so the criterion is unmet here.
The DF-1013-02 fix (commit 83b3e0f2) lives only on the unmerged branch wt/DF-1013-02; the evaluated HEAD c95dd5e0 still grades a corrupt manifest as warmed with 0 skipped and its corrupt-manifest test asserts warmed:true, so the criterion fails.

## Summary

Judge Result: DF-1013-02

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: scanners: nice=nice -n 10

Stage tier2: FAIL
  INCOMPLETE
  ✗ namespace with unparseable manifest.json reports failed/skipped at warm-up, counted in skipped total, corrupt-manifest test cell green: The fix is NOT present in the evaluated working tree. HEAD is c95dd5e0 (main); `git merge-base --is-ancestor 83b3e0f2 HEAD` returns NO — commit 83b3e0f2 'fix(df-1013-02): corrupt manifest graded as warmup failure (not warmed)' exists only on the unmerged branch wt/DF-1013-02 (worktree /home/kara/worktrees/duckbrain-DF-1013-02). In the evaluated tree, src/http/namespace-warmup.ts:203-207 still contains the OLD `catch { partitionPaths = []; }` (connection-only warm-up), and `grep -n 'manifest.json is corrupt' src/http/namespace-warmup.ts src/http/namespace-warmup-aug096.test.ts` exits 1 (no matches). Running `npx vitest run src/http/namespace-warmup-aug096.test.ts --reporter=verbose` on HEAD shows the old grading: log line 'waraug-corrupt=0ms connection-only idx=fresh' with '0 skipped' — the corrupt namespace is reported WARMED, not failed/skipped. The only corrupt-manifest test cell in the tree is the old one at src/http/namespace-warmup-aug096.test.ts:372 ('a corrupted manifest degrades to connection-only warm-up (no throw)') which asserts `result.warmed).toBe(true)` — the opposite of the criterion. For reference, on branch wt/DF-1013-02 the fix does work (16/16 tests pass; logs 'namespace \'broken-ns\' failed in 0ms and was skipped: manifest.json is corrupt (unparseable)' and '2 skipped ... broken-ns=0ms SKIPPED'), but that code was never merged into the evaluated tree, so the criterion is unmet here.
The DF-1013-02 fix (commit 83b3e0f2) lives only on the unmerged branch wt/DF-1013-02; the evaluated HEAD c95dd5e0 still grades a corrupt manifest as warmed with 0 skipped and its corrupt-manifest test asserts warmed:true, so the criterion fails.

Overall: FAIL ✗
