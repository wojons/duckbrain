# Verdict: DF-2026-5

**Task:** DELETE by malformed id classified as 4xx like its sibling routes
**Evaluated:** 2026-10-28T02:22:24.294269
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ DELETE /api/memories/not-a-uuid?namespace=ns must NOT return 5xx: it must answer 404 NOT_FOUND (like GET and PUT on the same id) with the documented error+code envelope. A well-formed but unknown UUID still 404; a real id still 204. Regression test covers all arms.: Fix: src/http/routes/memories.ts:968-976 defines `MemoryIdSchema = z.string().uuid()` and `assertUuidMemoryId()` which throws `NotFoundError("Memory", id)`; it is invoked at line 995 inside `router.delete("/:id")` BEFORE forgetTool, so the codeless zod parse failure can no longer fall through to throwWriteError's 500. NotFoundError (src/http/middleware/errorHandler.ts:30-38) carries status 404 + code "NOT_FOUND", and the ApiError branch of errorHandler (errorHandler.ts:117-125) emits the documented `{error, code}` envelope (docs/api/http-api.md:1768 lists NOT_FOUND). Regression test src/http/routes/memories-malformed-input-df2026.test.ts covers all arms: (1) three-arm probe — DELETE/GET/PUT on "not-a-uuid" each asserted 4xx with string `error`+`code`, DELETE asserted 404/NOT_FOUND and equal to GET and PUT statuses; (2) well-formed unknown UUID 3f1f2a6e-... -> 404 NOT_FOUND with error containing "not found"; (3) real id -> POST 201, DELETE 204, follow-up GET 404. Test run evidence: `npx vitest run src/http/routes/memories-malformed-input-df2026.test.ts` exit_code 0, 'Test Files 1 passed (1) / Tests 7 passed (7)' with the three-arm probe, unknown-UUID and real-id tests all ✓; broader `npx vitest run src/http/routes/` exit_code 0, 'Test Files 52 passed (52) / Tests 372 passed (372)'.
DELETE on a malformed id is now gated by a UUID check that throws NotFoundError (404 NOT_FOUND with the {error, code} envelope), sibling parity with GET/PUT holds, unknown-UUID and real-id arms are preserved, and the regression test passes (7/7, and 372/372 across src/http/routes).

## Summary

Judge Result: DF-2026-5

Stage tier1: FAIL
    ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ DELETE /api/memories/not-a-uuid?namespace=ns must NOT return 5xx: it must answer 404 NOT_FOUND (like GET and PUT on the same id) with the documented error+code envelope. A well-formed but unknown UUID still 404; a real id still 204. Regression test covers all arms.: Fix: src/http/routes/memories.ts:968-976 defines `MemoryIdSchema = z.string().uuid()` and `assertUuidMemoryId()` which throws `NotFoundError("Memory", id)`; it is invoked at line 995 inside `router.delete("/:id")` BEFORE forgetTool, so the codeless zod parse failure can no longer fall through to throwWriteError's 500. NotFoundError (src/http/middleware/errorHandler.ts:30-38) carries status 404 + code "NOT_FOUND", and the ApiError branch of errorHandler (errorHandler.ts:117-125) emits the documented `{error, code}` envelope (docs/api/http-api.md:1768 lists NOT_FOUND). Regression test src/http/routes/memories-malformed-input-df2026.test.ts covers all arms: (1) three-arm probe — DELETE/GET/PUT on "not-a-uuid" each asserted 4xx with string `error`+`code`, DELETE asserted 404/NOT_FOUND and equal to GET and PUT statuses; (2) well-formed unknown UUID 3f1f2a6e-... -> 404 NOT_FOUND with error containing "not found"; (3) real id -> POST 201, DELETE 204, follow-up GET 404. Test run evidence: `npx vitest run src/http/routes/memories-malformed-input-df2026.test.ts` exit_code 0, 'Test Files 1 passed (1) / Tests 7 passed (7)' with the three-arm probe, unknown-UUID and real-id tests all ✓; broader `npx vitest run src/http/routes/` exit_code 0, 'Test Files 52 passed (52) / Tests 372 passed (372)'.
DELETE on a malformed id is now gated by a UUID check that throws NotFoundError (404 NOT_FOUND with the {error, code} envelope), sibling parity with GET/PUT holds, unknown-UUID and real-id arms are preserved, and the regression test passes (7/7, and 372/372 across src/http/routes).

Overall: FAIL ✗
