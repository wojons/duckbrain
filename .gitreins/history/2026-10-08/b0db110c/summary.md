# Verdict: DB-GAP-64

**Task:** INT-CI-023 — http-ui-static tests red in CI (env-dependent 503)
**Evaluated:** 2026-10-08T08:05:54.204461
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ The file src/cli/http-ui-static-df092408.test.ts passes hermetically on this host with no embedding backend influence (DUCKBRAIN_EMBEDDING_PROVIDER=none pinned + cache reset), npx vitest run of that file is green, tsc --noEmit clean, and no .gitreins/.coding-hermes evidence counted.: (1) Test file pins DUCKBRAIN_EMBEDDING_PROVIDER=none at line 78 and calls resetEmbeddingHealthCache() at line 79. (2) npx vitest run src/cli/http-ui-static-df092408.test.ts exited 0: '1 passed (1), 8 passed (8)'. (3) npx tsc --noEmit exited 0 with no output. (4) No .gitreins/.coding-hermes directory exists (find returned empty). [resolution 0.03; src/cli/http-ui-static-df092408.test.ts]
All four sub-checks of the criterion pass: hermetic env pinning, green vitest run, clean tsc, and no .gitreins/.coding-hermes evidence.

## Summary

Judge Result: DB-GAP-64

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ The file src/cli/http-ui-static-df092408.test.ts passes hermetically on this host with no embedding backend influence (DUCKBRAIN_EMBEDDING_PROVIDER=none pinned + cache reset), npx vitest run of that file is green, tsc --noEmit clean, and no .gitreins/.coding-hermes evidence counted.: (1) Test file pins DUCKBRAIN_EMBEDDING_PROVIDER=none at line 78 and calls resetEmbeddingHealthCache() at line 79. (2) npx vitest run src/cli/http-ui-static-df092408.test.ts exited 0: '1 passed (1), 8 passed (8)'. (3) npx tsc --noEmit exited 0 with no output. (4) No .gitreins/.coding-hermes directory exists (find returned empty). [resolution 0.03; src/cli/http-ui-static-df092408.test.ts]
All four sub-checks of the criterion pass: hermetic env pinning, green vitest run, clean tsc, and no .gitreins/.coding-hermes evidence.

Overall: PASS ✓
