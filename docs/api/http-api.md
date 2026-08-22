# HTTP API Reference

DuckBrain's HTTP server provides REST API access to memories, namespaces, and system information, plus Streamable HTTP transport for remote MCP connections.

## Starting the HTTP Server

```bash
# Default port 3000, localhost only
pnpm start -- http

# Custom port
pnpm start -- http --port=8080

# Bind to all interfaces (for remote access)
pnpm start -- http --bind-all --port=8080

# With authentication
pnpm start -- http --auth=apikey --rate-limit=60
```

### HTTP Server Options

| Option | Default | Description |
|--------|---------|-------------|
| `--port` | 3000 | HTTP server port |
| `--bind-all` | — | Bind to `0.0.0.0` (all interfaces) instead of localhost |
| `--auth` | none | Authentication type: `none`, `basic`, or `apikey` |
| `--rate-limit` | 100 | Requests per minute per IP |

---

## Endpoints

### Health Check

`GET /health`

Unauthenticated endpoint — always bypasses authentication and rate limiting.

**Response:**

```json
{
  "status": "healthy",
  "uptime": 1234.56,
  "timestamp": "2026-07-19T12:00:00.000Z"
}
```

**Example:**

```bash
curl http://localhost:3000/health
```

### System Statistics

`GET /stats`

**Response:**

```json
{
  "memory": {
    "rss": 123456789,
    "heapTotal": 98765432,
    "heapUsed": 65432123,
    "external": 1234567,
    "arrayBuffers": 234567
  },
  "uptime": 1234.56,
  "nodeVersion": "20.11.0"
}
```

**Example:**

```bash
curl http://localhost:3000/stats
```

### MCP Transport

`POST /mcp` and `GET /mcp`

Streamable HTTP transport for remote MCP clients. Accepts JSON-RPC requests per the Model Context Protocol specification. Tools are registered automatically on first request.

> **Note:** the `Accept` header is REQUIRED. A request without `Accept: application/json, text/event-stream` is rejected with HTTP 406 (the Streamable HTTP transport requires the client to accept both media types).

**Example:**

```bash
# List available tools
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Namespaces (Legacy)

`GET /namespaces`

Returns a stub list of namespaces. Use the REST API (`/api/namespaces`) for full namespace management.

**Response:**

```json
{
  "namespaces": ["default"]
}
```

### Users (Stub)

`GET /users`

Returns an empty user list. Reserved for future implementation.

**Response:**

```json
{
  "users": []
}
```

### Activity Feed (Stub)

`GET /activity`

Returns an empty activity feed. Reserved for future implementation.

| Query Param | Default | Description |
|-------------|---------|-------------|
| `limit` | 50 | Max activities to return |

**Response:**

```json
{
  "activities": [],
  "limit": 50
}
```

### Legacy API Redirects

These endpoints redirect (301) to the new REST API for backward compatibility:

| Legacy Route | Redirects To |
|-------------|--------------|
| `GET /api/tree` | `/api/keys?prefix=` |
| `GET /api/timeline` | `/api/memories?limit=` |
| `GET /api/search` | `/api/memories?q=` |

### CLI Execution

`POST /cli`

Execute DuckBrain CLI commands remotely via the HTTP server. Supports the `--socket` CLI flag for tunnel-based remote execution.

**Request:**

```json
{
  "command": "status",
  "args": ["--namespace=default"]
}
```

**Response:**

```json
{
  "output": "...",
  "error": "...",
  "exitCode": 0
}
```

**Example:**

```bash
curl -X POST http://localhost:3000/cli \
  -H "Content-Type: application/json" \
  -d '{"command":"status","args":["--namespace=default"]}'
