# DuckBrain E2E Test Results — Tick #124

**Date:** 2026-07-27
**Tester:** Hermes Subagent
**Build:** Vite v6.4.1 (UI), Node.js v22.22.3
**Server:** `node bin/duckbrain.js http --port 9444`

---

## Summary

| Category | Tests | Passed | Failed | Issues |
|----------|-------|--------|--------|--------|
| Build | 2 | 2 | 0 | 0 |
| Health/Stats | 2 | 2 | 0 | 0 |
| Namespaces/Users/Activity | 3 | 3 | 0 | 0 |
| Memory CRUD | 9 | 6 | 3 | ⚠️ |
| Keys/Tree | 2 | 2 | 0 | 0 |
| Events (SSE) | 2 | 2 | 0 | 0 |
| Redirects | 3 | 3 | 0 | 0 |
| CLI | 3 | 3 | 0 | 0 |
| MCP | 1 | 1 | 0 | 0 |
| Error Handling | 4 | 4 | 0 | 0 |
| Web UI | 3 | 2 | 1 | ⚠️ |
| Headers/Infra | 2 | 2 | 0 | 0 |
| **TOTAL** | **36** | **32** | **4** | **4 issues** |

**Overall: 89% pass rate — 4 bugs found.**

---

## Detailed Results

### ✅ Build

| Test | Result | Notes |
|------|--------|-------|
| pnpm build (UI) | ✅ PASS | Vite v6.4.1, 1601 modules transformed, built in 1.63s |
| Build artifacts | ✅ PASS | index.html (771B), CSS (25KB), JS (438KB) all present |

### ✅ Health/Stats

| # | Endpoint | Status | Response | Result |
|---|----------|--------|----------|--------|
| 1 | GET /health | 200 | `{"status":"healthy","uptime":...,"timestamp":"..."}` | ✅ PASS |
| 2 | GET /stats | 200 | `{"memory":...,"uptime":...,"nodeVersion":"v22.22.3"}` | ✅ PASS |

### ✅ Namespaces/Users/Activity

| # | Endpoint | Status | Response | Result |
|---|----------|--------|----------|--------|
| 3 | GET /namespaces | 200 | `{"namespaces":["test-ns",...,"default",...],"currentNamespace":"hermes-dagger"}` | ✅ PASS |
| 4 | GET /users | 200 | `{"users":["Bane","DuckBrain","kara","totalwindupflightsystems"],"count":4}` | ✅ PASS |
| 5 | GET /activity | 200 | `{"activities":[],"count":0,"limit":50}` | ✅ PASS |

### ⚠️ Memory CRUD

