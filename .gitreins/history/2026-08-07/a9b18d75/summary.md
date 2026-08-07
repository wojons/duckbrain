# Verdict: DOGFOOD-002

**Task:** DOGFOOD-002 — semantic recall provider fallback + MCP isError surfacing (embedding failure no longer silent)
**Evaluated:** 2026-08-07T16:43:01.609492
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ lint: 
  ✓ secrets: [90m11:40AM[0m [32mINF[0m [1mscanned ~9641360 bytes (9.64 MB) in 3.69s[0m
[90m11:40AM[0m [3
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s
- ✓ **tier2**
  - COMPLETE
  ✓ When the first healthy provider's embed() throws (e.g. lmstudio 400) and a second provider is reachable, recall with query= falls back and returns semantic results instead of an error/empty list (unit test with mocked/forced-failing providers): src/mcp/tools/recall.ts:150-190 iterates createAutoProviders() providers, tries embed() and on throw tries next; recall-dogfood002.test.ts:115 'falls back to the next provider when the first embed() throws' mocks [failingProvider, workingProvider] and asserts result.error undefined, count 1, memories[0].id 'm1'
  ✓ A 200-with-empty-vector embed response is treated as failure (falls through to the next provider / surfaces the error) — unit test: src/embedding/providers.ts makeHttpEmbed throws 'no embedding vector in response' when vec is empty; src/embedding/search.ts cosineSimilarity throws on zero-length vectors; providers-dogfood002.test.ts rejects top-level embedding:[] and data[0].embedding:[]; recall-dogfood002.test.ts:131 'treats a 200-with-empty-vector embed as failure and falls through'
  ✓ MCP recall with query= that fails on ALL providers returns isError:true (not isError:false with empty memories) — unit test: src/mcp/server.ts wrapHandler sets isError:true when result has a truthy error field or handler throws; server-dogfood002.test.ts 'sets isError:true when the result object has a truthy error field' and 'sets isError:true when the handler throws'; recall-dogfood002.test.ts 'returns the error payload when ALL providers fail' produces the error field
  ✓ GET /api/memories?q= with total provider failure still returns HTTP 500 with the error body — existing dogfood001 regression tests stay green: src/http/routes/memories.ts: 'if (result.error) throw new ApiError(result.error, 500)'; memories-dogfood001.test.ts 'returns 500 with the recall error when q= is set and semantic search fails' asserts status 500 and body.error === recallError; test passes
  ✓ Full suite green: npx vitest run (all tests) + npx tsc --noEmit clean: npx vitest run -> 286 passed across 37 test files; npx tsc --noEmit -> exit 0 with no errors
All 5 DOGFOOD-002 criteria verified: provider fallback, empty-vector rejection, MCP isError surfacing, REST 500 error body, and full suite (286 tests + clean tsc) all green.

## Summary

Judge Result: DOGFOOD-002

Stage tier1: PASS
    ✓ lint: 
  ✓ secrets: [90m11:40AM[0m [32mINF[0m [1mscanned ~9641360 bytes (9.64 MB) in 3.69s[0m
[90m11:40AM[0m [3
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s

Stage tier2: PASS
  COMPLETE
  ✓ When the first healthy provider's embed() throws (e.g. lmstudio 400) and a second provider is reachable, recall with query= falls back and returns semantic results instead of an error/empty list (unit test with mocked/forced-failing providers): src/mcp/tools/recall.ts:150-190 iterates createAutoProviders() providers, tries embed() and on throw tries next; recall-dogfood002.test.ts:115 'falls back to the next provider when the first embed() throws' mocks [failingProvider, workingProvider] and asserts result.error undefined, count 1, memories[0].id 'm1'
  ✓ A 200-with-empty-vector embed response is treated as failure (falls through to the next provider / surfaces the error) — unit test: src/embedding/providers.ts makeHttpEmbed throws 'no embedding vector in response' when vec is empty; src/embedding/search.ts cosineSimilarity throws on zero-length vectors; providers-dogfood002.test.ts rejects top-level embedding:[] and data[0].embedding:[]; recall-dogfood002.test.ts:131 'treats a 200-with-empty-vector embed as failure and falls through'
  ✓ MCP recall with query= that fails on ALL providers returns isError:true (not isError:false with empty memories) — unit test: src/mcp/server.ts wrapHandler sets isError:true when result has a truthy error field or handler throws; server-dogfood002.test.ts 'sets isError:true when the result object has a truthy error field' and 'sets isError:true when the handler throws'; recall-dogfood002.test.ts 'returns the error payload when ALL providers fail' produces the error field
  ✓ GET /api/memories?q= with total provider failure still returns HTTP 500 with the error body — existing dogfood001 regression tests stay green: src/http/routes/memories.ts: 'if (result.error) throw new ApiError(result.error, 500)'; memories-dogfood001.test.ts 'returns 500 with the recall error when q= is set and semantic search fails' asserts status 500 and body.error === recallError; test passes
  ✓ Full suite green: npx vitest run (all tests) + npx tsc --noEmit clean: npx vitest run -> 286 passed across 37 test files; npx tsc --noEmit -> exit 0 with no errors
All 5 DOGFOOD-002 criteria verified: provider fallback, empty-vector rejection, MCP isError surfacing, REST 500 error body, and full suite (286 tests + clean tsc) all green.

Overall: PASS ✓
