# Verdict: DF-0924-01

**Task:** Verify default-branch fresh install
**Evaluated:** 2026-09-28T03:16:33.203560
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✗ **tier2**
  - INCOMPLETE

Cap exceeded: Output token budget (50k) exceeded (50k used). Increase max_output_tokens or simplify criteria.

## Summary

Judge Result: DF-0924-01

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: FAIL
  INCOMPLETE

Cap exceeded: Output token budget (50k) exceeded (50k used). Increase max_output_tokens or simplify criteria.

Overall: FAIL ✗
