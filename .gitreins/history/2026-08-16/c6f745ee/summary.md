# Verdict: DOGFOOD-010

**Task:** P0 - ?q= semantic search crashes HTTP daemon (duckdb Map keys must be unique native exception)
**Evaluated:** 2026-08-16T22:51:34.186394
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ lint: 
Oops! Something went wrong! :(

ESLint: 10.8.1

ESLint couldn't find an eslint.config.(js|mjs|cjs) 
  ✓ secrets: [90m5:50PM[0m [32mINF[0m [1mscanned ~10923667 bytes (10.92 MB) in 2.93s[0m
[90m5:50PM[0m [3
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s
- ✓ **tier2**
  - COMPLETE
  ✓ Server survives ?q= on a namespace whose JSONL contains duplicate keys inside attributes objects: HTTP 200 or clean error, process never aborts: src/duckdb/queries.ts:254,354 read_json now uses explicit all-VARCHAR column schema (READ_JSON_COLUMNS) + ignore_errors=true, so attributes arrives as raw JSON text and no MAP is built — duplicate keys become harmless. Regression test memories-dogfood010.test.ts builds a poisoned namespace with duplicate-key attrs and asserts 200-or-clean-error + /health 200. Ran: npx vitest run src/http/routes/memories-dogfood010.test.ts -> 3 passed.
  ✓ Regression test: ?q= over a populated namespace returns 200 or clean error and the server process stays alive (test asserts no abort): memories-dogfood010.test.ts test '?q= over a duplicate-key namespace returns 200 or a clean error and the server stays alive' issues GET /api/memories?q=alpha&namespace=repro then asserts GET /health returns 200 with status 'healthy' — explicit no-abort assertion. Test passed (3/3).
  ✓ Native DuckDB exceptions cannot kill the process (guarded execution / worker boundary / write-time key normalization): Three-layer containment: (a) queries.ts VARCHAR schema + ignore_errors=true prevents the native 'Map keys must be unique' throw entirely; (b) recall.ts:284-326 wraps semantic fetch+rank in withTimeout(SEMANTIC_TIMEOUT_MS) + try/catch returning clean {memories:[],count:0,error} instead of throwing; (c) memories.ts:258/273/332 + serialize.ts normalizeAttributes canonicalize attributes at write time. Confirmed present in working tree.
  ✓ Full test suite passes + npx tsc --noEmit clean + gitreins guard PASS: npx vitest run -> 52 test files, 377 tests passed (exit 0). npx tsc --noEmit -> exit 0, no errors. gitreins guard -> 'Tier 1 Guards: PASS' (exit 0).
All four DOGFOOD-010 criteria verified: the ?q= duplicate-key crash is fixed via explicit VARCHAR read_json schema + ignore_errors, the semantic path is bounded and error-guarded, a regression test asserts no abort, and the full suite (377 tests), tsc, and gitreins guard all pass.

## Summary

Judge Result: DOGFOOD-010

Stage tier1: FAIL
    ✗ lint: 
Oops! Something went wrong! :(

ESLint: 10.8.1

ESLint couldn't find an eslint.config.(js|mjs|cjs) 
  ✓ secrets: [90m5:50PM[0m [32mINF[0m [1mscanned ~10923667 bytes (10.92 MB) in 2.93s[0m
[90m5:50PM[0m [3
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s

Stage tier2: PASS
  COMPLETE
  ✓ Server survives ?q= on a namespace whose JSONL contains duplicate keys inside attributes objects: HTTP 200 or clean error, process never aborts: src/duckdb/queries.ts:254,354 read_json now uses explicit all-VARCHAR column schema (READ_JSON_COLUMNS) + ignore_errors=true, so attributes arrives as raw JSON text and no MAP is built — duplicate keys become harmless. Regression test memories-dogfood010.test.ts builds a poisoned namespace with duplicate-key attrs and asserts 200-or-clean-error + /health 200. Ran: npx vitest run src/http/routes/memories-dogfood010.test.ts -> 3 passed.
  ✓ Regression test: ?q= over a populated namespace returns 200 or clean error and the server process stays alive (test asserts no abort): memories-dogfood010.test.ts test '?q= over a duplicate-key namespace returns 200 or a clean error and the server stays alive' issues GET /api/memories?q=alpha&namespace=repro then asserts GET /health returns 200 with status 'healthy' — explicit no-abort assertion. Test passed (3/3).
  ✓ Native DuckDB exceptions cannot kill the process (guarded execution / worker boundary / write-time key normalization): Three-layer containment: (a) queries.ts VARCHAR schema + ignore_errors=true prevents the native 'Map keys must be unique' throw entirely; (b) recall.ts:284-326 wraps semantic fetch+rank in withTimeout(SEMANTIC_TIMEOUT_MS) + try/catch returning clean {memories:[],count:0,error} instead of throwing; (c) memories.ts:258/273/332 + serialize.ts normalizeAttributes canonicalize attributes at write time. Confirmed present in working tree.
  ✓ Full test suite passes + npx tsc --noEmit clean + gitreins guard PASS: npx vitest run -> 52 test files, 377 tests passed (exit 0). npx tsc --noEmit -> exit 0, no errors. gitreins guard -> 'Tier 1 Guards: PASS' (exit 0).
All four DOGFOOD-010 criteria verified: the ?q= duplicate-key crash is fixed via explicit VARCHAR read_json schema + ignore_errors, the semantic path is bounded and error-guarded, a regression test asserts no abort, and the full suite (377 tests), tsc, and gitreins guard all pass.

Overall: FAIL ✗
