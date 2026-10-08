# Verdict: README-5

**Task:** README-5: fresh-daemon health line — degraded can come from keys probe too; status code wording
**Evaluated:** 2026-10-08T03:56:25.144823
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ README.md quickstart step 2 accurately describes the fresh-daemon /health outcome: degraded may come from either the embedding probe or the keys probe, and does not claim a code the server may not serve. Verified by reading the line and grepping the handler (src/cli/http.ts degraded = !embedding.healthy || keysError !== null).: README.md lines 117-120: 'a fresh install may answer 503 "degraded" while the embedding probe is unmet, or while the keys probe has not settled yet' — accurately names both probes as sources of degraded. Only mentions 200 (implied by 'usually 200') and 503, which the handler actually serves. Handler src/cli/http.ts:364 confirms `degraded = !embedding.healthy || keysError !== null` and line 376 confirms `res.status(degraded ? 503 : 200)`. All related tests pass (health-dogfood020: 44/44, health-dbgap035: 5/5, health-deadline: 10/10, health-check: 18/18). [resolution 0.66; README.md, src/cli/http.ts]
README.md quickstart step 2 accurately describes that degraded may come from either the embedding probe or the keys probe, and only references status codes (200/503) that the server actually serves, matching the handler logic at src/cli/http.ts:364.

## Summary

Judge Result: README-5

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ README.md quickstart step 2 accurately describes the fresh-daemon /health outcome: degraded may come from either the embedding probe or the keys probe, and does not claim a code the server may not serve. Verified by reading the line and grepping the handler (src/cli/http.ts degraded = !embedding.healthy || keysError !== null).: README.md lines 117-120: 'a fresh install may answer 503 "degraded" while the embedding probe is unmet, or while the keys probe has not settled yet' — accurately names both probes as sources of degraded. Only mentions 200 (implied by 'usually 200') and 503, which the handler actually serves. Handler src/cli/http.ts:364 confirms `degraded = !embedding.healthy || keysError !== null` and line 376 confirms `res.status(degraded ? 503 : 200)`. All related tests pass (health-dogfood020: 44/44, health-dbgap035: 5/5, health-deadline: 10/10, health-check: 18/18). [resolution 0.66; README.md, src/cli/http.ts]
README.md quickstart step 2 accurately describes that degraded may come from either the embedding probe or the keys probe, and only references status codes (200/503) that the server actually serves, matching the handler logic at src/cli/http.ts:364.

Overall: PASS ✓
