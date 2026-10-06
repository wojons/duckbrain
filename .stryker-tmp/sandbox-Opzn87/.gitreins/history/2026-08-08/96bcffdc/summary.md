# Verdict: DOGFOOD-006

**Task:** Fix docs/examples drift + friendlier zod errors + help text
**Evaluated:** 2026-08-08T12:17:34.189345
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m7:16AM[0m [32mINF[0m [1mscanned ~10025731 bytes (10.03 MB) in 1.82s[0m
[90m7:16AM[0m [3
  ✓ lint: 
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s
- ✓ **tier2**
  - COMPLETE
  ✓ docs/api/http-api.md contains no 'architecture' domain value in any JSON example (valid domains: person, event, concept, message, config, raw_note): grep 'architecture' docs/api/http-api.md returns no matches (exit 1); all JSON example domain values are 'concept' (lines 217, 237, 277, 294, 309, 331)
  ✓ docs/api/mcp-tools.md documents MCP remember attributes as REQUIRED (no optional wording): docs/api/mcp-tools.md:33 'REQUIRED: object of arbitrary key/value metadata (pass {} if none)' and :40 'attributes is **required** ... it is NOT optional'
  ✓ MCP remember with attributes omitted returns a friendly error containing 'attributes' and 'required' (not raw 'expected record, received undefined'): src/mcp/tools/remember.ts:40 zod error 'attributes is required (object of arbitrary key/value metadata, e.g. {"author": "alice"})'; remember-attributes-dogfood006.test.ts (4 tests) pass asserting /attributes/ and /required/
  ✓ duckbrain --help shows corrected --namespace default wording (not hardcoded 'default'): bin/duckbrain.ts:86, src/cli/human.ts:276,1405 all show 'config defaultNamespace'; grep 'default: default' returns no matches (exit 1)
  ✓ duckbrain recall --help prints usage without running a query: src/cli/human.ts:261 handles --help/-h before running any query, prints usage at :263; recall-help-dogfood006.test.ts (3 tests) pass asserting no query output
  ✓ npx vitest run passes (315 baseline + new regression tests) and npx tsc --noEmit clean: npx vitest run: 322 tests passed (43 files) = 315 baseline + 7 new regression tests; npx tsc --noEmit exit 0; LSP diagnostics 0
All 6 DOGFOOD-006 criteria verified: docs drift fixed, friendly zod error added, help text corrected, and all 322 tests + tsc pass.

## Summary

Judge Result: DOGFOOD-006

Stage tier1: PASS
    ✓ secrets: [90m7:16AM[0m [32mINF[0m [1mscanned ~10025731 bytes (10.03 MB) in 1.82s[0m
[90m7:16AM[0m [3
  ✓ lint: 
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s

Stage tier2: PASS
  COMPLETE
  ✓ docs/api/http-api.md contains no 'architecture' domain value in any JSON example (valid domains: person, event, concept, message, config, raw_note): grep 'architecture' docs/api/http-api.md returns no matches (exit 1); all JSON example domain values are 'concept' (lines 217, 237, 277, 294, 309, 331)
  ✓ docs/api/mcp-tools.md documents MCP remember attributes as REQUIRED (no optional wording): docs/api/mcp-tools.md:33 'REQUIRED: object of arbitrary key/value metadata (pass {} if none)' and :40 'attributes is **required** ... it is NOT optional'
  ✓ MCP remember with attributes omitted returns a friendly error containing 'attributes' and 'required' (not raw 'expected record, received undefined'): src/mcp/tools/remember.ts:40 zod error 'attributes is required (object of arbitrary key/value metadata, e.g. {"author": "alice"})'; remember-attributes-dogfood006.test.ts (4 tests) pass asserting /attributes/ and /required/
  ✓ duckbrain --help shows corrected --namespace default wording (not hardcoded 'default'): bin/duckbrain.ts:86, src/cli/human.ts:276,1405 all show 'config defaultNamespace'; grep 'default: default' returns no matches (exit 1)
  ✓ duckbrain recall --help prints usage without running a query: src/cli/human.ts:261 handles --help/-h before running any query, prints usage at :263; recall-help-dogfood006.test.ts (3 tests) pass asserting no query output
  ✓ npx vitest run passes (315 baseline + new regression tests) and npx tsc --noEmit clean: npx vitest run: 322 tests passed (43 files) = 315 baseline + 7 new regression tests; npx tsc --noEmit exit 0; LSP diagnostics 0
All 6 DOGFOOD-006 criteria verified: docs drift fixed, friendly zod error added, help text corrected, and all 322 tests + tsc pass.

Overall: PASS ✓
