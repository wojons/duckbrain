# Verdict: INT-CI-020

**Task:** CI red: Docker build npm ci lockfile out of sync after 592e181
**Evaluated:** 2026-10-06T22:19:58.089435
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✗ **tier2**
  - INCOMPLETE

Evaluator error: LLM call failed: 402 Client Error: Payment Required for url: https://api.deepseek.com/v1/chat/completions (provider=openai model=deepseek-v4-flash url=https://api.deepseek.com/v1/chat/completions key=<GITREINS_LLM_API_KEY>)

## Summary

Judge Result: INT-CI-020

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: FAIL
  INCOMPLETE

Evaluator error: LLM call failed: 402 Client Error: Payment Required for url: https://api.deepseek.com/v1/chat/completions (provider=openai model=deepseek-v4-flash url=https://api.deepseek.com/v1/chat/completions key=<GITREINS_LLM_API_KEY>)

Overall: FAIL ✗
