# Verdict: INT-CI-035-R1

**Task:** INT-CI-035 recovery verification — keyword search off-by-one fix d761b9cc already merged to main
**Evaluated:** 2026-11-03T09:13:28.200214
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: scanners=gitleaks+builtin cross-check
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ Run from the canonical control root at the published HEAD 49583100: git merge-base --is-ancestor d761b9cc HEAD exits 0 proving the fix commit is reachable from the verified tree: Repo root /home/kara/duckbrain; `git rev-parse HEAD` = 4958310068be8ac4c1c1c7be31a4e4140d556161 (published HEAD 49583100). `git merge-base --is-ancestor d761b9cc HEAD` returned EXIT=0. `git log -1 d761b9cc` = 'd761b9cc fix(search): preserve keyword matches for exact ticket queries. Addresses INT-CI-035.' — fix commit is reachable from the verified tree.
  ✓ pnpm exec vitest run src/search/search-retr001.test.ts src/search/search-retr008.test.ts exits 0 with 2 test files and 31 tests passing, restoring the documented keyword hit counts: Fresh run: `pnpm exec vitest run src/search/search-retr001.test.ts src/search/search-retr008.test.ts` -> EXIT=0. Output: 'RUN v5.0.5 /home/kara/duckbrain', 'Test Files  2 passed (2)', 'Tests  31 passed (31)', Duration 2.34s. Exactly the required 2 files / 31 tests, all passing. [resolution 0.04; src/search/search-retr001.test.ts, src/search/search-retr008.test.ts]
  ✓ pnpm exec tsc --noEmit exits 0 on the merged tree: Fresh run at HEAD 49583100: `pnpm exec tsc --noEmit` -> EXIT=0 with 0 lines of output (no type errors) on the merged tree.
All three recovery-verification criteria pass with fresh command evidence: d761b9cc is an ancestor of HEAD 49583100, the two search test files pass 2/2 files and 31/31 tests with exit 0, and tsc --noEmit exits 0 cleanly.

## Summary

Judge Result: INT-CI-035-R1

Stage tier1: PASS
    ✓ secrets: secrets: scanners=gitleaks+builtin cross-check
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ Run from the canonical control root at the published HEAD 49583100: git merge-base --is-ancestor d761b9cc HEAD exits 0 proving the fix commit is reachable from the verified tree: Repo root /home/kara/duckbrain; `git rev-parse HEAD` = 4958310068be8ac4c1c1c7be31a4e4140d556161 (published HEAD 49583100). `git merge-base --is-ancestor d761b9cc HEAD` returned EXIT=0. `git log -1 d761b9cc` = 'd761b9cc fix(search): preserve keyword matches for exact ticket queries. Addresses INT-CI-035.' — fix commit is reachable from the verified tree.
  ✓ pnpm exec vitest run src/search/search-retr001.test.ts src/search/search-retr008.test.ts exits 0 with 2 test files and 31 tests passing, restoring the documented keyword hit counts: Fresh run: `pnpm exec vitest run src/search/search-retr001.test.ts src/search/search-retr008.test.ts` -> EXIT=0. Output: 'RUN v5.0.5 /home/kara/duckbrain', 'Test Files  2 passed (2)', 'Tests  31 passed (31)', Duration 2.34s. Exactly the required 2 files / 31 tests, all passing. [resolution 0.04; src/search/search-retr001.test.ts, src/search/search-retr008.test.ts]
  ✓ pnpm exec tsc --noEmit exits 0 on the merged tree: Fresh run at HEAD 49583100: `pnpm exec tsc --noEmit` -> EXIT=0 with 0 lines of output (no type errors) on the merged tree.
All three recovery-verification criteria pass with fresh command evidence: d761b9cc is an ancestor of HEAD 49583100, the two search test files pass 2/2 files and 31/31 tests with exit 0, and tsc --noEmit exits 0 cleanly.

Overall: PASS ✓
