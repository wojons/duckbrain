# Verdict: INT-CI-033

**Task:** Verify CI test count assertion
**Evaluated:** 2026-10-29T20:38:42.700367
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ CI green with 242 suites and 2027 tests: Fresh run of the configured test command (`npx vitest run`, per .gitreins/config.yaml guards.test_command) in /home/kara/duckbrain produced: 'Test Files  242 passed (242)' / 'Tests  2027 passed (2027)', Duration 63.73s, zero failures. The CI gate step at .github/workflows/ci.yml:88 ('Assert AGENTS.md test counts match live suite') was reproduced: `bash scripts/sync-agents-md-counts.sh --check /tmp/vitest_eval.out` -> 'AGENTS.md test counts match live suite (242 suites, 2027 tests)', exit=0. AGENTS.md:14 reads '(242 suites, 2027 tests)' and AGENTS.md:33 reads '# 2027 tests, 242 suites', matching the live counts (synced in commit 7f6099e3, which fixed the prior 239/2021 drift). Corroborating artifacts /tmp/vitest.out, /tmp/vitest-INT-CI-033.out, -cisim.out and -verify.out all report 242/2027 passed with 'Exit code: 0'.
Fresh full-suite run and the CI count-assertion script both confirm 242 suites / 2027 tests passing with AGENTS.md in sync, so the criterion is met.

## Summary

Judge Result: INT-CI-033

Stage tier1: FAIL
    ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ CI green with 242 suites and 2027 tests: Fresh run of the configured test command (`npx vitest run`, per .gitreins/config.yaml guards.test_command) in /home/kara/duckbrain produced: 'Test Files  242 passed (242)' / 'Tests  2027 passed (2027)', Duration 63.73s, zero failures. The CI gate step at .github/workflows/ci.yml:88 ('Assert AGENTS.md test counts match live suite') was reproduced: `bash scripts/sync-agents-md-counts.sh --check /tmp/vitest_eval.out` -> 'AGENTS.md test counts match live suite (242 suites, 2027 tests)', exit=0. AGENTS.md:14 reads '(242 suites, 2027 tests)' and AGENTS.md:33 reads '# 2027 tests, 242 suites', matching the live counts (synced in commit 7f6099e3, which fixed the prior 239/2021 drift). Corroborating artifacts /tmp/vitest.out, /tmp/vitest-INT-CI-033.out, -cisim.out and -verify.out all report 242/2027 passed with 'Exit code: 0'.
Fresh full-suite run and the CI count-assertion script both confirm 242 suites / 2027 tests passing with AGENTS.md in sync, so the criterion is met.

Overall: FAIL ✗
