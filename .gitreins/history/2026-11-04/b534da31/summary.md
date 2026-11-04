# Verdict: TAT-139

**Task:** Store PATCH rejects any null declared column - blocks every claim
**Evaluated:** 2026-11-04T12:01:16.583483
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: scanners=gitleaks+builtin cross-check
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ A partial PATCH against a legacy table declaration does not reject pre-existing nulls: PATCH {attempts} alone returns updated:1; unit test in src/duckdb/table-store.test.ts covers legacy-declaration null varchar + partial patch; full DuckBrain suite green: (1) Fix: src/duckdb/table-store.ts:614-640 adds coercePatchAgainstDeclaration — for legacy declarations (declaredColumnsOf() returns null, table-store.ts:83-95) it copies `existing` and only coerces keys present in the patch, so a pre-existing null varchar is preserved instead of being re-validated; src/http/routes/tables.ts:1198-1202 now calls it in the PATCH route. (2) Unit test: src/duckdb/table-store.test.ts:20-30 'preserves inherited null varchar values during a partial PATCH' — legacy declaration with runner:null, patch {attempts:2} -> {id:'row-1',runner:null,attempts:2}; `npx vitest run src/duckdb/table-store.test.ts` => 'Test Files 1 passed (1) / Tests 2 passed (2)'. (3) End-to-end proof (temporary test, since removed; working tree clean): PATCH /api/ns/tat139/tables/claims?pk=eq.row-1 body {attempts:2} on a legacy .table.json with row {id:'row-1',runner:null,attempts:1} => 'PATCH status 200 {"updated":1}', GET => [{"id":"row-1","runner":null,"attempts":2}]. (4) Full suite: `npx vitest run` => 'Test Files 252 passed (252) / Tests 2090 passed (2090)'. An earlier run showed one flake (tables-supa2.test.ts DELETE tombstone 503 vs 200 under parallel lock contention); that file passes 12/12 in isolation and the full re-run is fully green.
Legacy-declaration partial PATCH now preserves inherited nulls and returns updated:1 (verified end-to-end), the unit test covers the null-varchar + partial-patch case, and the full DuckBrain suite is green (252 files / 2090 tests).

## Summary

Judge Result: TAT-139

Stage tier1: PASS
    ✓ secrets: secrets: scanners=gitleaks+builtin cross-check
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ A partial PATCH against a legacy table declaration does not reject pre-existing nulls: PATCH {attempts} alone returns updated:1; unit test in src/duckdb/table-store.test.ts covers legacy-declaration null varchar + partial patch; full DuckBrain suite green: (1) Fix: src/duckdb/table-store.ts:614-640 adds coercePatchAgainstDeclaration — for legacy declarations (declaredColumnsOf() returns null, table-store.ts:83-95) it copies `existing` and only coerces keys present in the patch, so a pre-existing null varchar is preserved instead of being re-validated; src/http/routes/tables.ts:1198-1202 now calls it in the PATCH route. (2) Unit test: src/duckdb/table-store.test.ts:20-30 'preserves inherited null varchar values during a partial PATCH' — legacy declaration with runner:null, patch {attempts:2} -> {id:'row-1',runner:null,attempts:2}; `npx vitest run src/duckdb/table-store.test.ts` => 'Test Files 1 passed (1) / Tests 2 passed (2)'. (3) End-to-end proof (temporary test, since removed; working tree clean): PATCH /api/ns/tat139/tables/claims?pk=eq.row-1 body {attempts:2} on a legacy .table.json with row {id:'row-1',runner:null,attempts:1} => 'PATCH status 200 {"updated":1}', GET => [{"id":"row-1","runner":null,"attempts":2}]. (4) Full suite: `npx vitest run` => 'Test Files 252 passed (252) / Tests 2090 passed (2090)'. An earlier run showed one flake (tables-supa2.test.ts DELETE tombstone 503 vs 200 under parallel lock contention); that file passes 12/12 in isolation and the full re-run is fully green.
Legacy-declaration partial PATCH now preserves inherited nulls and returns updated:1 (verified end-to-end), the unit test covers the null-varchar + partial-patch case, and the full DuckBrain suite is green (252 files / 2090 tests).

Overall: PASS ✓
