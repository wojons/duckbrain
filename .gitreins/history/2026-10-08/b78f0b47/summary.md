# Verdict: README-5

**Task:** README-5: fresh-daemon health line — degraded can come from keys probe too; status code wording
**Evaluated:** 2026-10-08T03:51:52.063286
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ README.md quickstart step 2 accurately describes the fresh-daemon /health outcome: degraded may come from either the embedding probe or the keys probe, and does not claim a code the server may not serve. Verified by reading the line and grepping the handler (src/cli/http.ts degraded = !embedding.healthy || keysError !== null).: README.md:117-120 reads 'usually 200; a fresh install may answer 503 "degraded" while the embedding probe is unmet, or while the keys probe has not settled yet'. Code at src/cli/http.ts:364 confirms `const degraded = !embedding.healthy || keysError !== null;` (both probes cause degraded). Line 376 confirms `res.status(degraded ? 503 : 200)` — both codes the server actually serves. 3 health-related test files pass (33 tests). [resolution 0.66; README.md, src/cli/http.ts]
README.md quickstart step 2 accurately names both degraded causes (embedding probe and keys probe) and uses 'usually 200' / 'may answer 503' wording that matches the real handler's 200/503 codes.

## Summary

Judge Result: README-5

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ README.md quickstart step 2 accurately describes the fresh-daemon /health outcome: degraded may come from either the embedding probe or the keys probe, and does not claim a code the server may not serve. Verified by reading the line and grepping the handler (src/cli/http.ts degraded = !embedding.healthy || keysError !== null).: README.md:117-120 reads 'usually 200; a fresh install may answer 503 "degraded" while the embedding probe is unmet, or while the keys probe has not settled yet'. Code at src/cli/http.ts:364 confirms `const degraded = !embedding.healthy || keysError !== null;` (both probes cause degraded). Line 376 confirms `res.status(degraded ? 503 : 200)` — both codes the server actually serves. 3 health-related test files pass (33 tests). [resolution 0.66; README.md, src/cli/http.ts]
README.md quickstart step 2 accurately names both degraded causes (embedding probe and keys probe) and uses 'usually 200' / 'may answer 503' wording that matches the real handler's 200/503 codes.

Overall: FAIL ✗
