# Verdict: DF-0926-06

**Task:** Fix key-path validation HTTP status
**Evaluated:** 2026-10-03T07:09:32.916257
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.2 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ POST /api/memories with key missing leading slash returns 400 VALIDATION_ERROR instead of 500; test asserts 400 + error message contains 'key must be a filesystem-style path': Fix at src/http/routes/memories.ts:692-697 throws ValidationError('Invalid key ...: key must be a filesystem-style path starting with / ...') before the rememberTool call; ValidationError (src/http/middleware/errorHandler.ts:43-50) maps to status 400 / code VALIDATION_ERROR, and errorHandler:118-127 emits err.message into body.error. Test tests/http-key-validation.int.test.ts:33-40 asserts res.status===400 and body.error contains 'key must be a filesystem-style path' (plus a 201 case for valid keys). Fresh run: `npx vitest run --config vitest.integration.config.ts tests/http-key-validation.int.test.ts --reporter=verbose` exit_code 0, 'Test Files 1 passed (1) / Tests 2 passed (2)' with both named tests ✓. Independently reproduced against a live daemon: POST {"key":"examples/http/test"} → STATUS=400 body {"error":"Invalid key 'examples/http/test': key must be a filesystem-style path starting with / (e.g., /projects/mcp)","code":"VALIDATION_ERROR"}; POST {"key":"/examples/http/test"} → STATUS=201. Test file is committed and matched by vitest.integration.config.ts include glob 'tests/**/*.int.test.ts'.
Key-path validation now returns 400 VALIDATION_ERROR with the required message for keys missing a leading slash, verified by a passing integration test and an independent live-daemon reproduction.

## Summary

Judge Result: DF-0926-06

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.2 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ POST /api/memories with key missing leading slash returns 400 VALIDATION_ERROR instead of 500; test asserts 400 + error message contains 'key must be a filesystem-style path': Fix at src/http/routes/memories.ts:692-697 throws ValidationError('Invalid key ...: key must be a filesystem-style path starting with / ...') before the rememberTool call; ValidationError (src/http/middleware/errorHandler.ts:43-50) maps to status 400 / code VALIDATION_ERROR, and errorHandler:118-127 emits err.message into body.error. Test tests/http-key-validation.int.test.ts:33-40 asserts res.status===400 and body.error contains 'key must be a filesystem-style path' (plus a 201 case for valid keys). Fresh run: `npx vitest run --config vitest.integration.config.ts tests/http-key-validation.int.test.ts --reporter=verbose` exit_code 0, 'Test Files 1 passed (1) / Tests 2 passed (2)' with both named tests ✓. Independently reproduced against a live daemon: POST {"key":"examples/http/test"} → STATUS=400 body {"error":"Invalid key 'examples/http/test': key must be a filesystem-style path starting with / (e.g., /projects/mcp)","code":"VALIDATION_ERROR"}; POST {"key":"/examples/http/test"} → STATUS=201. Test file is committed and matched by vitest.integration.config.ts include glob 'tests/**/*.int.test.ts'.
Key-path validation now returns 400 VALIDATION_ERROR with the required message for keys missing a leading slash, verified by a passing integration test and an independent live-daemon reproduction.

Overall: FAIL ✗
