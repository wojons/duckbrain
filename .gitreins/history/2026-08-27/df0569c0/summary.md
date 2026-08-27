# Verdict: DOGFOOD-031

**Task:** SQL query memories view ignores valid_from/valid_until
**Evaluated:** 2026-08-27T10:35:43.543657
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m5:34AM[0m [32mINF[0m [1mscanned ~12021524 bytes (12.02 MB) in 5.69s[0m
[90m5:34AM[0m [3
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  99 passed (99)
      Tests  843 passed (843)
   S
- ✓ **tier2**
  - COMPLETE
  ✓ The buildNamespaceViewSql view includes expired and future-dated rows that the recall layer correctly hides. Fix: add validity filtering to the view WHERE clause. Pass: query returns no expired/future rows; suite green.: src/duckdb/query-surface.ts (HEAD 611af23, buildNamespaceViewSql lines 419-425) adds validity filtering to the WHERE clause: `AND (valid_until IS NULL OR try_cast(valid_until AS TIMESTAMP) >= now()) AND (valid_from IS NULL OR try_cast(valid_from AS TIMESTAMP) <= now())`, excluding expired and future-dated rows while preserving NULL (no-constraint) rows. Full suite green: `npx vitest run` -> 99 test files / 843 tests passed, exit 0. No LSP diagnostics.
The buildNamespaceViewSql view now filters expired and future-dated rows via valid_until/valid_from checks in the WHERE clause, and the full test suite passes (843 tests).

## Summary

Judge Result: DOGFOOD-031

Stage tier1: PASS
    ✓ secrets: [90m5:34AM[0m [32mINF[0m [1mscanned ~12021524 bytes (12.02 MB) in 5.69s[0m
[90m5:34AM[0m [3
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  99 passed (99)
      Tests  843 passed (843)
   S

Stage tier2: PASS
  COMPLETE
  ✓ The buildNamespaceViewSql view includes expired and future-dated rows that the recall layer correctly hides. Fix: add validity filtering to the view WHERE clause. Pass: query returns no expired/future rows; suite green.: src/duckdb/query-surface.ts (HEAD 611af23, buildNamespaceViewSql lines 419-425) adds validity filtering to the WHERE clause: `AND (valid_until IS NULL OR try_cast(valid_until AS TIMESTAMP) >= now()) AND (valid_from IS NULL OR try_cast(valid_from AS TIMESTAMP) <= now())`, excluding expired and future-dated rows while preserving NULL (no-constraint) rows. Full suite green: `npx vitest run` -> 99 test files / 843 tests passed, exit 0. No LSP diagnostics.
The buildNamespaceViewSql view now filters expired and future-dated rows via valid_until/valid_from checks in the WHERE clause, and the full test suite passes (843 tests).

Overall: PASS ✓