```

---

## REST API Routes

All REST routes are registered under `/api/`. Responses use a consistent JSON format and return appropriate HTTP status codes (200, 201, 204, 400, 404, 500).

### Memories

#### `GET /api/memories`

Query memories with filters.

| Query Param | Default | Description |
|-------------|---------|-------------|
| `prefix` | — | Key prefix filter (e.g., `/projects/`) |
| `domain` | — | Domain filter |
| `author` | — | Author email filter |
| `q` | — | Text search query |
| `contains` | — | Keyword filter (offline full-text search over content/key/attributes) |
| `after` | — | Only rows at or after this ISO-8601 instant (timestamp or chat-archive key date facet) |
| `before` | — | Only rows at or before this ISO-8601 instant |
| `between` | — | ISO-8601 range as `START,END` — shorthand for `after` + `before` |
| `as_of` | — | Read the namespace state at a git ref or ISO-8601 date (memory-as-of) |
| `attr.<name>` | — | Attribute filter: only rows whose `attributes` match `name=value` (repeatable) |
| `historical` | `false` | View selector: `true` = historical view including ALL rows regardless of validity window (expired `valid_until` / future `valid_from` facts stay visible); `false`/absent = current view (validity-filtered) |
| `limit` | 50 | Max results to return |
| `offset` | 0 | Pagination offset |
| `namespace` | `default` | Namespace to query |

> **Note — semantic search (`?q=`) and embeddings (DB-GAP-036):** `?q=` needs a reachable embedding provider at query time (LM Studio / Ollama with a loaded embedding model, or `DUCKBRAIN_EMBEDDING_API_KEY` for the `openai` provider). When no provider can embed, the endpoint returns **503 `EMBEDDINGS_UNAVAILABLE`** with an explicit message telling you to start an embedding provider or run `duckbrain embeddings rebuild` — never a silent unfiltered list. Keyword search (`?contains=`) works offline. Check `GET /health` — its `embedding` block reports provider health.

**Response:**

```json
{
  "items": [
    {
      "id": "uuid-string",
      "key": "/projects/myapp/database",
      "domain": "concept",
      "content": "Using PostgreSQL with PgBouncer",
      "attributes": { "author": "alice", "confidence": "high" },
      "timestamp": "2026-07-19T12:00:00.000Z",
      "valid_from": "2026-07-19T12:00:00.000Z",
      "valid_until": "2026-12-31T23:59:59.000Z",
      "author": "alice@example.com",
      "isTombstone": false,
      "action": "add"
    }
  ],
  "total": 1,
  "offset": 0,
  "limit": 50,
  "hasMore": false,
  "nextOffset": null
}
```

`valid_from` / `valid_until` (RETR-011) are present only when the memory was written with them (optional validity window; omitted = always current). The current view (default) excludes memories whose `valid_until` is in the past or whose `valid_from` is in the future; pass `?historical=true` to include them.

**Example:**

```bash
curl "http://localhost:3000/api/memories?domain=concept&limit=10"
```

#### `GET /api/memories/key/:key`

Get the latest memory by key path. Returns 404 if the key does not exist.

| Query Param | Default | Description |
|-------------|---------|-------------|
| `namespace` | `default` | Namespace to query |

**Example:**

```bash
curl "http://localhost:3000/api/memories/key/projects/myapp/database?namespace=default"
```

#### `GET /api/memories/:id`

Get a memory by its unique ID. Returns 404 if the ID is not found.

| Query Param | Default | Description |
|-------------|---------|-------------|
| `namespace` | `default` | Namespace to query |

**Example:**

```bash
curl "http://localhost:3000/api/memories/a1b2c3d4-e5f6-7890-abcd-ef1234567890?namespace=default"
```

#### `POST /api/memories`

Create a new memory.

| Query Param | Default | Description |
|-------------|---------|-------------|
| `namespace` | `default` | Namespace to write to |

**Request:**

```json
{
  "key": "/projects/myapp/database",
  "domain": "concept",
  "content": "Using PostgreSQL with PgBouncer for connection pooling",
  "namespace": "default",
  "valid_from": "2026-07-19T12:00:00.000Z",
  "valid_until": "2026-12-31T23:59:59.000Z",
  "attributes": {
    "author": "alice",
    "confidence": "high"
  }
}
```

> **Note — validity window (RETR-011):** `valid_from` / `valid_until` are optional ISO-8601 datetimes. Omitted = the memory is valid from the moment of writing, indefinitely. A past `valid_until` (or future `valid_from`) keeps the memory out of the default current recall view; it remains visible with `?historical=true` on `GET /api/memories`.

> **Note — namespace selection:** The target namespace may be passed either as the `?namespace=` query parameter **or** as a `"namespace"` field in the JSON body. When both are present the query parameter wins; the body value is the fallback; when neither is supplied the memory is written to the `default` namespace.

> **Note — field naming across surfaces:** The HTTP API accepts `content` for the memory body. This maps directly to the MCP `remember` tool's `embedding_text` field — both surfaces store and return the **same** underlying text field (see [MCP Tools Reference](mcp-tools.md#remember)). A memory written via HTTP with `content` is retrievable via MCP `recall` with the text in `embedding_text`, and vice versa.

**Response:** (201 Created)

```json
{
  "id": "uuid-string",
  "key": "/projects/myapp/database",
  "domain": "concept",
  "content": "Using PostgreSQL with PgBouncer...",
  "attributes": { "author": "alice", "confidence": "high" },
  "timestamp": "2026-07-19T12:00:00.000Z",
  "valid_from": "2026-07-19T12:00:00.000Z",
  "valid_until": "2026-12-31T23:59:59.000Z",
  "author": "alice@example.com",
  "isTombstone": false,
  "action": "add"
}
```

**Example:**

```bash
curl -X POST http://localhost:3000/api/memories \
  -H "Content-Type: application/json" \
  -d '{"key":"/projects/myapp/database","domain":"concept","content":"Using PostgreSQL"}'
