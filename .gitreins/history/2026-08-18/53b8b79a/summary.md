# Verdict: RETR-001

**Task:** FTS keyword search: src/search/ index + recall --contains + GET /api/memories?contains= + duckbrain search CLI
**Evaluated:** 2026-08-18T16:19:57.279486
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ lint: 
Oops! Something went wrong! :(

ESLint: 10.8.1

ESLint couldn't find an eslint.config.(js|mjs|cjs) 
  ✓ secrets: [90m11:18AM[0m [32mINF[0m [1mscanned ~12308359 bytes (12.31 MB) in 3.02s[0m
[90m11:18AM[0m 
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s
- ✓ **tier2**
  - COMPLETE
  ✓ PASS: duckbrain search GAP-020 returns the GAP-020 memories with snippet; full suite green + tsc clean; no provider needed for keyword half; index gitignored + rebuildable: All sub-parts verified with actual command output. (1) duckbrain search GAP-020: src/search/search-retr001.test.ts 'finds GAP-020 with the exact-token memory first and a snippet' asserts first.id=m1 and first.snippet contains 'GAP-020'; searchTool surface test asserts memories[0].snippet contains 'GAP-020'; CLI searchCommand (src/cli/human.ts:332) calls searchTool and prints snippet. (2) Full suite green: `npx vitest run` -> 'Test Files 61 passed (61)', 'Tests 465 passed (465)', exit 0; `npx tsc --noEmit` -> exit 0, no errors. (3) No provider for keyword half: src/mcp/tools/recall.ts:192 contains path calls keywordSearch directly (offline, no embedding provider); src/mcp/tools/search.ts is pure offline; test 'filters by keyword with snippets, offline' passes. (4) Index gitignored + rebuildable: ensureSearchGitignored writes '/.search/' to namespace .gitignore; test 'builds a gitignored sidecar' asserts gi contains '/.search/' and status.gitignored=true; 'is idempotent' test confirms rebuildable; `git ls-files` shows no .search/fts.duckdb tracked.
RETR-001 keyword FTS search is fully implemented and verified: duckbrain search GAP-020 returns memories with snippets, full suite (465 tests) green, tsc clean, keyword path needs no embedding provider, and the index is gitignored and rebuildable.

## Summary

Judge Result: RETR-001

Stage tier1: FAIL
    ✗ lint: 
Oops! Something went wrong! :(

ESLint: 10.8.1

ESLint couldn't find an eslint.config.(js|mjs|cjs) 
  ✓ secrets: [90m11:18AM[0m [32mINF[0m [1mscanned ~12308359 bytes (12.31 MB) in 3.02s[0m
[90m11:18AM[0m 
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s

Stage tier2: PASS
  COMPLETE
  ✓ PASS: duckbrain search GAP-020 returns the GAP-020 memories with snippet; full suite green + tsc clean; no provider needed for keyword half; index gitignored + rebuildable: All sub-parts verified with actual command output. (1) duckbrain search GAP-020: src/search/search-retr001.test.ts 'finds GAP-020 with the exact-token memory first and a snippet' asserts first.id=m1 and first.snippet contains 'GAP-020'; searchTool surface test asserts memories[0].snippet contains 'GAP-020'; CLI searchCommand (src/cli/human.ts:332) calls searchTool and prints snippet. (2) Full suite green: `npx vitest run` -> 'Test Files 61 passed (61)', 'Tests 465 passed (465)', exit 0; `npx tsc --noEmit` -> exit 0, no errors. (3) No provider for keyword half: src/mcp/tools/recall.ts:192 contains path calls keywordSearch directly (offline, no embedding provider); src/mcp/tools/search.ts is pure offline; test 'filters by keyword with snippets, offline' passes. (4) Index gitignored + rebuildable: ensureSearchGitignored writes '/.search/' to namespace .gitignore; test 'builds a gitignored sidecar' asserts gi contains '/.search/' and status.gitignored=true; 'is idempotent' test confirms rebuildable; `git ls-files` shows no .search/fts.duckdb tracked.
RETR-001 keyword FTS search is fully implemented and verified: duckbrain search GAP-020 returns memories with snippets, full suite (465 tests) green, tsc clean, keyword path needs no embedding provider, and the index is gitignored and rebuildable.

Overall: FAIL ✗