| # | Endpoint | Status | Response | Result |
|---|----------|--------|----------|--------|
| 6 | GET /api/memories | 200 | Valid paginated `items[]`, `hasMore`, `nextOffset` | ✅ PASS |
| 7 | GET /api/memories?limit=5 | 200 | 5 items, hasMore=true | ✅ PASS |
| 8 | GET /api/memories/:id | 200 | Returns full memory object with id, key, domain, content, attributes, timestamp, author | ✅ PASS |
| 9 | GET /api/memories/key/:key (single segment) | 404 | `"Memory 'e2e-test' not found"` (looks up wrong key) | ❌ **FAIL** — see [Bug 1](#bug-1-key-lookup-fails-for-multi-segment-keys) |
| 10 | GET /api/memories/key/:key (URL-encoded) | 200 | Works with `%2F`-encoded slashes | ✅ PASS (workaround) |
| 11 | POST /api/memories | 201 | Creates memory, returns new ID | ✅ PASS |
| 12 | PUT /api/memories/:id | 200 | Creates new version (forget + remember) | ✅ PASS |
| 13 | DELETE /api/memories/:id | 204 | Returns 204 No Content | ✅ PASS |
| 14 | GET deleted memory (after DELETE) | 200 | **Still returns original memory data!** | ❌ **FAIL** — see [Bug 2](#bug-2-deleted-tombstoned-memories-still-returned-by-get) |
| 15 | POST /api/memories (invalid domain) | 500 | `"Invalid input: Invalid option..."` — should be 400 | ❌ **FAIL** — see [Bug 3](#bug-3-invalid-domain-validation-returns-500-instead-of-400) |

### ✅ Keys/Tree

| # | Endpoint | Status | Response | Result |
|---|----------|--------|----------|--------|
| 16 | GET /api/keys | 200 | Hierarchical tree with `tree[]`, `total`, correct `type: folder/memory` | ✅ PASS |
| 17 | GET /api/keys/flat | 200 | Flat key list with `hasMore`, `nextOffset`, `prefixes` | ✅ PASS |

### ✅ Events (SSE)

| # | Endpoint | Status | Response | Result |
|---|----------|--------|----------|--------|
| 18 | GET /api/events/default | 200 | SSE `data: {"type":"connected",...}` | ✅ PASS |
| 19 | GET /api/events/default/stats | 200 | `{"namespace":"default","activeConnections":0,...}` | ✅ PASS |
| — | GET /api/events (no namespace) | 404 | `"Route GET /api/events not found"` | ⚠️ Expected — no root route defined |

### ✅ Redirects

| # | Endpoint | Status | Location | Result |
|---|----------|--------|----------|--------|
| 20 | GET /api/tree | 301 | `/api/keys?prefix=/` | ✅ PASS |
| 21 | GET /api/timeline | 301 | `/api/memories?limit=50` | ✅ PASS |
| 22 | GET /api/search | 301 | `/api/memories?q=` | ✅ PASS |

### ✅ CLI Remote Execution

| # | Endpoint | Input | Status | Result |
|---|----------|-------|--------|--------|
| 23 | POST /cli | `{}` (missing command) | 400 | `"Missing or invalid command"` ✅ PASS |
| 24 | POST /cli | `{"command":"stdio"}` (disallowed) | 403 | `"Command not allowed: stdio"` ✅ PASS |
| 25 | POST /cli | `{"command":"status"}` (whitelisted) | 200 | Returns DuckBrain status output ✅ PASS |

### ✅ MCP Transport

| # | Endpoint | Status | Result |
|---|----------|--------|--------|
| 26 | GET /mcp | 405 | `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method Not Allowed..."}}` ✅ PASS |

### ✅ Error Handling

| # | Endpoint | Status | Response | Result |
|---|----------|--------|----------|--------|
| 27 | GET /nonexistent | 404 | `{"error":"Route GET /nonexistent not found","code":"ROUTE_NOT_FOUND"}` | ✅ PASS |
| 28 | GET /api/memories/ffffffff-ffff-ffff-ffff-ffffffffffff | 404 | `{"error":"Memory 'ffffffff...' not found","code":"NOT_FOUND"}` | ✅ PASS |
| 29 | POST /api/memories (missing fields) | 400 | `{"error":"Missing required fields: key, domain, content","code":"VALIDATION_ERROR"}` | ✅ PASS |
| 30 | GET /api/memories/key/nonexistent | 404 | `"Memory 'nonexistent' not found"` | ✅ PASS |

### ✅ Headers/Infra

| # | Test | Result |
|---|------|--------|
| 31 | CORS headers present | ✅ PASS — `Access-Control-Allow-Origin: *`, proper methods/headers |
| 32 | Rate limit headers | ✅ PASS — `X-RateLimit-Limit: 100`, `X-RateLimit-Remaining` decrements |

### ⚠️ Web UI

| # | Test | Result |
|---|------|--------|
| 33 | Vite build succeeds | ✅ PASS — No errors, 1601 modules |
| 34 | UI preview serves | ✅ PASS — HTML (200), JS (200/438KB), CSS (200/25KB) |
| 35 | Missing assets | ❌ **FAIL** — `vite.svg` referenced in index.html but doesn't exist in dist/ or public/ |
| — | Browser console errors | ⚠️ Could not test — CDP sandbox blocks localhost navigation. Verified via curl. |

---

## 🐛 Bugs Found

### Bug 1: Key lookup fails for multi-segment keys

**Severity:** Medium | **Endpoint:** `GET /api/memories/key/:key`

**What:** The route uses Express `:key` parameter which only captures a single URL path segment. Keys with slashes (`/project/hermes4friends/active`) fail with 404 `"Route not found"`.

**Example:**
```
GET /api/memories/key/project/hermes4friends/active → 404
```

**Workaround:** URL-encode the key (e.g., `%2Fproject%2Fhermes4friends%2Factive`)

**Fix:** Change route in `src/http/routes/memories.ts` from `'/key/:key'` to `'/key/*'` (wildcard), then parse `req.params[0]` or use `req.path` to extract the full key.

---

### Bug 2: Deleted (tombstoned) memories still returned by GET

**Severity:** High | **Endpoint:** `GET /api/memories/:id`

**What:** `DELETE /api/memories/:id` correctly returns 204 and creates a tombstone record. However, `GET /api/memories/:id` on the same ID still returns the original memory data with the tombstone flag set to `false`.

**Repro:**
1. `POST /api/memories` → ID `295ed2e6-...` created
2. `DELETE /api/memories/295ed2e6-...` → 204 (tombstone created)
3. `GET /api/memories/295ed2e6-...` → 200 with original data (`isTombstone: false`) ❌

The `GET /:id` handler directly returns `result.memories[0]` without checking the tombstone action. The recall tool finds the original memory by ID but doesn't filter out tombstoned records. Tombstone filtering should be applied at the DuckDB query level or in the route handler.

---

### Bug 3: Invalid domain validation returns 500 instead of 400

**Severity:** Low | **Endpoint:** `POST /api/memories`

**What:** When a POST request includes an invalid `domain` value (e.g., `"INVALID_DOMAIN"` instead of a valid enum), the server returns **500 Internal Server Error** instead of **400 Bad Request**.

The error message (`"Invalid input: Invalid option..."`) is correct but the HTTP status code is wrong. The validation error from the MCP rememberTool should be caught and rendered as 400 with `VALIDATION_ERROR` code.

---

### Bug 4: Missing favicon (vite.svg)

**Severity:** Low | **UI**

**What:** `index.html` references `<link rel="icon" type="image/svg+xml" href="/vite.svg" />` but no `vite.svg` file exists in `dist/` or `public/`. Vite preview server falls back to serving `index.html` for this path (SPA behavior), causing a broken favicon in browsers.

**Fix:** Add a `public/vite.svg` file or remove the reference from `index.html`.

---

## Architecture Observation

The DuckBrain HTTP server (port 9444) does **not** serve the built UI. The UI is a separate Vite-based React app served on its own port (8989 in dev, 5199 in preview) with its own API proxy configuration. For a production deployment, either:
- Serve the built UI from the Express server via `express.static`
- Use a reverse proxy (nginx) to route `/api/*` to the Express server and `/*` to the UI

---

## Test Artifacts

- E2E test memories created and left in the system (tombstone bug prevents full cleanup):
  - `295ed2e6-a37e-4ec9-9e67-832870701f5e` (original)
  - `72b217ca-a781-434a-8b49-945a09795dc7` (updated version)
  - Both under key `/e2e-test/test-memory` in default namespace
- Server log: `/tmp/duckbrain-http.pid`
- Built UI: `/home/kara/duckbrain/packages/ui/dist/`
