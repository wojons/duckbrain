# Verdict: SUPA9-PK-FILTER-001

**Task:** GET ignores ?pk=eq.N while PATCH/DELETE require it
**Evaluated:** 2026-11-04T14:07:17.550397
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: scanners=gitleaks+builtin cross-check
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ GET /api/ns/:ns/tables/:table?pk=eq.<v> returns ONLY the matching row for a declared pk table (previously returned every row); a new unit test in src/http/routes/tables-*.test.ts asserts pk=eq filters on GET and that a non-eq pk (pk=gte.1) and a non-pk-column filter still behave as today; pnpm test:run green: Implementation: src/http/routes/tables.ts:239-270 adds shared resolvePkFilter(); tables.ts:310-314 in filterParams() maps the pk alias onto the declared primary column (`if (req.query.pk !== undefined) { const { col, value } = resolvePkFilter(declaration, req.query.pk, "GET"); out[col.name] = `eq.${value}`; }`); tables.ts:855-865 GET /:table feeds filterParams into buildSelectPlan, and src/duckdb/table-store.ts:315-390 compiles each filter into a real SQL WHERE comparison, so the filter is enforced in SQL. New test src/http/routes/tables-supa9-pkfilter.test.ts (149 lines, 6 tests) matches the tables-*.test.ts glob and covers: pk=eq.2 -> [{id:2,name:"beta"}] only; pk=eq.9 -> []; pk=gte.1 -> 400 VALIDATION_ERROR (non-eq unchanged); id=eq.2 -> [{id:2,name:"beta"}] (non-pk-column filter unchanged); bogus=eq.9 -> 400; unkeyed?pk=eq.x -> 400 'declares no primary key'. Test evidence: `npx vitest run src/http/routes/tables-supa9-pkfilter.test.ts` exit 0, 'Test Files 1 passed (1) / Tests 6 passed (6)'; `npx vitest run tables-supa9-pkfilter + tables-supa2 + tables-supa3` exit 0, 'Test Files 3 passed (3) / Tests 52 passed (52)'; full suite `npx vitest run --reporter=dot` (= pnpm test:run) -> 'Test Files 252 passed (252) / Tests 2094 passed (2094)', Duration 102.15s, no FAIL lines (grep FAIL/✗ matched only negative-path log strings from distill-sessions/durability tests). Extra edge-case check (temp test, removed; git status clean): table with primary 'id' plus a column literally named 'pk' — ?pk=eq.2 returned [{id:2,pk:"b",name:"beta"}], confirming the alias resolves to the primary column; 2/2 passed.
GET now honours ?pk=eq.<v> via a shared resolvePkFilter wired into filterParams, with a new 6-test tables-supa9-pkfilter.test.ts covering eq/non-eq/non-pk-column cases, and the full suite is green (252 files, 2094 tests).

## Summary

Judge Result: SUPA9-PK-FILTER-001

Stage tier1: PASS
    ✓ secrets: secrets: scanners=gitleaks+builtin cross-check
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ GET /api/ns/:ns/tables/:table?pk=eq.<v> returns ONLY the matching row for a declared pk table (previously returned every row); a new unit test in src/http/routes/tables-*.test.ts asserts pk=eq filters on GET and that a non-eq pk (pk=gte.1) and a non-pk-column filter still behave as today; pnpm test:run green: Implementation: src/http/routes/tables.ts:239-270 adds shared resolvePkFilter(); tables.ts:310-314 in filterParams() maps the pk alias onto the declared primary column (`if (req.query.pk !== undefined) { const { col, value } = resolvePkFilter(declaration, req.query.pk, "GET"); out[col.name] = `eq.${value}`; }`); tables.ts:855-865 GET /:table feeds filterParams into buildSelectPlan, and src/duckdb/table-store.ts:315-390 compiles each filter into a real SQL WHERE comparison, so the filter is enforced in SQL. New test src/http/routes/tables-supa9-pkfilter.test.ts (149 lines, 6 tests) matches the tables-*.test.ts glob and covers: pk=eq.2 -> [{id:2,name:"beta"}] only; pk=eq.9 -> []; pk=gte.1 -> 400 VALIDATION_ERROR (non-eq unchanged); id=eq.2 -> [{id:2,name:"beta"}] (non-pk-column filter unchanged); bogus=eq.9 -> 400; unkeyed?pk=eq.x -> 400 'declares no primary key'. Test evidence: `npx vitest run src/http/routes/tables-supa9-pkfilter.test.ts` exit 0, 'Test Files 1 passed (1) / Tests 6 passed (6)'; `npx vitest run tables-supa9-pkfilter + tables-supa2 + tables-supa3` exit 0, 'Test Files 3 passed (3) / Tests 52 passed (52)'; full suite `npx vitest run --reporter=dot` (= pnpm test:run) -> 'Test Files 252 passed (252) / Tests 2094 passed (2094)', Duration 102.15s, no FAIL lines (grep FAIL/✗ matched only negative-path log strings from distill-sessions/durability tests). Extra edge-case check (temp test, removed; git status clean): table with primary 'id' plus a column literally named 'pk' — ?pk=eq.2 returned [{id:2,pk:"b",name:"beta"}], confirming the alias resolves to the primary column; 2/2 passed.
GET now honours ?pk=eq.<v> via a shared resolvePkFilter wired into filterParams, with a new 6-test tables-supa9-pkfilter.test.ts covering eq/non-eq/non-pk-column cases, and the full suite is green (252 files, 2094 tests).

Overall: PASS ✓
