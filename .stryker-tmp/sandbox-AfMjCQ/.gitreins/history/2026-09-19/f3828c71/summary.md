# Verdict: DF-0919-05

**Task:** remember validUntil camelCase silently ignored
**Evaluated:** 2026-09-19T21:54:54.763455
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v4.1.10 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ POST /api/memories with camelCase validUntil/validFrom is honored (mapped to valid_until/valid_from) — no silent field drop; regression test proves a validUntil in the past excludes the memory from the current view; full suite green: Implementation: src/http/routes/memories.ts:228 normalizeValidityWindow() maps camelCase validFrom/validUntil onto canonical valid_from/valid_until (snake_case wins on collision); POST handler at lines 522-523 reads body.validFrom/validUntil and passes the normalized window to rememberTool (line 563) and echoes snake_case in the 201 response (line 578) — no silent drop. Regression test src/http/routes/memories-validuntil-alias-df091905.test.ts test (f) line 449: {validUntil: PAST} → 201 echoes valid_until, validUntil undefined, current view items length 0 (excluded), historical view returns 1 with valid_until=PAST; test (b) line 124 proves the same via MCP rememberTool. Test run: `npx vitest run src/http/routes/memories-validuntil-alias-df091905.test.ts` → 'Test Files 1 passed (1), Tests 8 passed (8)'. Full suite: `npx vitest run` → 'Test Files 155 passed (155), Tests 1212 passed (1212)', Duration 57.73s, zero failures.
camelCase validUntil/validFrom are mapped to snake_case with a passing regression test proving past-validUntil exclusion, and the full 1212-test suite is green.

## Summary

Judge Result: DF-0919-05

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v4.1.10 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ POST /api/memories with camelCase validUntil/validFrom is honored (mapped to valid_until/valid_from) — no silent field drop; regression test proves a validUntil in the past excludes the memory from the current view; full suite green: Implementation: src/http/routes/memories.ts:228 normalizeValidityWindow() maps camelCase validFrom/validUntil onto canonical valid_from/valid_until (snake_case wins on collision); POST handler at lines 522-523 reads body.validFrom/validUntil and passes the normalized window to rememberTool (line 563) and echoes snake_case in the 201 response (line 578) — no silent drop. Regression test src/http/routes/memories-validuntil-alias-df091905.test.ts test (f) line 449: {validUntil: PAST} → 201 echoes valid_until, validUntil undefined, current view items length 0 (excluded), historical view returns 1 with valid_until=PAST; test (b) line 124 proves the same via MCP rememberTool. Test run: `npx vitest run src/http/routes/memories-validuntil-alias-df091905.test.ts` → 'Test Files 1 passed (1), Tests 8 passed (8)'. Full suite: `npx vitest run` → 'Test Files 155 passed (155), Tests 1212 passed (1212)', Duration 57.73s, zero failures.
camelCase validUntil/validFrom are mapped to snake_case with a passing regression test proving past-validUntil exclusion, and the full 1212-test suite is green.

Overall: PASS ✓
