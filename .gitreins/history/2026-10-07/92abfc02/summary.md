# Verdict: PERF-011

**Task:** As-of recall 7.2s p50 on prod default ns (245k rows)
**Evaluated:** 2026-10-07T05:41:13.539888
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: scanners: nice=nice -n 10

## Summary

Judge Result: PERF-011

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: scanners: nice=nice -n 10

Overall: FAIL ✗
