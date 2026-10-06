# Verdict: RETR-011

**Task:** Fact versioning convention (T-4): valid_from/valid_until write-side attributes
**Evaluated:** 2026-08-19T14:52:00.290866
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ lint: 
  ✓ secrets: 
    ○
    │╲
    │ ○
    ○ ░
    ░    gitleaks

[90m9:50AM[0m [32mINF[0m [1mscanned ~11079357 
  ✓ tests: 
> duckbrain@1.0.0 test
> vitest


[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/k
- ✓ **tier2**
  - COMPLETE
  ✓ Memory with valid_until in the past excluded from current recall view, visible in historical view; schema docs updated; test suite green: Current-view exclusion: src/duckdb/queries.ts buildValidityConditions (added in HEAD 9f3d806) emits `(valid_until IS NULL OR try_cast(valid_until AS TIMESTAMP) >= now)` + `(valid_from IS NULL OR ... <= now)` when historical!==true and now is set (recallTool sets one fixed `now` per request); HTTP test src/http/routes/memories-validuntil-retr011.test.ts:248-253 asserts expired row absent from current GET, MCP test recall-validuntil-retr011.test.ts:216-217 likewise. Historical view: historical===true makes buildValidityConditions return [] (no filter); HTTP test :258-267 proves the expired row IS visible via ?historical=true with valid_until intact; MCP test :115,:226-234. Schema docs updated: docs/api/http-api.md adds `historical` param, valid_from/valid_until in GET/POST examples + explanatory notes; src/schema/memory.ts adds optional valid_from/valid_until (z.string().datetime()); docs/agentic-memory-roadmap.md marks T-4 SHIPPED; AGENTS.md updated to 90 suites/779 tests. Test suite green: pnpm test:run -> 90 files / 779 tests passed (incl. 22 RETR-011 tests); pnpm tsc --noEmit exit 0; LSP diagnostics empty.
RETR-011 fully implemented: past valid_until rows are filtered from the current recall view (list, keyword, semantic, count paths) while historical=true includes them, schema docs updated, and the full 779-test suite plus tsc pass.

## Summary

Judge Result: RETR-011

Stage tier1: PASS
    ✓ lint: 
  ✓ secrets: 
    ○
    │╲
    │ ○
    ○ ░
    ░    gitleaks

[90m9:50AM[0m [32mINF[0m [1mscanned ~11079357 
  ✓ tests: 
> duckbrain@1.0.0 test
> vitest


[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/k

Stage tier2: PASS
  COMPLETE
  ✓ Memory with valid_until in the past excluded from current recall view, visible in historical view; schema docs updated; test suite green: Current-view exclusion: src/duckdb/queries.ts buildValidityConditions (added in HEAD 9f3d806) emits `(valid_until IS NULL OR try_cast(valid_until AS TIMESTAMP) >= now)` + `(valid_from IS NULL OR ... <= now)` when historical!==true and now is set (recallTool sets one fixed `now` per request); HTTP test src/http/routes/memories-validuntil-retr011.test.ts:248-253 asserts expired row absent from current GET, MCP test recall-validuntil-retr011.test.ts:216-217 likewise. Historical view: historical===true makes buildValidityConditions return [] (no filter); HTTP test :258-267 proves the expired row IS visible via ?historical=true with valid_until intact; MCP test :115,:226-234. Schema docs updated: docs/api/http-api.md adds `historical` param, valid_from/valid_until in GET/POST examples + explanatory notes; src/schema/memory.ts adds optional valid_from/valid_until (z.string().datetime()); docs/agentic-memory-roadmap.md marks T-4 SHIPPED; AGENTS.md updated to 90 suites/779 tests. Test suite green: pnpm test:run -> 90 files / 779 tests passed (incl. 22 RETR-011 tests); pnpm tsc --noEmit exit 0; LSP diagnostics empty.
RETR-011 fully implemented: past valid_until rows are filtered from the current recall view (list, keyword, semantic, count paths) while historical=true includes them, schema docs updated, and the full 779-test suite plus tsc pass.

Overall: PASS ✓
