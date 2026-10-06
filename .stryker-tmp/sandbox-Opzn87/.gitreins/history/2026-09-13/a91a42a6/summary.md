# Verdict: GAP-028

**Task:** Document HTTP API authentication in README
**Evaluated:** 2026-09-13T17:41:45.385781
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m12:38PM[0m [32mINF[0m [1mscanned ~8194321 bytes (8.19 MB) in 1.63s[0m
[90m12:38PM[0m [3
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  119 passed (119)
      Tests  1036 passed (1036)

- ✓ **tier2**
  - COMPLETE
  ✓ README HTTP API section states the API-key prerequisite for auth-enabled daemons; all five curl examples send X-API-Key; the text links to docs/api/http-api.md#using-api-key-authentication; README-only diff is structurally verified and the documented reads return HTTP 200 against the live authenticated daemon when supplied the existing scoped key.: README.md:178 states the prerequisite verbatim: "When the server is started with `--auth=apikey`, clients must send `X-API-Key`; keys are configured in `~/.duckbrain/auth.json`. See [Using API Key Authentication](docs/api/http-api.md#using-api-key-authentication)." All five curl examples (README.md:182,185,188,191,194) carry `-H "X-API-Key: <key>"` — `awk '/^## HTTP API/,/^## Embeddings/' README.md | grep -c '^curl'` = 5 and all 5 match X-API-Key; `grep -c X-API-Key README.md` = 6 (5 curl + 1 prose). Anchor verified: docs/api/http-api.md:885 `### Using API Key Authentication` computes to `#using-api-key-authentication`, matching the link. README-only diff verified: `git diff-tree --no-commit-id --name-only -r 48a98f8` = README.md (1 file, 13 insertions/11 deletions), no other files. Live daemon verified: pid 183596 `node bin/duckbrain.js http --port 3000 --auth=apikey --rate-limit 600`; with the existing scoped key ~/.duckbrain/fleet-quality-review.token: `/api/keys?namespace=default` → 200, `/api/memories?namespace=default&limit=10` → 200, `/api/memories/key/benchmarks/models/deepseek-v4-pro?namespace=default` → 200, `/api/memories/fda1ce7a-4ec4-487b-ae66-403d04b0c30c?namespace=default` → 200; same route without header → 401 {"error":"Unauthorized: API key required"}, proving auth is genuinely enforced. The 5th documented read (semantic `?q=connection+pooling`) returned curl code 000 (timeout) because the embedding provider is down — the README documents this exact dependency in the same section ("Semantic search (`?q=`) requires a reachable embedding provider at query time... fails closed"), so it is not a documentation defect. Test suite: `npx vitest run` → "Test Files 119 passed (119)", "Tests 1036 passed (1036)", EXIT=0.
README HTTP API section documents the --auth=apikey/X-API-Key prerequisite, all five curl examples send X-API-Key, the anchor link resolves to docs/api/http-api.md:885, the commit touches README.md only, and the documented reads return HTTP 200 against the live authenticated daemon with the existing scoped key (unit suite 119/1036 green, EXIT=0).

## Summary

Judge Result: GAP-028

Stage tier1: PASS
    ✓ secrets: [90m12:38PM[0m [32mINF[0m [1mscanned ~8194321 bytes (8.19 MB) in 1.63s[0m
[90m12:38PM[0m [3
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  119 passed (119)
      Tests  1036 passed (1036)


Stage tier2: PASS
  COMPLETE
  ✓ README HTTP API section states the API-key prerequisite for auth-enabled daemons; all five curl examples send X-API-Key; the text links to docs/api/http-api.md#using-api-key-authentication; README-only diff is structurally verified and the documented reads return HTTP 200 against the live authenticated daemon when supplied the existing scoped key.: README.md:178 states the prerequisite verbatim: "When the server is started with `--auth=apikey`, clients must send `X-API-Key`; keys are configured in `~/.duckbrain/auth.json`. See [Using API Key Authentication](docs/api/http-api.md#using-api-key-authentication)." All five curl examples (README.md:182,185,188,191,194) carry `-H "X-API-Key: <key>"` — `awk '/^## HTTP API/,/^## Embeddings/' README.md | grep -c '^curl'` = 5 and all 5 match X-API-Key; `grep -c X-API-Key README.md` = 6 (5 curl + 1 prose). Anchor verified: docs/api/http-api.md:885 `### Using API Key Authentication` computes to `#using-api-key-authentication`, matching the link. README-only diff verified: `git diff-tree --no-commit-id --name-only -r 48a98f8` = README.md (1 file, 13 insertions/11 deletions), no other files. Live daemon verified: pid 183596 `node bin/duckbrain.js http --port 3000 --auth=apikey --rate-limit 600`; with the existing scoped key ~/.duckbrain/fleet-quality-review.token: `/api/keys?namespace=default` → 200, `/api/memories?namespace=default&limit=10` → 200, `/api/memories/key/benchmarks/models/deepseek-v4-pro?namespace=default` → 200, `/api/memories/fda1ce7a-4ec4-487b-ae66-403d04b0c30c?namespace=default` → 200; same route without header → 401 {"error":"Unauthorized: API key required"}, proving auth is genuinely enforced. The 5th documented read (semantic `?q=connection+pooling`) returned curl code 000 (timeout) because the embedding provider is down — the README documents this exact dependency in the same section ("Semantic search (`?q=`) requires a reachable embedding provider at query time... fails closed"), so it is not a documentation defect. Test suite: `npx vitest run` → "Test Files 119 passed (119)", "Tests 1036 passed (1036)", EXIT=0.
README HTTP API section documents the --auth=apikey/X-API-Key prerequisite, all five curl examples send X-API-Key, the anchor link resolves to docs/api/http-api.md:885, the commit touches README.md only, and the documented reads return HTTP 200 against the live authenticated daemon with the existing scoped key (unit suite 119/1036 green, EXIT=0).

Overall: PASS ✓
