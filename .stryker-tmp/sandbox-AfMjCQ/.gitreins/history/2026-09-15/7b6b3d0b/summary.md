# Verdict: INT-CI-008

**Task:** P1 — CI recurrence: node-20 integration leg fails on waitForUrl timeout (tests/http-e2e.int.test.ts:332 via helpers.ts:115) while node 22 passes — same class as INT-CI-001/002/003/007
**Evaluated:** 2026-09-15T17:55:03.926710
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m12:50PM[0m [32mINF[0m [1mscanned ~9068945 bytes (9.07 MB) in 3.02s[0m
[90m12:50PM[0m [3
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  122 passed (122)
      Tests  1071 passed (1071)

- ✗ **tier2**
  - INCOMPLETE
  ✗ Integration suite green on both Node 20.x and 22.x after the fix: No fix was applied for this task. `git diff HEAD` shows only `.gitreins/tasks.yaml` (+9 lines, the task row); `git status --short` = ` M .gitreins/tasks.yaml` only. No changes to tests/helpers.ts, tests/http-e2e.int.test.ts, vitest.integration.config.ts, or .github/workflows/ci.yml. The task was closed as 'resolved-no-recurrence' (commit f116ac6, tick 511) with guard_result 'n/a (premise falsified — admin close)', attempts 0, files_changed [], commit_hash null. The only related commit (24834a2) fixes a CI config-assert (duckbrain.config.json -> duckbrain.config.example.json), not waitForUrl, and predates the task's completed_at (2026-09-15T17:50:41Z) by ~6h. Local verification on Node v22.22.3: `./node_modules/.bin/vitest run --config vitest.integration.config.ts tests/` -> 'Test Files 6 passed (6) / Tests 44 passed (44)', exit 0 (green on 22.x). Node 20.x could NOT be verified: only node v22.22.3 is installed (no nvm/alternate versions), and no CI run logs/run IDs are present in the repo to substantiate a green Node 20.x integration leg after the fix. Criterion requires green on BOTH legs after a fix; neither the fix nor the Node 20.x evidence exists.
No code fix was made (only a board/task-row edit) and there is no evidence of a green Node 20.x integration leg, so the criterion fails despite the local Node 22.x suite passing 44/44.

## Summary

Judge Result: INT-CI-008

Stage tier1: PASS
    ✓ secrets: [90m12:50PM[0m [32mINF[0m [1mscanned ~9068945 bytes (9.07 MB) in 3.02s[0m
[90m12:50PM[0m [3
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  122 passed (122)
      Tests  1071 passed (1071)


Stage tier2: FAIL
  INCOMPLETE
  ✗ Integration suite green on both Node 20.x and 22.x after the fix: No fix was applied for this task. `git diff HEAD` shows only `.gitreins/tasks.yaml` (+9 lines, the task row); `git status --short` = ` M .gitreins/tasks.yaml` only. No changes to tests/helpers.ts, tests/http-e2e.int.test.ts, vitest.integration.config.ts, or .github/workflows/ci.yml. The task was closed as 'resolved-no-recurrence' (commit f116ac6, tick 511) with guard_result 'n/a (premise falsified — admin close)', attempts 0, files_changed [], commit_hash null. The only related commit (24834a2) fixes a CI config-assert (duckbrain.config.json -> duckbrain.config.example.json), not waitForUrl, and predates the task's completed_at (2026-09-15T17:50:41Z) by ~6h. Local verification on Node v22.22.3: `./node_modules/.bin/vitest run --config vitest.integration.config.ts tests/` -> 'Test Files 6 passed (6) / Tests 44 passed (44)', exit 0 (green on 22.x). Node 20.x could NOT be verified: only node v22.22.3 is installed (no nvm/alternate versions), and no CI run logs/run IDs are present in the repo to substantiate a green Node 20.x integration leg after the fix. Criterion requires green on BOTH legs after a fix; neither the fix nor the Node 20.x evidence exists.
No code fix was made (only a board/task-row edit) and there is no evidence of a green Node 20.x integration leg, so the criterion fails despite the local Node 22.x suite passing 44/44.

Overall: FAIL ✗
