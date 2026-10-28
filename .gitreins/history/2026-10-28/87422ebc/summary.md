# Verdict: DF-2026-6

**Task:** POST with no body and no Content-Type answers 4xx not 500
**Evaluated:** 2026-10-28T02:25:14.752242
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ POST /api/memories with an empty body and no Content-Type returns 4xx (INVALID_JSON or VALIDATION_ERROR) with the error+code envelope, never 5xx; the empty-JSON and malformed-JSON arms keep their 400s.: Fix at src/http/routes/memories.ts:692-694: `if (req.body === undefined || req.body === null) throw new ApiError("Invalid JSON in request body", 400, "INVALID_JSON")` runs before any field read, so the former TypeError->500 path is gone; errorHandler.ts:119-126 serializes ApiError as `{error, code}`. Empty-JSON arm keeps 400 VALIDATION_ERROR at memories.ts:716-721 ("Missing required fields: key, domain, content"); malformed-JSON arm keeps 400 INVALID_JSON via errorHandler.ts:141-148 (SyntaxError branch). Regression test src/http/routes/memories-malformed-input-df2026.test.ts: (a) no body/no Content-Type (helper sends no Content-Type/Content-Length, lines 62-70) asserts 4xx + non-empty error/code + 400 INVALID_JSON; (b) `{}` asserts 400 VALIDATION_ERROR; (c) `{not json` asserts 400 INVALID_JSON; (d) full body asserts 201. Fresh run: `npx vitest run src/http/routes/memories-malformed-input-df2026.test.ts` -> exit_code 0, "Test Files 1 passed (1) / Tests 7 passed (7)". Adjacent HTTP suites also green: `npx vitest run src/cli/http-auth.test.ts src/cli/http-durability.test.ts src/cli/http-serialization.test.ts` -> exit_code 0, 3 files / 19 tests passed.
POST /api/memories now guards an absent body before any field read and answers 400 INVALID_JSON with the error+code envelope, while the `{}` (400 VALIDATION_ERROR) and malformed-JSON (400 INVALID_JSON) arms are preserved and covered by a passing 7-test regression suite.

## Summary

Judge Result: DF-2026-6

Stage tier1: FAIL
    ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ POST /api/memories with an empty body and no Content-Type returns 4xx (INVALID_JSON or VALIDATION_ERROR) with the error+code envelope, never 5xx; the empty-JSON and malformed-JSON arms keep their 400s.: Fix at src/http/routes/memories.ts:692-694: `if (req.body === undefined || req.body === null) throw new ApiError("Invalid JSON in request body", 400, "INVALID_JSON")` runs before any field read, so the former TypeError->500 path is gone; errorHandler.ts:119-126 serializes ApiError as `{error, code}`. Empty-JSON arm keeps 400 VALIDATION_ERROR at memories.ts:716-721 ("Missing required fields: key, domain, content"); malformed-JSON arm keeps 400 INVALID_JSON via errorHandler.ts:141-148 (SyntaxError branch). Regression test src/http/routes/memories-malformed-input-df2026.test.ts: (a) no body/no Content-Type (helper sends no Content-Type/Content-Length, lines 62-70) asserts 4xx + non-empty error/code + 400 INVALID_JSON; (b) `{}` asserts 400 VALIDATION_ERROR; (c) `{not json` asserts 400 INVALID_JSON; (d) full body asserts 201. Fresh run: `npx vitest run src/http/routes/memories-malformed-input-df2026.test.ts` -> exit_code 0, "Test Files 1 passed (1) / Tests 7 passed (7)". Adjacent HTTP suites also green: `npx vitest run src/cli/http-auth.test.ts src/cli/http-durability.test.ts src/cli/http-serialization.test.ts` -> exit_code 0, 3 files / 19 tests passed.
POST /api/memories now guards an absent body before any field read and answers 400 INVALID_JSON with the error+code envelope, while the `{}` (400 VALIDATION_ERROR) and malformed-JSON (400 INVALID_JSON) arms are preserved and covered by a passing 7-test regression suite.

Overall: FAIL ✗
