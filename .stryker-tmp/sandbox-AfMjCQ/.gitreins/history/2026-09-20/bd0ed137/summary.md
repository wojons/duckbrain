# Verdict: OPS-005

**Task:** Node <22 install-time enforcement (corrected mechanism)
**Evaluated:** 2026-09-20T17:07:59.110327
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✗ **tier2**
  - INCOMPLETE

Cap exceeded: Input token budget (10.0M) exceeded (10.1M used). Increase max_input_tokens or reduce message context.

## Summary

Judge Result: OPS-005

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: FAIL
  INCOMPLETE

Cap exceeded: Input token budget (10.0M) exceeded (10.1M used). Increase max_input_tokens or reduce message context.

Overall: FAIL ✗
