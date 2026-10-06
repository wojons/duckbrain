# Verdict: GAP-028

**Task:** Document HTTP API authentication in README
**Evaluated:** 2026-09-13T17:35:14.064911
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m12:32PM[0m [32mINF[0m [1mscanned ~8182599 bytes (8.18 MB) in 1.84s[0m
[90m12:32PM[0m [3
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  119 passed (119)
      Tests  1036 passed (1036)

- ✓ **tier2**
  - COMPLETE
  ✓ README HTTP API section states the API-key prerequisite for auth-enabled daemons; all five curl examples send X-API-Key; the text links to docs/api/http-api.md#using-api-key-authentication; README-only diff is structurally verified and the documented reads return HTTP 200 against the live authenticated daemon when supplied the existing scoped key.: README.md:178 states the prerequisite verbatim: "When the server is started with `--auth=apikey`, clients must send `X-API-Key`; keys are configured in `~/.duckbrain/auth.json`. See [Using API Key Authentication](docs/api/http-api.md#using-api-key-authentication)." All five curl examples in the HTTP API section (README.md:181,184,187,190,193) carry `-H "X-API-Key: <key>"` — `grep -c X-API-Key README.md` = 6 (5 curl + 1 prose), and `awk '/^## HTTP API/,/^## Embeddings/' README.md | grep -c '^curl'` = 5 with all 5 matching X-API-Key. Link target verified: docs/api/http-api.md:885 `### Using API Key Authentication` → anchor #using-api-key-authentication resolves. README-only diff verified: `git show --stat HEAD` (ac3735b) = `README.md | 12 +++++++-----`, 1 file changed, 7 insertions(+), 5 deletions(-), no other files. Live daemon verified: pid 183596 `bin/duckbrain.js http --port 3000 --auth=apikey --rate-limit 600`. With the existing scoped key (~/.duckbrain/fleet-quality-review.token, namespaces=None/unrestricted): `curl -H "X-API-Key: $K" http://127.0.0.1:3000/api/keys?namespace=default` → 200; `/api/memories?namespace=default&limit=10` → 200; `/api/memories/key/benchmarks/models/deepseek-v4-pro?namespace=default` → 200; `/api/memories/fda1ce7a-4ec4-487b-ae66-403d04b0c30c?namespace=default` → 200. Auth is genuinely enforced: same route without the header → 401 {"error":"Unauthorized: API key required"}; /health → 200. The 5th documented read (semantic `?q=connection+pooling`) returned curl code 000 (20s timeout) with body {"error":"Embedding generation failed: ... timeout","code":"EMBEDDINGS_UNAVAILABLE"} — this is the embedding-provider dependency the README itself documents in the same section ("Semantic search (`?q=`) requires a reachable embedding provider at query time... fails closed"), not a documentation defect; the four non-embedding reads all return 200. Test suite: `npx vitest run` → "Test Files 119 passed (119)", "Tests 1036 passed (1036)", EXIT=0.
README HTTP API section documents the --auth=apikey/X-API-Key prerequisite, all five curl examples send X-API-Key, the anchor link resolves to docs/api/http-api.md:885, the commit touches README.md only, and the documented reads return HTTP 200 against the live authenticated daemon with the existing scoped key (unit suite 119/1036 green).

## Summary

Judge Result: GAP-028

Stage tier1: PASS
    ✓ secrets: [90m12:32PM[0m [32mINF[0m [1mscanned ~8182599 bytes (8.18 MB) in 1.84s[0m
[90m12:32PM[0m [3
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  119 passed (119)
      Tests  1036 passed (1036)


Stage tier2: PASS
  COMPLETE
  ✓ README HTTP API section states the API-key prerequisite for auth-enabled daemons; all five curl examples send X-API-Key; the text links to docs/api/http-api.md#using-api-key-authentication; README-only diff is structurally verified and the documented reads return HTTP 200 against the live authenticated daemon when supplied the existing scoped key.: README.md:178 states the prerequisite verbatim: "When the server is started with `--auth=apikey`, clients must send `X-API-Key`; keys are configured in `~/.duckbrain/auth.json`. See [Using API Key Authentication](docs/api/http-api.md#using-api-key-authentication)." All five curl examples in the HTTP API section (README.md:181,184,187,190,193) carry `-H "X-API-Key: <key>"` — `grep -c X-API-Key README.md` = 6 (5 curl + 1 prose), and `awk '/^## HTTP API/,/^## Embeddings/' README.md | grep -c '^curl'` = 5 with all 5 matching X-API-Key. Link target verified: docs/api/http-api.md:885 `### Using API Key Authentication` → anchor #using-api-key-authentication resolves. README-only diff verified: `git show --stat HEAD` (ac3735b) = `README.md | 12 +++++++-----`, 1 file changed, 7 insertions(+), 5 deletions(-), no other files. Live daemon verified: pid 183596 `bin/duckbrain.js http --port 3000 --auth=apikey --rate-limit 600`. With the existing scoped key (~/.duckbrain/fleet-quality-review.token, namespaces=None/unrestricted): `curl -H "X-API-Key: $K" http://127.0.0.1:3000/api/keys?namespace=default` → 200; `/api/memories?namespace=default&limit=10` → 200; `/api/memories/key/benchmarks/models/deepseek-v4-pro?namespace=default` → 200; `/api/memories/fda1ce7a-4ec4-487b-ae66-403d04b0c30c?namespace=default` → 200. Auth is genuinely enforced: same route without the header → 401 {"error":"Unauthorized: API key required"}; /health → 200. The 5th documented read (semantic `?q=connection+pooling`) returned curl code 000 (20s timeout) with body {"error":"Embedding generation failed: ... timeout","code":"EMBEDDINGS_UNAVAILABLE"} — this is the embedding-provider dependency the README itself documents in the same section ("Semantic search (`?q=`) requires a reachable embedding provider at query time... fails closed"), not a documentation defect; the four non-embedding reads all return 200. Test suite: `npx vitest run` → "Test Files 119 passed (119)", "Tests 1036 passed (1036)", EXIT=0.
README HTTP API section documents the --auth=apikey/X-API-Key prerequisite, all five curl examples send X-API-Key, the anchor link resolves to docs/api/http-api.md:885, the commit touches README.md only, and the documented reads return HTTP 200 against the live authenticated daemon with the existing scoped key (unit suite 119/1036 green).

Overall: PASS ✓