```

#### `PUT /api/memories/:id`

Update a memory by ID. Creates a tombstone for the old version and saves a new one.

**Request:**

```json
{
  "content": "Updated: Using PostgreSQL with pgx driver",
  "attributes": { "confidence": "final" }
}
```

**Response:**

```json
{
  "id": "new-uuid-string",
  "key": "/projects/myapp/database",
  "domain": "concept",
  "content": "Updated: Using PostgreSQL with pgx driver",
  "attributes": { "confidence": "final" },
  "timestamp": "2026-07-19T13:00:00.000Z",
  "author": "alice@example.com",
  "isTombstone": false,
  "action": "update"
}
```

#### `DELETE /api/memories/:id`

Delete a memory (soft delete — creates a tombstone record). Returns 204 No Content on success.

**Example:**

```bash
curl -X DELETE http://localhost:3000/api/memories/a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

---

### Keys

#### `GET /api/keys`

Get hierarchical memory key tree.

| Query Param | Default | Description |
|-------------|---------|-------------|
| `prefix` | `/` | Key prefix filter |
| `depth` | 10 | Max hierarchy depth |
| `limit` | 100 | Max keys to return |
| `namespace` | `default` | Namespace to query |

**Response:**

```json
{
  "tree": [
    {
      "id": "/projects",
      "name": "projects",
      "path": "/projects",
      "type": "folder",
      "children": [
        {
          "id": "/projects/myapp",
          "name": "myapp",
          "path": "/projects/myapp",
          "type": "folder",
          "children": [],
          "isExpanded": false,
          "memoryCount": 5
        }
      ],
      "isExpanded": false,
      "memoryCount": 5
    }
  ],
  "total": 1
}
```

**Example:**

```bash
curl "http://localhost:3000/api/keys?prefix=/projects/myapp&depth=3"
```

#### `GET /api/keys/flat`

Get flat list of keys (for autocomplete, dropdowns).

| Query Param | Default | Description |
|-------------|---------|-------------|
| `prefix` | `/` | Key prefix filter |
| `limit` | 100 | Max keys to return |
| `offset` | 0 | Pagination offset |
| `namespace` | `default` | Namespace to query |

**Response:**

```json
{
  "keys": ["/projects/myapp/database", "/projects/myapp/auth"],
  "total": 2,
  "hasMore": false,
  "nextOffset": null,
  "prefixes": {}
}
```

---

### Namespaces

#### `GET /api/namespaces`

List all namespaces.

**Response:**

```json
{
  "namespaces": [
    {
      "name": "default",
      "path": "./namespaces/default",
      "isDefault": true,
      "memoryCount": null,
      "lastModified": null
    },
    {
      "name": "my-project",
      "path": "./namespaces/my-project",
      "isDefault": false,
      "memoryCount": null,
      "lastModified": null
    }
  ],
  "currentNamespace": "default"
}
```

**Example:**

```bash
curl http://localhost:3000/api/namespaces
```

#### `POST /api/namespaces`

Create a new namespace.

**Request:**

```json
{
  "name": "my-project",
  "setDefault": false
}
```

**Response:** (201 Created)

```json
{
  "name": "my-project",
  "path": "./namespaces/my-project",
  "isDefault": false
}
```

#### `POST /api/namespaces/switch`

Switch the active namespace.

**Request:**

```json
{
  "name": "my-project"
}
```

**Response:**

```json
{
  "success": true,
  "previous": "default",
  "current": "my-project"
}
```

#### `DELETE /api/namespaces/:name`

Delete a namespace: removes the namespace directory recursively (current.jsonl, `.git`, `.embeddings` — everything) and unregisters it from the config. Same guarded deletion core as the MCP `delete_namespace` tool (DOGFOOD-004).

**Request body** — explicit confirmation is REQUIRED:

```json
{
  "confirm": true
}
```

Anything other than exactly `true` is rejected with 400 `VALIDATION_ERROR` and nothing is removed.

