# Verdict: GAP-033

**Task:** LOAD-HYGIENE: bound test-suite host load
**Evaluated:** 2026-09-19T22:28:56.608323
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v4.1.10 /home/kara/duckbrain
- ✗ **tier2**
  - INCOMPLETE

Cap exceeded: Time cap (25m) exceeded (25m7s elapsed). Increase max_time or simplify criteria.

## Summary

Judge Result: GAP-033

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v4.1.10 /home/kara/duckbrain

Stage tier2: FAIL
  INCOMPLETE

Cap exceeded: Time cap (25m) exceeded (25m7s elapsed). Increase max_time or simplify criteria.

Overall: FAIL ✗
