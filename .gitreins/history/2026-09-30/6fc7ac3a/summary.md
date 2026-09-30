# Verdict: REVIEW-DUCKBRAIN-006

**Task:** default daemon auth to apikey
**Evaluated:** 2026-09-30T10:35:30.625869
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.2 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ fresh daemon no --auth rejects unauthenticated writes 401; --auth=none explicit works; README+help+code agree; suite green: Code: src/cli/http.ts handleHttpCommand default flipped from "none" to "apikey" (commit 19980a3); explicit --auth=none prints a loud UNAUTHENTICATED warning (src/cli/http.ts:1175-1193). 401 path: src/auth/middleware.ts ApiKeyAuthBackend.authenticate throws AuthFailure("Unauthorized: API key required") when no x-api-key header, and authMiddleware only bypasses /health and type==="none". Help text src/cli/http.ts:1101-1105 reads "(default: apikey ... EXPLICIT UNSAFE opt-out)". README lines 104,113-115,134,147-150 all state default apikey with --auth=none explicit; docs/api/http-api.md:1285, docs/guide/getting-started.md:87, docs/guide/deployment.md:21/431, SECURITY.md:71 agree. Tests: new src/cli/auth-default-review-006.test.ts (3 live-daemon arms) PASS — 'npx vitest run src/cli/auth-default-review-006.test.ts' -> Test Files 1 passed (1), Tests 3 passed (3); http-help-httphelp001 + auth-file-enforcement-df092407 -> 19 passed. Full suite: 'npx vitest run' -> Test Files 191 passed (191), Tests 1523 passed (1523), EXIT=0.
Default daemon auth is now apikey (401 on unauthenticated writes), explicit --auth=none works with a warning, README/help/docs/code agree, and the full vitest suite is green (191 files / 1523 tests, exit 0).

## Summary

Judge Result: REVIEW-DUCKBRAIN-006

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.2 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ fresh daemon no --auth rejects unauthenticated writes 401; --auth=none explicit works; README+help+code agree; suite green: Code: src/cli/http.ts handleHttpCommand default flipped from "none" to "apikey" (commit 19980a3); explicit --auth=none prints a loud UNAUTHENTICATED warning (src/cli/http.ts:1175-1193). 401 path: src/auth/middleware.ts ApiKeyAuthBackend.authenticate throws AuthFailure("Unauthorized: API key required") when no x-api-key header, and authMiddleware only bypasses /health and type==="none". Help text src/cli/http.ts:1101-1105 reads "(default: apikey ... EXPLICIT UNSAFE opt-out)". README lines 104,113-115,134,147-150 all state default apikey with --auth=none explicit; docs/api/http-api.md:1285, docs/guide/getting-started.md:87, docs/guide/deployment.md:21/431, SECURITY.md:71 agree. Tests: new src/cli/auth-default-review-006.test.ts (3 live-daemon arms) PASS — 'npx vitest run src/cli/auth-default-review-006.test.ts' -> Test Files 1 passed (1), Tests 3 passed (3); http-help-httphelp001 + auth-file-enforcement-df092407 -> 19 passed. Full suite: 'npx vitest run' -> Test Files 191 passed (191), Tests 1523 passed (1523), EXIT=0.
Default daemon auth is now apikey (401 on unauthenticated writes), explicit --auth=none works with a warning, README/help/docs/code agree, and the full vitest suite is green (191 files / 1523 tests, exit 0).

Overall: FAIL ✗
