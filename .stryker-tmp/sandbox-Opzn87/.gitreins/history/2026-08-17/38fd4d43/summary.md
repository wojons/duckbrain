# Verdict: DOGFOOD-011

**Task:** Semantic search has NO relevance threshold - ?q=/recall query returns all memories for garbage queries
**Evaluated:** 2026-08-17T01:41:54.570011
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ lint: 
Oops! Something went wrong! :(

ESLint: 10.8.1

ESLint couldn't find an eslint.config.(js|mjs|cjs) 
  ✓ secrets: [90m8:40PM[0m [32mINF[0m [1mscanned ~10692315 bytes (10.69 MB) in 2.56s[0m
[90m8:40PM[0m [3
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s
- ✓ **tier2**
  - COMPLETE
  ✓ semanticSearch (src/embedding/search.ts) applies a minimum cosine-similarity threshold so a nonsense query (?q=zzznothing) returns no results (or only genuinely above-threshold items) on a populated namespace; similarity scores exposed in REST ?q= responses (items[].score); MCP recall with query behaves consistently; regression tests added; full suite + npx tsc --noEmit clean; gitreins guard PASS: All sub-criteria verified. (1) src/embedding/search.ts: DEFAULT_MIN_SCORE=0.25 and `if (score >= minScore)` drops below-threshold candidates. (2) src/http/routes/memories-dogfood011.test.ts test (a): ?q=zzznothing returns 0 items with total>0 (pool existed, filtered). (3) src/http/routes/memories.ts transformMemory adds score when present; test (c) asserts item.score is number in (0,1]. (4) src/mcp/tools/recall.ts uses same semanticSearch with same threshold and returns score on memories; REST calls recallTool (same function) so MCP/REST consistent. (5) Regression tests: 5 threshold tests in src/embedding/search.test.ts + 5 integration tests in memories-dogfood011.test.ts. (6) `npx vitest run` exit 0: 390 passed (54 files); `npx tsc --noEmit` clean (no output). (7) gitreins guard test_command='npx vitest run' passes (full suite green).
DOGFOOD-011 complete: semantic search enforces DEFAULT_MIN_SCORE=0.25 floor, exposes items[].score over REST, MCP recall consistent via shared recallTool, regression tests added, full suite (390 passed) + tsc clean, gitreins guard PASS.

## Summary

Judge Result: DOGFOOD-011

Stage tier1: FAIL
    ✗ lint: 
Oops! Something went wrong! :(

ESLint: 10.8.1

ESLint couldn't find an eslint.config.(js|mjs|cjs) 
  ✓ secrets: [90m8:40PM[0m [32mINF[0m [1mscanned ~10692315 bytes (10.69 MB) in 2.56s[0m
[90m8:40PM[0m [3
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s

Stage tier2: PASS
  COMPLETE
  ✓ semanticSearch (src/embedding/search.ts) applies a minimum cosine-similarity threshold so a nonsense query (?q=zzznothing) returns no results (or only genuinely above-threshold items) on a populated namespace; similarity scores exposed in REST ?q= responses (items[].score); MCP recall with query behaves consistently; regression tests added; full suite + npx tsc --noEmit clean; gitreins guard PASS: All sub-criteria verified. (1) src/embedding/search.ts: DEFAULT_MIN_SCORE=0.25 and `if (score >= minScore)` drops below-threshold candidates. (2) src/http/routes/memories-dogfood011.test.ts test (a): ?q=zzznothing returns 0 items with total>0 (pool existed, filtered). (3) src/http/routes/memories.ts transformMemory adds score when present; test (c) asserts item.score is number in (0,1]. (4) src/mcp/tools/recall.ts uses same semanticSearch with same threshold and returns score on memories; REST calls recallTool (same function) so MCP/REST consistent. (5) Regression tests: 5 threshold tests in src/embedding/search.test.ts + 5 integration tests in memories-dogfood011.test.ts. (6) `npx vitest run` exit 0: 390 passed (54 files); `npx tsc --noEmit` clean (no output). (7) gitreins guard test_command='npx vitest run' passes (full suite green).
DOGFOOD-011 complete: semantic search enforces DEFAULT_MIN_SCORE=0.25 floor, exposes items[].score over REST, MCP recall consistent via shared recallTool, regression tests added, full suite (390 passed) + tsc clean, gitreins guard PASS.

Overall: FAIL ✗
