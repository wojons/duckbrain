# Verdict: INT-CI-025

**Task:** auth-file-enforcement teardown ENOTEMPTY flake
**Evaluated:** 2026-10-07T08:51:19.430817
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✗ **tier2**
  - INCOMPLETE
  ✗ File src/cli/auth-file-enforcement-df092407.test.ts teardown uses removeTempDirSafely bounded-retry; targeted file green 5 consecutive runs; tsc clean; commit pushed to origin/main: Cannot verify criterion due to file scope restriction. File src/cli/auth-file-enforcement-df092407.test.ts is not in the changed files scope.
Unable to verify criterion due to file scope restriction

## Summary

Judge Result: INT-CI-025

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: FAIL
  INCOMPLETE
  ✗ File src/cli/auth-file-enforcement-df092407.test.ts teardown uses removeTempDirSafely bounded-retry; targeted file green 5 consecutive runs; tsc clean; commit pushed to origin/main: Cannot verify criterion due to file scope restriction. File src/cli/auth-file-enforcement-df092407.test.ts is not in the changed files scope.
Unable to verify criterion due to file scope restriction

Overall: FAIL ✗
