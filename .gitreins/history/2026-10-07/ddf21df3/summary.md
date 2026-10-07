# Verdict: DF-0925-04

**Task:** Document HTTP as_of error contract
**Evaluated:** 2026-10-07T11:10:01.288141
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✗ docs/api/http-api.md documents the as_of param error modes (400 VALIDATION_ERROR for combine/ref/no-commit/no-git/empty) and every documented string matches live daemon output: docs/api/http-api.md:388 documents 'Invalid as-of value \'<value>\': not an ISO-8601 date...' but live daemon output (confirmed by test run at 06:08:59 and source src/git/asof.ts:169) produces 'Invalid --as-of value \'<value>\': not an ISO-8601 date...' (double dash vs no dash). All other 4 error strings match. Tests pass (36/36 across 3 test files).
Documented error contract has one mismatch: the unresolvable-ref error string uses 'as-of' in the doc but '--as-of' in actual daemon output.

## Summary

Judge Result: DF-0925-04

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✗ docs/api/http-api.md documents the as_of param error modes (400 VALIDATION_ERROR for combine/ref/no-commit/no-git/empty) and every documented string matches live daemon output: docs/api/http-api.md:388 documents 'Invalid as-of value \'<value>\': not an ISO-8601 date...' but live daemon output (confirmed by test run at 06:08:59 and source src/git/asof.ts:169) produces 'Invalid --as-of value \'<value>\': not an ISO-8601 date...' (double dash vs no dash). All other 4 error strings match. Tests pass (36/36 across 3 test files).
Documented error contract has one mismatch: the unresolvable-ref error string uses 'as-of' in the doc but '--as-of' in actual daemon output.

Overall: FAIL ✗