**Behavior:**
- 200 — namespace deleted (`path` in the response is the removed directory).
- 400 `VALIDATION_ERROR` — `confirm` missing/not `true`; invalid namespace name; attempting to delete the `default` namespace or the currently-active namespace; a config mapping resolving outside the namespaces root is refused.
- 404 `NOT_FOUND` — namespace has no mapping (idempotent: deleting an already-deleted namespace is a clean 404, deleting twice is safe).

**Example:**

```bash
curl -X DELETE http://localhost:3000/api/namespaces/orphaned-ns \
  -H "Content-Type: application/json" \
  -d '{"confirm": true}'
```

**Response:**

```json
{
  "success": true,
  "path": "./namespaces/orphaned-ns"
}
```

---

### Events (SSE)

#### `GET /api/events/:namespace`

Server-Sent Events endpoint for real-time memory updates. Supports the `text/event-stream` content type.

**Example:**

```bash
curl -N http://localhost:3000/api/events/default
```

Stream format:

```
data: {"type":"connected","timestamp":"...","namespace":"default"}

:heartbeat

data: {"type":"memory:created","data":{...},"timestamp":"..."}
```

#### `POST /api/events/:namespace/broadcast`

Broadcast an event to all connected SSE clients in a namespace.

**Request:**

```json
{
  "type": "memory:created",
  "data": { "key": "/projects/myapp/database" }
}
```

**Response:**

```json
{
  "success": true,
  "namespace": "default",
  "connectionsNotified": 2,
  "event": { "type": "memory:created", "data": {}, "timestamp": "..." }
}
```

#### `GET /api/events/:namespace/stats`

Get SSE connection statistics for a namespace.

**Response:**

```json
{
  "namespace": "default",
  "activeConnections": 2,
  "allNamespaces": [
    { "namespace": "default", "connections": 2 }
  ]
}
```

---

### Compaction

Compaction operates on the current namespace's git-backed memory store (see `POST /api/namespaces/switch`).

#### `GET /api/compaction/stats`

Get repository compaction statistics including tombstone percentage, Parquet ratio, and partition health.

**Example:**

```bash
curl http://localhost:3000/api/compaction/stats
```

**Response:**

```json
{
  "success": true,
  "stats": {
    "totalSize": 1048576,
    "totalPartitions": 12,
    "parquetPartitions": 8,
    "jsonlPartitions": 4,
    "totalRecords": 5230,
    "tombstoneRecords": 412,
    "tombstonePercent": 7.9,
    "parquetRatio": 0.67,
    "oldPartitions": ["2024-01", "2024-02"],
    "largePartitions": [
      { "path": "2024-03", "size": 524288, "records": 1200 }
    ]
  }
}
```

#### `POST /api/compaction/squash`

Compact old memory partitions to reduce repository size. Converts JSONL to Parquet, removes tombstones, and optionally squashes git history.

**Request (all fields optional):**

```json
{
  "partition": "2024-01",
  "dryRun": true,
  "aggressive": false
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `partition` | string | — | Specific partition to squash (relative to the namespace path, or absolute). Omit to compact all old partitions. |
| `dryRun` | boolean | `false` | Preview without making changes. |
| `aggressive` | boolean | `false` | Also squash git history. |

**Example:**

```bash
curl -X POST http://localhost:3000/api/compaction/squash \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'
```

**Response:**

```json
{
  "success": true,
  "message": "Preview: Would compact 3 partitions (4800 records kept, 400 removed)",
  "stats": {
    "partitionsCompacted": 3,
    "totalRecordsKept": 4800,
    "totalRecordsRemoved": 400,
    "tombstonesRemoved": 400
  },
  "errors": []
}
```

---

## Authentication

The HTTP server supports three authentication modes configured via `--auth` or `~/.duckbrain/auth.json` (see [Configuration](../guide/configuration) for details).

| Mode | Mechanism | Header |
|------|-----------|--------|
| `none` | No authentication | — |
| `basic` | HTTP Basic Auth (bcrypt) | `Authorization: Basic ...` |
| `apikey` | API key in header | `X-API-Key: <key>` |

The `/health` endpoint always bypasses authentication.

### Using API Key Authentication

```bash
# Start server with API key auth
pnpm start -- http --auth=apikey

# Configure keys in ~/.duckbrain/auth.json
# {"apiKeys": [{"key": "sk-duckbrain-abc123", "name": "default"}]}

# Authenticated request
curl http://localhost:3000/api/memories \
  -H "X-API-Key: sk-duckbrain-abc123"
