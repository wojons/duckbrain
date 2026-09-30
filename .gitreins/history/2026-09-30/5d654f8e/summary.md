# Verdict: QA-DUCKBRAIN-006

**Task:** package-lock.json stale after DEPS-004 (docker npm ci dead)
**Evaluated:** 2026-09-30T14:02:33.627057
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.2 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ npm ci --dry-run exits 0 at HEAD; fresh clone npm ci succeeds; lockfile matches package.json: All three sub-conditions verified with real command output at HEAD=1ac89d46 (commit 'fix(QA-DUCKBRAIN-006): regenerate package-lock.json after DEPS-004 refresh'). (a) `cd /home/kara/duckbrain && npm ci --dry-run` -> EXIT_CODE=0, tail 'added 68 packages, removed 2 packages, and changed 28 packages in 383ms'. (b) `git clone /home/kara/duckbrain /tmp/freshclone` (CLONE_EXIT=0) then `cd /tmp/freshclone && npm ci` -> EXIT_CODE=0, 'added 327 packages, and audited 328 packages in 5s'. (c) node comparison of lock.packages[''].dependencies/devDependencies vs package.json -> 'mismatches: 0' (all 10 deps + 6 devDeps exact match, no extras). Fix is non-vacuous: pre-fix tree (`git archive 1ac89d4^`) `npm ci --dry-run` -> OLD_EXIT_CODE=1 with 'npm error code EUSAGE ... Invalid: lock file's @aws-sdk/client-s3@3.1137.0 does not satisfy @aws-sdk/client-s3@3.1142.0' (+5 more). Docker path confirmed at Dockerfile:8 `RUN npm ci`; lockfile is tracked at HEAD and working tree matches HEAD (git diff HEAD -- package-lock.json empty). [resolution 0.06; package.json]


## Summary

Judge Result: QA-DUCKBRAIN-006

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.2 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ npm ci --dry-run exits 0 at HEAD; fresh clone npm ci succeeds; lockfile matches package.json: All three sub-conditions verified with real command output at HEAD=1ac89d46 (commit 'fix(QA-DUCKBRAIN-006): regenerate package-lock.json after DEPS-004 refresh'). (a) `cd /home/kara/duckbrain && npm ci --dry-run` -> EXIT_CODE=0, tail 'added 68 packages, removed 2 packages, and changed 28 packages in 383ms'. (b) `git clone /home/kara/duckbrain /tmp/freshclone` (CLONE_EXIT=0) then `cd /tmp/freshclone && npm ci` -> EXIT_CODE=0, 'added 327 packages, and audited 328 packages in 5s'. (c) node comparison of lock.packages[''].dependencies/devDependencies vs package.json -> 'mismatches: 0' (all 10 deps + 6 devDeps exact match, no extras). Fix is non-vacuous: pre-fix tree (`git archive 1ac89d4^`) `npm ci --dry-run` -> OLD_EXIT_CODE=1 with 'npm error code EUSAGE ... Invalid: lock file's @aws-sdk/client-s3@3.1137.0 does not satisfy @aws-sdk/client-s3@3.1142.0' (+5 more). Docker path confirmed at Dockerfile:8 `RUN npm ci`; lockfile is tracked at HEAD and working tree matches HEAD (git diff HEAD -- package-lock.json empty). [resolution 0.06; package.json]


Overall: FAIL ✗
