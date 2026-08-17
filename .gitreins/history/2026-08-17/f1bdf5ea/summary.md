# Verdict: DOGFOOD-013

**Task:** MCP server_http_start broken in standard setup - projectRoot resolves to / via cwd
**Evaluated:** 2026-08-17T03:03:25.416676
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ lint: 
Oops! Something went wrong! :(

ESLint: 10.8.1

ESLint couldn't find an eslint.config.(js|mjs|cjs) 
  ✓ secrets: [90m10:01PM[0m [32mINF[0m [1mscanned ~10970510 bytes (10.97 MB) in 2.57s[0m
[90m10:01PM[0m 
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s
- ✓ **tier2**
  - COMPLETE
  ✓ projectRoot derived from module path (import.meta.url), works when MCP runs from repo root without DUCKBRAIN_HOME_ROOT; child stderr captured and surfaced in failure message; spawn error events handled; hermetic tests added (no real server spawns on live ports); pnpm build + tsc --noEmit + full vitest suite + gitreins guard PASS: resolveProjectRoot() (src/mcp/tools/server.ts:83) derives root from module path via __dirname (CommonJS equivalent of import.meta.url; package.json is "type":"commonjs"), NOT process.cwd(). Tests at server.test.ts:126/150 confirm it resolves bin/duckbrain.ts from repo root without DUCKBRAIN_HOME_ROOT and ignores cwd. spawnHttpServerAndWaitForPort (server.ts:193) captures child stderr (child.stderr?.on('data')) and surfaces it in failure message; 'error' listener attached (server.ts:214) prevents uncaught error. Hermetic tests use port 1 (reserved), ephemeral port 0, process.execPath -e, and /nonexistent binary — no real duckbrain spawn. Verified runs: pnpm build EXIT 0; npx tsc --noEmit EXIT 0; npx vitest run 396 passed/54 files; gitreins guard EXIT 0 'Tier 1 Guards: PASS' (secrets clean, tests pass).


## Summary

Judge Result: DOGFOOD-013

Stage tier1: FAIL
    ✗ lint: 
Oops! Something went wrong! :(

ESLint: 10.8.1

ESLint couldn't find an eslint.config.(js|mjs|cjs) 
  ✓ secrets: [90m10:01PM[0m [32mINF[0m [1mscanned ~10970510 bytes (10.97 MB) in 2.57s[0m
[90m10:01PM[0m 
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s

Stage tier2: PASS
  COMPLETE
  ✓ projectRoot derived from module path (import.meta.url), works when MCP runs from repo root without DUCKBRAIN_HOME_ROOT; child stderr captured and surfaced in failure message; spawn error events handled; hermetic tests added (no real server spawns on live ports); pnpm build + tsc --noEmit + full vitest suite + gitreins guard PASS: resolveProjectRoot() (src/mcp/tools/server.ts:83) derives root from module path via __dirname (CommonJS equivalent of import.meta.url; package.json is "type":"commonjs"), NOT process.cwd(). Tests at server.test.ts:126/150 confirm it resolves bin/duckbrain.ts from repo root without DUCKBRAIN_HOME_ROOT and ignores cwd. spawnHttpServerAndWaitForPort (server.ts:193) captures child stderr (child.stderr?.on('data')) and surfaces it in failure message; 'error' listener attached (server.ts:214) prevents uncaught error. Hermetic tests use port 1 (reserved), ephemeral port 0, process.execPath -e, and /nonexistent binary — no real duckbrain spawn. Verified runs: pnpm build EXIT 0; npx tsc --noEmit EXIT 0; npx vitest run 396 passed/54 files; gitreins guard EXIT 0 'Tier 1 Guards: PASS' (secrets clean, tests pass).


Overall: FAIL ✗
