# Verdict: DF-0924-04

**Task:** P3 as_of + q= combination returns 500 instead of 400
**Evaluated:** 2026-09-29T02:23:32.245280
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ HTTP status 400 when as_of combined with q= or contains=: src/mcp/tools/recall.ts:481-486 returns error 'as_of cannot be combined with query or contains' when asOfRef is set and (validated.query || validated.contains) — covers both q= and contains=. src/http/routes/memories.ts:503 routes result.error through throwRecallError(), which at memories.ts:72-75 now does `if (error.includes("as_of cannot be combined")) throw new ValidationError(error);` (added in commit 881f9d3). ValidationError (src/http/middleware/errorHandler.ts:42-49) is `super(message, 400, "VALIDATION_ERROR")`, and the ApiError handler at errorHandler.ts:105-112 emits `res.status(err.status)` => 400 + code VALIDATION_ERROR. ?contains= is forwarded as `contains` to recallTool (memories.ts:373,485), so the guard triggers for contains= too. Fresh test run: `npx vitest run src/http/routes/memories-asof-retr004.test.ts` exit_code 0, 'Test Files 1 passed (1) / Tests 6 passed (6)'; verbose shows '✓ ?as_of= combined with ?q= is rejected 13ms' asserting res.status===400 and res.body.code==='VALIDATION_ERROR' (memories-asof-retr004.test.ts:211-218). Combined run of memories-asof-retr004 + recall-asof-retr004 + memories-contains-retr001: exit_code 0, 'Test Files 3 passed (3) / Tests 19 passed (19)'; recall-asof-retr004.test.ts:177-192 asserts both query and contains variants yield the 'as_of cannot be combined' error.
The as_of + q=/contains= combination now maps to ValidationError (400 VALIDATION_ERROR) via throwRecallError, verified by passing tests asserting status 400.

## Summary

Judge Result: DF-0924-04

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ HTTP status 400 when as_of combined with q= or contains=: src/mcp/tools/recall.ts:481-486 returns error 'as_of cannot be combined with query or contains' when asOfRef is set and (validated.query || validated.contains) — covers both q= and contains=. src/http/routes/memories.ts:503 routes result.error through throwRecallError(), which at memories.ts:72-75 now does `if (error.includes("as_of cannot be combined")) throw new ValidationError(error);` (added in commit 881f9d3). ValidationError (src/http/middleware/errorHandler.ts:42-49) is `super(message, 400, "VALIDATION_ERROR")`, and the ApiError handler at errorHandler.ts:105-112 emits `res.status(err.status)` => 400 + code VALIDATION_ERROR. ?contains= is forwarded as `contains` to recallTool (memories.ts:373,485), so the guard triggers for contains= too. Fresh test run: `npx vitest run src/http/routes/memories-asof-retr004.test.ts` exit_code 0, 'Test Files 1 passed (1) / Tests 6 passed (6)'; verbose shows '✓ ?as_of= combined with ?q= is rejected 13ms' asserting res.status===400 and res.body.code==='VALIDATION_ERROR' (memories-asof-retr004.test.ts:211-218). Combined run of memories-asof-retr004 + recall-asof-retr004 + memories-contains-retr001: exit_code 0, 'Test Files 3 passed (3) / Tests 19 passed (19)'; recall-asof-retr004.test.ts:177-192 asserts both query and contains variants yield the 'as_of cannot be combined' error.
The as_of + q=/contains= combination now maps to ValidationError (400 VALIDATION_ERROR) via throwRecallError, verified by passing tests asserting status 400.

Overall: FAIL ✗
