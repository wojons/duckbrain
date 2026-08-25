# Verdict: DB-GAP-041

**Task:** duckbrain-usage SKILL.md auth coverage (post-auth-flip docs drift)
**Evaluated:** 2026-08-25T10:54:28.588988
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m5:52AM[0m [32mINF[0m [1mscanned ~11817799 bytes (11.82 MB) in 6.17s[0m
[90m5:52AM[0m [3
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s
- ✓ **tier2**
  - COMPLETE
  ✓ SKILL.md documents --auth=apikey + X-API-Key header; each SKILL.md curl returns 200 with the documented header; suite green + tsc --noEmit clean: (1) skills/duckbrain-usage/SKILL.md entry table documents `node bin/duckbrain.js http --port 3000 --auth=apikey` and 'every request sends -H X-API-Key: <token> (401 without it)'; all curl examples carry `-H 'X-API-Key: <token>'`; Authentication section documents --auth=apikey + X-API-Key. (2) Live daemon with --auth=apikey: POST /api/namespaces=201, POST /api/memories=201, GET /api/memories/key=200, GET /api/memories?prefix=200, GET /api/keys=200, POST /mcp=200, no-token=401. (3) `npx vitest run` → 92 files/794 tests passed, exit 0 (incl. memories-auth-dbgap031.test.ts 9 tests verifying X-API-Key→200). (4) `npx tsc --noEmit` → exit 0.
SKILL.md fully documents --auth=apikey + X-API-Key, all documented curl commands return 200/201 with the header (verified live), suite green (794 tests) and tsc --noEmit clean.

## Summary

Judge Result: DB-GAP-041

Stage tier1: PASS
    ✓ secrets: [90m5:52AM[0m [32mINF[0m [1mscanned ~11817799 bytes (11.82 MB) in 6.17s[0m
[90m5:52AM[0m [3
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s

Stage tier2: PASS
  COMPLETE
  ✓ SKILL.md documents --auth=apikey + X-API-Key header; each SKILL.md curl returns 200 with the documented header; suite green + tsc --noEmit clean: (1) skills/duckbrain-usage/SKILL.md entry table documents `node bin/duckbrain.js http --port 3000 --auth=apikey` and 'every request sends -H X-API-Key: <token> (401 without it)'; all curl examples carry `-H 'X-API-Key: <token>'`; Authentication section documents --auth=apikey + X-API-Key. (2) Live daemon with --auth=apikey: POST /api/namespaces=201, POST /api/memories=201, GET /api/memories/key=200, GET /api/memories?prefix=200, GET /api/keys=200, POST /mcp=200, no-token=401. (3) `npx vitest run` → 92 files/794 tests passed, exit 0 (incl. memories-auth-dbgap031.test.ts 9 tests verifying X-API-Key→200). (4) `npx tsc --noEmit` → exit 0.
SKILL.md fully documents --auth=apikey + X-API-Key, all documented curl commands return 200/201 with the header (verified live), suite green (794 tests) and tsc --noEmit clean.

Overall: PASS ✓
