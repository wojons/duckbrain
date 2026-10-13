# Verdict: INT-CI-030

**Task:** Local-env test failures: PUSH-001 push-gate suite (pushCount 1 got 0) + durability-kill9 SIGKILL-replay duplicates in CI + dogfood010 timeout
**Evaluated:** 2026-10-13T12:23:08.420913
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ autocommit-push-gate.test.ts green locally x3; durability-kill9 either fixed or explained+robust; dogfood010 timeout explained; CI green on main: All four conjuncts verified. (1) push-gate green locally x3: `npx vitest run src/git/autocommit-push-gate.test.ts` run 3 consecutive times -> each 'Test Files 1 passed (1) / Tests 12 passed (12)', exit 0 (07:20:28/30/33). Fix at src/git/autocommit-push-gate.test.ts:48-58 sets GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM to empty scratch files, isolating the host's core.hooksPath override. (2) durability-kill9 fixed+explained: src/storage/durability-kill9.test.ts:250-266 skips the rebuildable `.search/` index in jsonlFiles() with the root cause documented in a comment; corroborated by production doctrine src/search/index.ts:4,32,112 (isSkippedSourceDir excludes .search/.embeddings/.git) and rows.tmp.jsonl creation at src/search/index.ts:294. Durability assertions (length 1, record keys, git commit counts at lines 327-352, 386-391, 425-433) are intact. `npx vitest run src/storage/durability-kill9.test.ts` -> 'Tests 3 passed (3)', exit 0. (3) dogfood010 timeout explained: board task b66d2f83 documents it as a one-off 15015ms timeout, and commit 7332afcd message states 'one-off CI timeout documented, no change'; `npx vitest run src/http/routes/memories-dogfood010.test.ts` -> 'Tests 3 passed (3)', exit 0. (4) CI green on main: `gh run view 38395710660 --json conclusion,headSha` -> {"conclusion":"success","headSha":"5209281fb8c31e9bf2d26044ffab35a8a88e1044"} (jobs: test 3m18s ✓, docker 1m21s ✓); both INT-CI-030 commits 7332afcd and 0ae1b0fd are ancestors of 5209281f (git merge-base --is-ancestor confirmed). That run's log shows '✓ src/git/autocommit-push-gate.test.ts (12 tests)', '✓ src/storage/durability-kill9.test.ts (3 tests)', '✓ src/http/routes/memories-dogfood010.test.ts (3 tests)', 'Test Files 222 passed (222)', 'Tests 1844 passed (1844)', plus the previously-red suites now green (namespaces-dbgap057 ✓6, namespace-warmup-aug096 ✓15, namespace-env-df092604 ✓6, ddl-views ✓2). Combined local run of the three named suites: 'Test Files 3 passed (3) / Tests 18 passed (18)', exit 0. The earlier FAIL verdict (fdcc7ea1) was recorded on 7332afcd before 0ae1b0fd fixed the dbgap057 rig; that suite now passes 6/6 locally and in CI. [resolution 0.08; autocommit-push-gate.test.ts]
All four sub-conditions of INT-CI-030 are met: push-gate green 3x locally, durability-kill9 fixed with documented root cause, dogfood010 timeout explained as one-off, and CI on main (run 38395710660 @ 5209281f) is green with 222/222 files and 1844/1844 tests passing.

## Summary

Judge Result: INT-CI-030

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ autocommit-push-gate.test.ts green locally x3; durability-kill9 either fixed or explained+robust; dogfood010 timeout explained; CI green on main: All four conjuncts verified. (1) push-gate green locally x3: `npx vitest run src/git/autocommit-push-gate.test.ts` run 3 consecutive times -> each 'Test Files 1 passed (1) / Tests 12 passed (12)', exit 0 (07:20:28/30/33). Fix at src/git/autocommit-push-gate.test.ts:48-58 sets GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM to empty scratch files, isolating the host's core.hooksPath override. (2) durability-kill9 fixed+explained: src/storage/durability-kill9.test.ts:250-266 skips the rebuildable `.search/` index in jsonlFiles() with the root cause documented in a comment; corroborated by production doctrine src/search/index.ts:4,32,112 (isSkippedSourceDir excludes .search/.embeddings/.git) and rows.tmp.jsonl creation at src/search/index.ts:294. Durability assertions (length 1, record keys, git commit counts at lines 327-352, 386-391, 425-433) are intact. `npx vitest run src/storage/durability-kill9.test.ts` -> 'Tests 3 passed (3)', exit 0. (3) dogfood010 timeout explained: board task b66d2f83 documents it as a one-off 15015ms timeout, and commit 7332afcd message states 'one-off CI timeout documented, no change'; `npx vitest run src/http/routes/memories-dogfood010.test.ts` -> 'Tests 3 passed (3)', exit 0. (4) CI green on main: `gh run view 38395710660 --json conclusion,headSha` -> {"conclusion":"success","headSha":"5209281fb8c31e9bf2d26044ffab35a8a88e1044"} (jobs: test 3m18s ✓, docker 1m21s ✓); both INT-CI-030 commits 7332afcd and 0ae1b0fd are ancestors of 5209281f (git merge-base --is-ancestor confirmed). That run's log shows '✓ src/git/autocommit-push-gate.test.ts (12 tests)', '✓ src/storage/durability-kill9.test.ts (3 tests)', '✓ src/http/routes/memories-dogfood010.test.ts (3 tests)', 'Test Files 222 passed (222)', 'Tests 1844 passed (1844)', plus the previously-red suites now green (namespaces-dbgap057 ✓6, namespace-warmup-aug096 ✓15, namespace-env-df092604 ✓6, ddl-views ✓2). Combined local run of the three named suites: 'Test Files 3 passed (3) / Tests 18 passed (18)', exit 0. The earlier FAIL verdict (fdcc7ea1) was recorded on 7332afcd before 0ae1b0fd fixed the dbgap057 rig; that suite now passes 6/6 locally and in CI. [resolution 0.08; autocommit-push-gate.test.ts]
All four sub-conditions of INT-CI-030 are met: push-gate green 3x locally, durability-kill9 fixed with documented root cause, dogfood010 timeout explained as one-off, and CI on main (run 38395710660 @ 5209281f) is green with 222/222 files and 1844/1844 tests passing.

Overall: PASS ✓
