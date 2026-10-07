# Verdict: DF-0925-04

**Task:** Document HTTP as_of error contract
**Evaluated:** 2026-10-07T11:22:40.363106
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ docs/api/http-api.md documents the as_of param error modes (400 VALIDATION_ERROR for combine/ref/no-commit/no-git/empty) and every documented string matches live daemon output: docs/api/http-api.md:381-389 documents all 5 error modes with exact strings. Source code matches: src/mcp/tools/recall.ts:529 (combine), src/git/asof.ts:168-169 (unresolvable ref), src/git/asof.ts:156 (no commit before date), src/git/asof.ts:133-134 (no git history), src/git/asof.ts:130 (empty value). HTTP layer maps all to 400 VALIDATION_ERROR via ValidationError (src/http/middleware/errorHandler.ts:43-48) at src/http/routes/memories.ts:73-74 and :452-453. Tests pass: npx vitest run src/http/routes/memories-asof-retr004.test.ts → 1 file 6 passed; combined asof tests → 3 files 20 passed. [resolution 0.30; docs/api/http-api.md]
All 5 as_of error modes are documented with exact strings that match the source code, and the HTTP layer correctly returns 400 VALIDATION_ERROR for each case.

## Summary

Judge Result: DF-0925-04

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ docs/api/http-api.md documents the as_of param error modes (400 VALIDATION_ERROR for combine/ref/no-commit/no-git/empty) and every documented string matches live daemon output: docs/api/http-api.md:381-389 documents all 5 error modes with exact strings. Source code matches: src/mcp/tools/recall.ts:529 (combine), src/git/asof.ts:168-169 (unresolvable ref), src/git/asof.ts:156 (no commit before date), src/git/asof.ts:133-134 (no git history), src/git/asof.ts:130 (empty value). HTTP layer maps all to 400 VALIDATION_ERROR via ValidationError (src/http/middleware/errorHandler.ts:43-48) at src/http/routes/memories.ts:73-74 and :452-453. Tests pass: npx vitest run src/http/routes/memories-asof-retr004.test.ts → 1 file 6 passed; combined asof tests → 3 files 20 passed. [resolution 0.30; docs/api/http-api.md]
All 5 as_of error modes are documented with exact strings that match the source code, and the HTTP layer correctly returns 400 VALIDATION_ERROR for each case.

Overall: PASS ✓
