# Verdict: DOGFOOD-002

**Task:** DOGFOOD-002 — semantic recall provider fallback + MCP isError surfacing (silent embedding failure)
**Evaluated:** 2026-08-07T16:42:21.990498
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ lint: 
  ✓ secrets: [90m11:40AM[0m [32mINF[0m [1mscanned ~9641355 bytes (9.64 MB) in 3.72s[0m
[90m11:40AM[0m [3
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s
- ✓ **tier2**
  - COMPLETE
  ✓ MCP recall with query= falls back to the next healthy provider when the first provider's embed() fails or returns an empty vector, returning semantic results instead of an error/empty list (unit tests with forced-failing providers): src/mcp/tools/recall.ts:145-180 resolves ALL healthy providers via createAutoProviders() and iterates them, catching embed failures/empty vectors and falling back to the next; recall-dogfood002.test.ts 'falls back to the next provider when the first embed() throws' and 'treats a 200-with-empty-vector embed as failure and falls through' both pass (verified in vitest run)
  ✓ MCP recall with query= where ALL providers fail returns isError=true (not isError=false with memories:[]) via wrapHandler error-field detection: src/mcp/server.ts:57-69 wrapHandler sets isError:true when result has a truthy error field; recall.ts returns {memories:[],count:0,error:'Embedding generation failed:...'} when all providers fail; server-dogfood002.test.ts 'sets isError:true when the result object has a truthy error field' passes
  ✓ A 200-with-empty-vector embed response is treated as failure (rejected in makeHttpEmbed; cosineSimilarity throws on zero-length vectors instead of silent score-0): src/embedding/providers.ts:85-90 makeHttpEmbed throws 'no embedding vector in response' on empty/missing vec; src/embedding/search.ts:40-45 cosineSimilarity throws on zero-length vectors; providers-dogfood002.test.ts empty-vector rejection tests and search.test.ts 'empty vector → throws' pass
  ✓ GET /api/memories?q= with total provider failure returns HTTP 500 with the error body (memories-dogfood001.test.ts regression tests green): src/http/routes/memories.ts:75-76 throws ApiError(result.error, 500); memories-dogfood001.test.ts 'returns 500 with the recall error when q= is set and semantic search fails' passes (status 500, body.error=recallError, body.items undefined)
  ✓ Full unit suite green (286 tests / 37 files) + npx tsc --noEmit clean: npx vitest run → 37 passed (37) test files, 286 passed (286) tests; npx tsc --noEmit exit 0 clean
All 5 DOGFOOD-002 criteria verified: provider fallback, isError surfacing, empty-vector rejection, HTTP 500 regression, and full suite (286/37) + tsc clean all pass.

## Summary

Judge Result: DOGFOOD-002

Stage tier1: PASS
    ✓ lint: 
  ✓ secrets: [90m11:40AM[0m [32mINF[0m [1mscanned ~9641355 bytes (9.64 MB) in 3.72s[0m
[90m11:40AM[0m [3
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s

Stage tier2: PASS
  COMPLETE
  ✓ MCP recall with query= falls back to the next healthy provider when the first provider's embed() fails or returns an empty vector, returning semantic results instead of an error/empty list (unit tests with forced-failing providers): src/mcp/tools/recall.ts:145-180 resolves ALL healthy providers via createAutoProviders() and iterates them, catching embed failures/empty vectors and falling back to the next; recall-dogfood002.test.ts 'falls back to the next provider when the first embed() throws' and 'treats a 200-with-empty-vector embed as failure and falls through' both pass (verified in vitest run)
  ✓ MCP recall with query= where ALL providers fail returns isError=true (not isError=false with memories:[]) via wrapHandler error-field detection: src/mcp/server.ts:57-69 wrapHandler sets isError:true when result has a truthy error field; recall.ts returns {memories:[],count:0,error:'Embedding generation failed:...'} when all providers fail; server-dogfood002.test.ts 'sets isError:true when the result object has a truthy error field' passes
  ✓ A 200-with-empty-vector embed response is treated as failure (rejected in makeHttpEmbed; cosineSimilarity throws on zero-length vectors instead of silent score-0): src/embedding/providers.ts:85-90 makeHttpEmbed throws 'no embedding vector in response' on empty/missing vec; src/embedding/search.ts:40-45 cosineSimilarity throws on zero-length vectors; providers-dogfood002.test.ts empty-vector rejection tests and search.test.ts 'empty vector → throws' pass
  ✓ GET /api/memories?q= with total provider failure returns HTTP 500 with the error body (memories-dogfood001.test.ts regression tests green): src/http/routes/memories.ts:75-76 throws ApiError(result.error, 500); memories-dogfood001.test.ts 'returns 500 with the recall error when q= is set and semantic search fails' passes (status 500, body.error=recallError, body.items undefined)
  ✓ Full unit suite green (286 tests / 37 files) + npx tsc --noEmit clean: npx vitest run → 37 passed (37) test files, 286 passed (286) tests; npx tsc --noEmit exit 0 clean
All 5 DOGFOOD-002 criteria verified: provider fallback, isError surfacing, empty-vector rejection, HTTP 500 regression, and full suite (286/37) + tsc clean all pass.

Overall: PASS ✓