```

#### Per-Token Namespace Grants

API key entries may carry an optional `namespaces` array restricting the
token to exactly those namespaces:

```json
{
  "apiKeys": [
    { "key": "sk-duckbrain-abc123", "name": "default" },
    { "key": "sk-duckbrain-scoped-456", "name": "agent-alpha", "namespaces": ["my-project"] }
  ]
}
```

- `namespaces` **absent** → unrestricted token (backward compatible —
  existing tokens keep full access to every namespace).
- `namespaces` **present** → the token may read, write, update, delete, and
  create only the listed namespaces. Requests targeting any other namespace
  are rejected with `403 Forbidden` (checked before the route runs, for
  reads AND writes AND namespace creation).
- `/health` always bypasses authentication and grants.

#### Minting a Scoped Token

```bash
# Unrestricted token (default)
duckbrain token --name=agent-alpha

# Scoped token — repeatable and/or comma-separated grants
duckbrain token --name=agent-alpha --namespace=my-project
duckbrain token --name=agent-alpha --namespace=my-project,chat-archive
duckbrain token --name=agent-alpha --namespace=my-project --namespace=chat-archive
```

The command prints the token and records the grants in `~/.duckbrain/auth.json`:

```json
{
  "apiKeys": [
    { "key": "<generated>", "name": "agent-alpha", "namespaces": ["my-project", "chat-archive"] }
  ]
}
```

#### Author Stamping

When a request is authenticated (`--auth=apikey` or `--auth=basic`), every
memory write — create, update, and delete — stamps the stored record's
`author` field from the authenticated principal. Any client-supplied
`?author=` query parameter or author field in the request body is
**ignored** on write paths, so tokens cannot spoof another identity and
per-agent provenance is preserved in the namespace git history.

The memory schema requires an email-shaped author, so the principal is
mapped as follows:

- `name` is already an email (e.g. `agent@example.com`) → used as-is.
- otherwise → `<name>@duckbrain.local` (e.g. token `agent-alpha` stamps
  `agent-alpha@duckbrain.local`). Whitespace is folded to `-`.

In `--auth=none` mode (local single-user) there is no principal and the
existing fallback applies: git `user.email`, then `GIT_AUTHOR_EMAIL`, then
the built-in default (see `src/git/attribution.ts`). `?author=` on
`GET /api/memories` remains a read-side filter in all modes.

### Using Basic Authentication

```bash
# Configure users in ~/.duckbrain/auth.json
# {"users": [{"username": "admin", "passwordHash": "$2a$10$..."}]}

curl http://localhost:3000/api/memories \
  -u "admin:password"
```

---

## Rate Limiting

The HTTP server uses a token bucket rate limiter with per-IP tracking. Default: 100 requests per minute per IP.

Rate limit headers are included in every response:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Requests per minute configured |
| `X-RateLimit-Remaining` | Remaining requests in current window |
| `Retry-After` | Seconds to wait when rate limited |

When rate limited, the server returns HTTP 429:

```json
{
  "error": "Rate limit exceeded",
  "retryAfter": 30
}
```

---

## DNS Rebinding Protection

When not using `--bind-all`, the HTTP server validates the `Host` header against a whitelist (`localhost`, `127.0.0.1`) and returns 403 `Forbidden: Invalid host` for unrecognized hosts.

---

## Error Handling

All errors return structured JSON responses:

```json
{
  "error": "Description of what went wrong",
  "code": "ERROR_CODE"
}
```

### HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 201 | Created |
| 204 | No Content (successful delete) |
| 301 | Redirect (legacy endpoints) |
| 400 | Validation error |
| 401 | Authentication required |
| 403 | Forbidden (DNS rebinding protection) |
| 404 | Resource not found |
| 409 | Conflict (e.g., namespace already exists) |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

### Error Codes

| Code | Description |
|------|-------------|
| `VALIDATION_ERROR` | Invalid input data, may include `fields` object |
| `NOT_FOUND` | Resource not found |
| `ROUTE_NOT_FOUND` | Route does not exist |
| `INVALID_JSON` | Malformed JSON in request body |
| `INTERNAL_ERROR` | Unexpected server error |

---

## CORS

All endpoints include CORS headers allowing cross-origin requests:

| Header | Value |
|--------|-------|
| `Access-Control-Allow-Origin` | `*` |
| `Access-Control-Allow-Methods` | `GET, POST, PUT, DELETE, OPTIONS` |
| `Access-Control-Allow-Headers` | `Content-Type, Authorization` |
