# Verdict: INT-CI-035

**Task:** CI red on main since e39a1110: keyword search drops one matching memory (search-retr001 + search-retr008 off-by-one)
**Evaluated:** 2026-10-31T17:59:09.898847
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ Merged tree passes pnpm exec vitest run src/search/search-retr001.test.ts src/search/search-retr008.test.ts with documented counts restored (RETR-001 keyword set 3 hits, RETR-008 highlight set 2 hits) and full pnpm test:run green; root cause traced to the e39a1110 query-refusal/filter path that drops one matching memory from keyword results; ticket-ID refusal behavior unchanged (scripts/recall-benchmark/run.mjs still 20/20); fresh row-specific ch:trace row=INT-CI-035 present in the fix commit message or board row.: Targeted run: `pnpm exec vitest run src/search/search-retr001.test.ts src/search/search-retr008.test.ts` -> "Test Files 2 passed (2)" / "Tests 31 passed (31)", exit_code 0. Counts restored: src/search/search-retr001.test.ts:252 `expect(res.total).toBe(3)` (GAP-020 keyword set, m1+m8+m2) and src/search/search-retr008.test.ts:162,186,243 `expect(res.total).toBe(2)` (highlight set). Full suite: `pnpm test:run` -> "Test Files 246 passed (246)" / "Tests 2051 passed (2051)", zero FAIL lines. Root cause confirmed: e39a1110 added `finalRanked = ranked.filter((hit) => hit.tier === 0)` in src/search/query.ts, dropping the tier-1 split-token match (m2); fix d761b9cc replaces it with `const hasExactLiteral = ranked.some((hit) => hit.tier === 0); if (!hasExactLiteral) finalRanked = [];` (src/search/query.ts:465-475). Refusal behavior unchanged: `node scripts/recall-benchmark/run.mjs --scratch` -> "case pass rate 20/20 = 1.000", "correct refusal rate 5/5 = 1.000", case [18] q="DF-9999-99" refusal PASS, "verdict: PASS", exit code 0. ch:trace present in fix commit d761b9cc body: "ch:trace row=INT-CI-035 spec=.coding-hermes/board/tasks.jsonl#INT-CI-035 test=src/search/search-retr001.test.ts+src/search/search-retr008.test.ts+scripts/recall-benchmark/run.mjs evidence=commit-body". [resolution 0.05; src/search/search-retr001.test.ts, src/search/search-retr008.test.ts]
All sub-requirements verified with fresh command output: targeted vitest 31/31 pass with 3-hit and 2-hit counts restored, full suite 246 files / 2051 tests green, benchmark 20/20 with ticket-ID refusal intact, root cause traced to e39a1110's tier-0 filter, and a row-specific ch:trace row=INT-CI-035 in the fix commit.

## Summary

Judge Result: INT-CI-035

Stage tier1: FAIL
    ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ Merged tree passes pnpm exec vitest run src/search/search-retr001.test.ts src/search/search-retr008.test.ts with documented counts restored (RETR-001 keyword set 3 hits, RETR-008 highlight set 2 hits) and full pnpm test:run green; root cause traced to the e39a1110 query-refusal/filter path that drops one matching memory from keyword results; ticket-ID refusal behavior unchanged (scripts/recall-benchmark/run.mjs still 20/20); fresh row-specific ch:trace row=INT-CI-035 present in the fix commit message or board row.: Targeted run: `pnpm exec vitest run src/search/search-retr001.test.ts src/search/search-retr008.test.ts` -> "Test Files 2 passed (2)" / "Tests 31 passed (31)", exit_code 0. Counts restored: src/search/search-retr001.test.ts:252 `expect(res.total).toBe(3)` (GAP-020 keyword set, m1+m8+m2) and src/search/search-retr008.test.ts:162,186,243 `expect(res.total).toBe(2)` (highlight set). Full suite: `pnpm test:run` -> "Test Files 246 passed (246)" / "Tests 2051 passed (2051)", zero FAIL lines. Root cause confirmed: e39a1110 added `finalRanked = ranked.filter((hit) => hit.tier === 0)` in src/search/query.ts, dropping the tier-1 split-token match (m2); fix d761b9cc replaces it with `const hasExactLiteral = ranked.some((hit) => hit.tier === 0); if (!hasExactLiteral) finalRanked = [];` (src/search/query.ts:465-475). Refusal behavior unchanged: `node scripts/recall-benchmark/run.mjs --scratch` -> "case pass rate 20/20 = 1.000", "correct refusal rate 5/5 = 1.000", case [18] q="DF-9999-99" refusal PASS, "verdict: PASS", exit code 0. ch:trace present in fix commit d761b9cc body: "ch:trace row=INT-CI-035 spec=.coding-hermes/board/tasks.jsonl#INT-CI-035 test=src/search/search-retr001.test.ts+src/search/search-retr008.test.ts+scripts/recall-benchmark/run.mjs evidence=commit-body". [resolution 0.05; src/search/search-retr001.test.ts, src/search/search-retr008.test.ts]
All sub-requirements verified with fresh command output: targeted vitest 31/31 pass with 3-hit and 2-hit counts restored, full suite 246 files / 2051 tests green, benchmark 20/20 with ticket-ID refusal intact, root cause traced to e39a1110's tier-0 filter, and a row-specific ch:trace row=INT-CI-035 in the fix commit.

Overall: FAIL ✗
