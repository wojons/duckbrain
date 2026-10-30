# Verdict: DF-2026-11

**Task:** DF-2026-11 tolerate in-flight .tmp.jsonl in namespace leak-walk
**Evaluated:** 2026-10-30T01:21:29.795444
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ Leak-walk tolerates in-flight *.tmp.jsonl without weakening the no-write-leaked assertion; >=20 consecutive green runs of src/cli/namespace-env-df092604.test.ts; leak assertion still fails on a real leak; ch:trace row=DF-2026-11 in the commit.: All four sub-claims verified at HEAD a85e0c20 (only criterion). (1) Tolerance without weakening: commit diff changes keyUnder() walk to `entry.name.endsWith(".jsonl") && !entry.name.endsWith(".tmp.jsonl")` (src/cli/namespace-env-df092604.test.ts:101-104); all leak assertions toBe(false) untouched (lines 194, 235, 256, 333, 371, 377-381). (2) >=20 consecutive green runs: ran 20× `vitest run src/cli/namespace-env-df092604.test.ts` → 20× "Test Files  1 passed (1)", 20× "Tests  6 passed (6)", 20× exit=0, zero fail lines (log /tmp/df2026-11-runs.log). (3) Leak assertion still fails on real leak: verbatim logic replication returned true for planted leaked rows.jsonl (so toBe(false) fails) while .tmp.jsonl-only content returned false (tolerated). (4) ch:trace present: `git show -s --format=%B HEAD | grep -c "ch:trace row=DF-2026-11"` → 1, message includes "ch:trace row=DF-2026-11 spec=src/cli/namespace-env-df092604.test.ts test=...::20-consecutive-runs+leak-negative-control evidence=/tmp/df2026-11-runs.txt witness=none:worktree-local-runs commit=THIS". Also tsc --noEmit exit 0; LSP diagnostics empty; worktree test file identical to HEAD.
DF-2026-11 is complete: leak-walk skips in-flight *.tmp.jsonl with assertions intact (verified by 20 consecutive green test runs plus verbatim negative-control logic proving real leaks still trip the assertion), and the commit contains the ch:trace row.

## Summary

Judge Result: DF-2026-11

Stage tier1: FAIL
    ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ Leak-walk tolerates in-flight *.tmp.jsonl without weakening the no-write-leaked assertion; >=20 consecutive green runs of src/cli/namespace-env-df092604.test.ts; leak assertion still fails on a real leak; ch:trace row=DF-2026-11 in the commit.: All four sub-claims verified at HEAD a85e0c20 (only criterion). (1) Tolerance without weakening: commit diff changes keyUnder() walk to `entry.name.endsWith(".jsonl") && !entry.name.endsWith(".tmp.jsonl")` (src/cli/namespace-env-df092604.test.ts:101-104); all leak assertions toBe(false) untouched (lines 194, 235, 256, 333, 371, 377-381). (2) >=20 consecutive green runs: ran 20× `vitest run src/cli/namespace-env-df092604.test.ts` → 20× "Test Files  1 passed (1)", 20× "Tests  6 passed (6)", 20× exit=0, zero fail lines (log /tmp/df2026-11-runs.log). (3) Leak assertion still fails on real leak: verbatim logic replication returned true for planted leaked rows.jsonl (so toBe(false) fails) while .tmp.jsonl-only content returned false (tolerated). (4) ch:trace present: `git show -s --format=%B HEAD | grep -c "ch:trace row=DF-2026-11"` → 1, message includes "ch:trace row=DF-2026-11 spec=src/cli/namespace-env-df092604.test.ts test=...::20-consecutive-runs+leak-negative-control evidence=/tmp/df2026-11-runs.txt witness=none:worktree-local-runs commit=THIS". Also tsc --noEmit exit 0; LSP diagnostics empty; worktree test file identical to HEAD.
DF-2026-11 is complete: leak-walk skips in-flight *.tmp.jsonl with assertions intact (verified by 20 consecutive green test runs plus verbatim negative-control logic proving real leaks still trip the assertion), and the commit contains the ch:trace row.

Overall: FAIL ✗
