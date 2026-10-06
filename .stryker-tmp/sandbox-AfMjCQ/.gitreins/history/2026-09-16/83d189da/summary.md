# Verdict: DB-GAP-047

**Task:** Keyword search freshness: no manual rebuild required
**Evaluated:** 2026-09-16T11:58:15.635628
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m6:52AM[0m [32mINF[0m [1mscanned ~8167684 bytes (8.17 MB) in 2.5s[0m
[90m6:52AM[0m [32mI
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  131 passed (131)
      Tests  1114 passed (1114)

- ✓ **tier2**
  - COMPLETE
  ✓ A row written seconds earlier is found by q= on a fresh namespace (no manual search-index rebuild), contains= never 500s on a missing sidecar, stale sidecars refresh before answering, RETR-007/029 union semantics unchanged, full unit+tsc+prettier+integration green: All sub-claims verified with fresh command output and independent live probes. (1) Fresh-namespace q=: live probe (/tmp/probe047.mjs) on a scratch namespace with no sidecar printed 'before: missing' then 'after: fresh total: 1 ids: [p1]' — a row written seconds earlier found with no manual rebuild; HTTP probe (/tmp/probe047b.mjs) printed 'POST: 201 / contains: 200 items: 1 err: undefined / q: 200 items: 1'. (2) contains= never 500s: same HTTP probe returns 200 (was 500); src/http/routes/memories.ts:353 forwards contains to recallTool -> src/search/query.ts:318 keywordSearch calls ensureFreshIndex before collectKeywordCandidates. (3) Stale refresh: live probe (/tmp/probe047c.mjs) printed 'state after rebuild: fresh', 'state after new write: stale', 'found new row: [s2] indexedAt advanced: true state: fresh'. (4) RETR-007/029 union unchanged: src/search/query.ts:402 keywordSearchAllNamespaces contains NO ensureFreshIndex call (deliberate, documented at :392) and still skips SearchIndexMissingError namespaces (:436-439); search-retr007.test.ts, memories-all-namespaces-retr007.test.ts and cli/search-all-namespaces-retr007.test.ts are absent from the commit's changed-file list. (5) Gates, all run fresh: `npx vitest run` -> 'Test Files 131 passed (131); Tests 1114 passed (1114)'; `npx tsc --noEmit` -> exit 0, no output; `npx prettier --check src/` -> 'All matched files use Prettier code style!' exit 0; `npx vitest run --config vitest.integration.config.ts tests/` -> 'Test Files 6 passed (6); Tests 44 passed (44)'; the new suite `npx vitest run src/search/search-freshness-dbgap047.test.ts` -> 'Tests 13 passed (13)' including AC1 (HTTP ?contains= 200), AC2 pin (?q= finds seconds-old row), AC3 (stale refresh), AC4 (bounded/single-flight), AC5 (union skips index-less ns). AGENTS.md:14,33 counts synced to 131 suites / 1114 tests, matching the actual run.
DB-GAP-047 is fully implemented and verified: read-path bounded single-flight rebuild-before-answer makes fresh/stale keyword reads work without manual rebuild, contains= returns 200 instead of 500, RETR-007 union semantics are untouched, and unit (131/1114), tsc, prettier and integration (6/44) gates are all green.

## Summary

Judge Result: DB-GAP-047

Stage tier1: PASS
    ✓ secrets: [90m6:52AM[0m [32mINF[0m [1mscanned ~8167684 bytes (8.17 MB) in 2.5s[0m
[90m6:52AM[0m [32mI
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  131 passed (131)
      Tests  1114 passed (1114)


Stage tier2: PASS
  COMPLETE
  ✓ A row written seconds earlier is found by q= on a fresh namespace (no manual search-index rebuild), contains= never 500s on a missing sidecar, stale sidecars refresh before answering, RETR-007/029 union semantics unchanged, full unit+tsc+prettier+integration green: All sub-claims verified with fresh command output and independent live probes. (1) Fresh-namespace q=: live probe (/tmp/probe047.mjs) on a scratch namespace with no sidecar printed 'before: missing' then 'after: fresh total: 1 ids: [p1]' — a row written seconds earlier found with no manual rebuild; HTTP probe (/tmp/probe047b.mjs) printed 'POST: 201 / contains: 200 items: 1 err: undefined / q: 200 items: 1'. (2) contains= never 500s: same HTTP probe returns 200 (was 500); src/http/routes/memories.ts:353 forwards contains to recallTool -> src/search/query.ts:318 keywordSearch calls ensureFreshIndex before collectKeywordCandidates. (3) Stale refresh: live probe (/tmp/probe047c.mjs) printed 'state after rebuild: fresh', 'state after new write: stale', 'found new row: [s2] indexedAt advanced: true state: fresh'. (4) RETR-007/029 union unchanged: src/search/query.ts:402 keywordSearchAllNamespaces contains NO ensureFreshIndex call (deliberate, documented at :392) and still skips SearchIndexMissingError namespaces (:436-439); search-retr007.test.ts, memories-all-namespaces-retr007.test.ts and cli/search-all-namespaces-retr007.test.ts are absent from the commit's changed-file list. (5) Gates, all run fresh: `npx vitest run` -> 'Test Files 131 passed (131); Tests 1114 passed (1114)'; `npx tsc --noEmit` -> exit 0, no output; `npx prettier --check src/` -> 'All matched files use Prettier code style!' exit 0; `npx vitest run --config vitest.integration.config.ts tests/` -> 'Test Files 6 passed (6); Tests 44 passed (44)'; the new suite `npx vitest run src/search/search-freshness-dbgap047.test.ts` -> 'Tests 13 passed (13)' including AC1 (HTTP ?contains= 200), AC2 pin (?q= finds seconds-old row), AC3 (stale refresh), AC4 (bounded/single-flight), AC5 (union skips index-less ns). AGENTS.md:14,33 counts synced to 131 suites / 1114 tests, matching the actual run.
DB-GAP-047 is fully implemented and verified: read-path bounded single-flight rebuild-before-answer makes fresh/stale keyword reads work without manual rebuild, contains= returns 200 instead of 500, RETR-007 union semantics are untouched, and unit (131/1114), tsc, prettier and integration (6/44) gates are all green.

Overall: PASS ✓
