# Verdict: DF-2026-8

**Task:** HTTP API docs match shipped tombstone and GET /mcp behaviour
**Evaluated:** 2026-10-28T02:28:43.138815
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ docs/api/http-api.md states tombstoned versions are excluded from both the default list and the historical=true view, and no longer advertises GET /mcp as supported (documented as 405 Allow POST). Claims verified against a live daemon.: Doc claims present and accurate: docs/api/http-api.md:370-372 — "Tombstoned versions (deleted memories) are excluded from both the default list and the `historical=true` view; only live versions are returned"; docs/api/http-api.md:406 — historical param row repeats "Tombstoned versions (deleted memories) are excluded from BOTH views"; docs/api/http-api.md:153-157 — endpoint heading is `POST /mcp` with a note that GET /mcp "is **not offered**" and "returns **405** with `Allow: POST`". Shipped code matches: src/cli/http.ts:880-893 registers app.get("/mcp") returning res.status(405).set("Allow","POST") with message "Method Not Allowed: this endpoint does not offer a GET SSE stream". Tombstone exclusion is unconditional and independent of the historical flag: src/duckdb/queries.ts:485 outerWhereClause = "__rn = 1 AND action != 'tombstone'" is applied to every queryMemories/countMemories/queryMemoriesWithTotal call, while buildValidityConditions (src/duckdb/queries.ts:270-282) only adds valid_from/valid_until conditions when historical !== true — so historical=true widens validity but never resurrects tombstones. Keyword leg likewise: src/search/index.ts:347 (collectLiveMemoryRows) drops tombstone-latest ids at sidecar build, and src/search/query.ts adds no tombstone rows back. Test evidence (fresh runs, exit 0): `npx vitest run src/http/routes/memories-validuntil-retr011.test.ts src/mcp/tools/recall-validuntil-retr011.test.ts src/http/routes/memories-bug027.test.ts` => "Test Files 3 passed (3) / Tests 18 passed (18)"; `npx vitest run src/cli/http-ui-static-df092408.test.ts` => "Test Files 1 passed (1) / Tests 8 passed (8)", where src/cli/http-ui-static-df092408.test.ts:136-138 asserts a live-server GET /mcp returns status 405 with headers.allow === "POST". Note: no test explicitly asserts tombstone exclusion under historical=true (the RETR-011 tests cover validity windows only), but the code path is unconditional and the documentation statement is correct. [resolution 0.11; docs/api/http-api.md]
docs/api/http-api.md correctly documents tombstone exclusion from both views and GET /mcp as 405 Allow: POST, matching the shipped code in src/duckdb/queries.ts:485 and src/cli/http.ts:880-893, with passing live-server tests (18 + 8 tests, exit 0).

## Summary

Judge Result: DF-2026-8

Stage tier1: FAIL
    ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ docs/api/http-api.md states tombstoned versions are excluded from both the default list and the historical=true view, and no longer advertises GET /mcp as supported (documented as 405 Allow POST). Claims verified against a live daemon.: Doc claims present and accurate: docs/api/http-api.md:370-372 — "Tombstoned versions (deleted memories) are excluded from both the default list and the `historical=true` view; only live versions are returned"; docs/api/http-api.md:406 — historical param row repeats "Tombstoned versions (deleted memories) are excluded from BOTH views"; docs/api/http-api.md:153-157 — endpoint heading is `POST /mcp` with a note that GET /mcp "is **not offered**" and "returns **405** with `Allow: POST`". Shipped code matches: src/cli/http.ts:880-893 registers app.get("/mcp") returning res.status(405).set("Allow","POST") with message "Method Not Allowed: this endpoint does not offer a GET SSE stream". Tombstone exclusion is unconditional and independent of the historical flag: src/duckdb/queries.ts:485 outerWhereClause = "__rn = 1 AND action != 'tombstone'" is applied to every queryMemories/countMemories/queryMemoriesWithTotal call, while buildValidityConditions (src/duckdb/queries.ts:270-282) only adds valid_from/valid_until conditions when historical !== true — so historical=true widens validity but never resurrects tombstones. Keyword leg likewise: src/search/index.ts:347 (collectLiveMemoryRows) drops tombstone-latest ids at sidecar build, and src/search/query.ts adds no tombstone rows back. Test evidence (fresh runs, exit 0): `npx vitest run src/http/routes/memories-validuntil-retr011.test.ts src/mcp/tools/recall-validuntil-retr011.test.ts src/http/routes/memories-bug027.test.ts` => "Test Files 3 passed (3) / Tests 18 passed (18)"; `npx vitest run src/cli/http-ui-static-df092408.test.ts` => "Test Files 1 passed (1) / Tests 8 passed (8)", where src/cli/http-ui-static-df092408.test.ts:136-138 asserts a live-server GET /mcp returns status 405 with headers.allow === "POST". Note: no test explicitly asserts tombstone exclusion under historical=true (the RETR-011 tests cover validity windows only), but the code path is unconditional and the documentation statement is correct. [resolution 0.11; docs/api/http-api.md]
docs/api/http-api.md correctly documents tombstone exclusion from both views and GET /mcp as 405 Allow: POST, matching the shipped code in src/duckdb/queries.ts:485 and src/cli/http.ts:880-893, with passing live-server tests (18 + 8 tests, exit 0).

Overall: FAIL ✗
