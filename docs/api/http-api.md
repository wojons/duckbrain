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
| `--auth-file` | `~/.duckbrain/auth.json` | Read auth users/apiKeys from this file instead (env fallback: `DUCKBRAIN_AUTH_FILE`); the file must exist — intended for scratch/test daemons |
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
  "timestamp": "2026-07-19T12:00:00.000Z",
  "embedding": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "healthy": true,
    "providers": [
      {
        "id": "lmstudio",
        "healthy": false,
        "note": "no models loaded"
      },
      {
        "id": "ollama",
        "healthy": true,
        "note": ""
      },
      {
        "id": "openai",
        "healthy": false,
        "note": "missing API key (DUCKBRAIN_EMBEDDING_API_KEY)"
      }
    ]
  },
  "keys_error": null,
  "durability": {
    "defaultMode": "buffered",
    "overrides": {
      "analytics": "fsync"
    }
  },
  "deadline_exceeded": []
}
```

Status is `degraded` when no embedding provider can embed
(`embedding.healthy: false`, `embedding.provider` empty, per-provider
`note` explains why) or when the keys store probe fails
(`keys_error` carries a short error string instead of `null`).
Since OPS-004 a failing provider's `note` also names the failure CLASS for the
auth / timeout / empty-vector cases (`"auth: credential not presented …"`,
`"timeout: the embed probe exceeded its 3000ms health budget …"`) so an
operator can tell "the credential never arrived" from "the credential was
rejected" without decoding provider JSON; other classes keep the raw provider
string. For the reachable-but-unusable state (`/models` 200 while every embed
fails) run `pnpm ops:embedding-preflight` — it fails closed and never prints
the key. A degraded
`/health` returns HTTP **503** with `status: "degraded"` in the body; a
healthy service returns HTTP **200** with `status: "healthy"` — a
supervisor watching HTTP codes sees non-200 while embeddings are down
(GAP-030). Semantic endpoints (`/api/memories?q=`, MCP recall with a
query) return HTTP 503 `EMBEDDINGS_UNAVAILABLE` while embeddings are down;
non-semantic reads still work.

Every await in the handler is bounded (OPS-002): `/health` **always**
answers within `HEALTH_HANDLER_DEADLINE_MS` (4000ms). A sub-probe that does
not settle in its share of that budget is abandoned and reported as
`deadline_exceeded: ["embedding"]` (or `["keys"]`) with HTTP 503 +
`status: "degraded"`, and the corresponding section's `note` / `keys_error`
says so. The array is empty on a normal response. This closes the failure
mode where one never-settling probe left `/health` parked forever while the
daemon kept serving `/stats` and `/api/*` — monitors and the dark-port
watchdog were blind, and a hung daemon looked identical to a dead one.

`durability` reports the write durability contract (SUPA-1) derived from
config only — `defaultMode` plus the **non-default** per-namespace
overrides, so the payload stays bounded. It is never a filesystem probe:
`/health` cannot fail or stall over durability reporting. See
[Write Durability (SUPA-1)](#write-durability-supa-1).

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

### Write Durability (SUPA-1)

Every namespace has an explicit write-durability contract, configured in
`duckbrain.config.json`:

```json
{
  "durability": {
    "defaultMode": "buffered",
    "overrides": { "analytics": "fsync" }
  }
}
```

`DUCKBRAIN_DURABILITY_MODE=buffered|fsync|direct` overrides the runtime
default (never persisted). Precedence:
`overrides[<namespace>]` > `DUCKBRAIN_DURABILITY_MODE` > `defaultMode` >
`buffered`. An invalid value in either place **fails config load with a zod
error** — there is no silent fallback to buffered, because a silently
buffered namespace means acknowledged writes that are not durable while the
operator believes they are.

| Mode | Append mechanism | Barrier before the 2xx | RPO for acked writes (single node) |
|---|---|---|---|
| `buffered` (default) | `appendFileSync` — page cache | none | Process-kill safe (the page cache outlives the process). **OS crash / power loss: the loss window is unbounded — recent acked writes can be lost.** |
| `fsync` | `open`/`write`/`fdatasync`/`close` + `fsync` on the parent directory when a file or directory was created | file `fdatasync` **and** directory `fsync` complete | **0** on a single node: survives process kill, OS crash and power loss |
| `direct` | `O_DIRECT` append (page cache bypassed) over SUPA-2 block-framed records, same commit protocol as `fsync` | same as `fsync` | **0** |

**RPO to git / S3:** unchanged in every mode. Git commits stay debounced by
`gitBatching.maxSeconds` (default **30 s**), and with `s3.pushOnCommit` the
S3 remote rides the same window. In `fsync`/`direct` mode the JSONL is
already durable, so the commit is history transport, not the durability
mechanism. RPO = 0 is a **single-node** claim: there is no synchronous
cross-machine replication.

**Response header:** every successful (2xx) write response carries
`X-Durability: buffered|fsync|direct`, resolved from the namespace actually
written. Denied or failed writes never emit it.

**Failure modes are loud** (HTTP 500 with the code in the error envelope,
never a silent downgrade):

| Code | Meaning |
|---|---|
| `DURABILITY_UNSUPPORTED` | The filesystem rejects `O_DIRECT` (tmpfs, overlayfs). No byte is written. |
| `DURABILITY_DIRECT_FRAME_ERROR` | A bare (unframed) append to a `direct`-mode namespace; SUPA-2 block framing is required. |
| `DURABILITY_FSYNC_FAILED` | `fdatasync`/`fsync` failed (e.g. `EIO`). The record may or may not be on disk; it is **never acknowledged**. |
| `DURABILITY_DIR_FSYNC_UNSUPPORTED` | Directory `fsync` unsupported (some NFS mounts return `EINVAL`). Acked RPO would be a lie, so the write fails. |

> **Contract note:** in `fsync`/`direct` mode a durable namespace must be
> written through the durability appenders (and, once SUPA-2 lands, the
> namespace serializer). A direct buffered-path append to such a namespace
> fails with `500 DURABILITY_BYPASS`. Tombstone appends (`forgetTool`) still
> use the buffered path and are outside the RPO = 0 claim until SUPA-2 owns
> every filesystem write.

### Memories

> **Note — same-key multi-version (SUPA-2 / DB-GAP-045):** same-key writes are
> **append-only multi-version**, never last-write-wins. N concurrent (or
> sequential) writes to one key are N independent versions with distinct
> `id`s — nothing is overwritten, and a key has no privileged "current"
> version. `GET /api/memories/key/:key` returns the most recent
> non-tombstoned version, while the list route returns all of them. Versions
> are ordered `timestamp DESC, id ASC`: deterministic per dataset (repeated
> calls return the same order) but **not write order** within one millisecond
> — the `id` tiebreak is a random UUIDv4, so a client that needs
> same-millisecond ordering must use its own ACK order. The process-local
> serializer `seq` is not durable and is not a cursor.

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

> **Note — semantic search (`?q=`) and embeddings (DB-GAP-036):** `?q=` needs a reachable embedding provider at query time (LM Studio / Ollama with a loaded embedding model, or `DUCKBRAIN_EMBEDDING_API_KEY` for the `openai` provider). When no provider can embed, the endpoint returns **503 `EMBEDDINGS_UNAVAILABLE`** with an explicit message telling you to start an embedding provider or run `duckbrain embeddings rebuild` — never a silent unfiltered list. Keyword search (`?contains=`) works offline; its per-namespace index is refreshed automatically when it is missing or older than the newest write (bounded and single-flight — `DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS`, default 5000 source rows), with `duckbrain search-index rebuild` as the escape hatch for namespaces over that bound. Check `GET /health` — its `embedding` block reports provider health.

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

> **Note — validity window (RETR-011):** `valid_from` / `valid_until` are optional ISO-8601 datetimes. Omitted = the memory is valid from the moment of writing, indefinitely. A past `valid_until` (or future `valid_from`) keeps the memory out of the default current recall view; it remains visible with `?historical=true` on `GET /api/memories`. The camelCase spellings `validFrom` / `validUntil` are accepted as aliases on this endpoint and mapped onto the canonical snake_case fields (if both spellings are sent, snake_case wins); responses always echo snake_case only.

> **Note — namespace selection:** The target namespace may be passed either as the `?namespace=` query parameter **or** as a `"namespace"` field in the JSON body. When both are present the query parameter wins; the body value is the fallback; when neither is supplied the memory is written to the `default` namespace.

> **Note — field naming across surfaces:** The HTTP API accepts `content` for the memory body. This maps directly to the MCP `remember` tool's `embedding_text` field — both surfaces store and return the **same** underlying text field (see [MCP Tools Reference](mcp-tools.md#remember)). A memory written via HTTP with `content` is retrievable via MCP `recall` with the text in `embedding_text`, and vice versa.

> **Note — write durability (SUPA-1):** the response carries
> `X-Durability: buffered|fsync|direct` for the namespace actually written.
> In `fsync`/`direct` mode the `fdatasync` + directory `fsync` complete
> **before** the 201 is sent (RPO = 0 for acked writes on a single node); in
> `buffered` mode the write is a page-cache append with the documented
> OS-crash/power-loss window. See
> [Write Durability (SUPA-1)](#write-durability-supa-1).

> **Note — write timestamp (DB-GAP-045):** the 201 body's `timestamp` is the
> **persisted write timestamp of the stored version** — the exact value on
> the JSONL row for the returned `id` — not a response-time stamp. A client
> can therefore correlate its ACK with the stored version by the
> `id` + `timestamp` pair. (Before DB-GAP-045 this field carried a
> response-time value that did not match the stored row.)

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

### Declared Tables (SUPA-3/SUPA-6)

PostgREST-style row access over **declared** tables.

The route layer never auto-introspects the filesystem: only tables the
namespace itself declares become REST resources. A JSONL file that exists on
disk without a declaration is not reachable, a request for an undeclared table
is a plain `404 NOT_FOUND` (never a trigger to go find the file), and the
declaration is the single source of truth for the exposed columns and their
types — filter keys, `order` columns, and PATCH bodies are all validated
against it.

Declarations come from either of two sources:

| Source | Location | Notes |
|---|---|---|
| Persistent schema (SUPA-6) | `namespaces/<ns>/schema.json` | Its `keyColumns` supply the primary key; inserts ride the SUPA-2 serializer (validation → ordered write → audit/change record → commit). |
| Legacy table declaration | `namespaces/<ns>/tables/<table>.table.json` | Historical direct-append path, no `schema.json` serializer involvement. |

Every route below is wrapped in the namespace-grant check exactly like
`/api/namespaces`: a token whose grants do not cover `<ns>` is rejected with
`403 Forbidden` before the handler runs.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/ns/:ns/tables` | List declared tables |
| `GET` | `/api/ns/:ns/tables/:table` | Read rows (filter / order / page) |
| `POST` | `/api/ns/:ns/tables/:table` | Insert row(s) |
| `PATCH` | `/api/ns/:ns/tables/:table?pk=eq.<value>` | Update rows by primary key |
| `DELETE` | `/api/ns/:ns/tables/:table?pk=eq.<value>` | Delete rows by primary key |
| `GET` | `/api/ns/:ns/openapi.json` | Generated OpenAPI 3.1 document |

#### `GET /api/ns/:ns/tables` — discovery

Lists the namespace's declarations. Columns, types, and the primary key are
reported from the declaration itself, so this is the authoritative way to learn
what a namespace exposes:

```bash
curl http://localhost:3000/api/ns/my-ns/tables
```

```json
{
  "namespace": "my-ns",
  "tables": [
    {
      "name": "items",
      "format": "jsonl-object",
      "columns": [
        { "name": "id", "type": "bigint" },
        { "name": "name", "type": "string" },
        { "name": "qty", "type": "integer" },
        { "name": "meta", "type": "json" }
      ],
      "primary": "id",
      "glob": "tables/items/current.jsonl"
    }
  ]
}
```

#### `GET /api/ns/:ns/tables/:table` — filtered row read

Returns a JSON array of rows (declared `json` columns come back as real JSON
values, not strings).

**Filters** are `<column>=<op>.<value>` query parameters, using PostgREST
conventions:

| Operator | Meaning |
|---|---|
| `eq` | Equal |
| `ne` | Not equal |
| `gt` / `gte` | Greater than / greater than or equal |
| `lt` / `lte` | Less than / less than or equal |
| `like` | SQL `LIKE` pattern (`%` wildcards) |
| `in` | Membership in a parenthesized list |

- A value with no operator prefix is `eq`: `?qty=5` is `?qty=eq.5`.
- `in` takes a comma-separated, parenthesized list:
  `?name=in.(widget,gadget)`.
- Several filters AND together: `?qty=gte.10&name=like.wid%25`.
- An unknown filter column (`?typo=eq.1`) returns
  `400 VALIDATION_ERROR`, and the error names the declared columns. A
  querystring key that is neither a declared column nor shaped like
  `op.value` is ignored, so tracing/cache-busting parameters pass through.
- An unknown operator (`?qty=between.1`) returns `400 VALIDATION_ERROR`
  listing the allowed operators.

**Ordering:** `order=<column>.asc` or `order=<column>.desc`, comma-separated
for multiple keys (`order=qty.desc,name.asc`).

**Paging:** `limit` defaults to **100** and has a hard cap of **1000** —
a larger value is clamped to 1000, not rejected. `offset` is 0-based.

**Exact count:** send `Prefer: count=exact` (equivalently `?count=exact`) and
the response carries `X-Total-Count` with the total number of matching rows
before `limit`/`offset` are applied.

**CSV:** send `Accept: text/csv` to get `text/csv; charset=utf-8`. The header
row is the declared columns in declaration order; nested JSON values are
serialized compactly and RFC-4180 quoted.

```bash
# Filter + order + page + exact count
curl -i "http://localhost:3000/api/ns/my-ns/tables/items?qty=gte.10&name=like.wid%25&order=qty.desc&limit=50&offset=0" \
  -H "Prefer: count=exact"
# → 200, X-Total-Count: 12

# Same query as CSV
curl "http://localhost:3000/api/ns/my-ns/tables/items?qty=gte.10" \
  -H "Accept: text/csv"
```

#### `POST /api/ns/:ns/tables/:table` — insert

Two body forms, both returning `201`:

- `Content-Type: application/json` with a single JSON object, or an array of
  objects for a batch.
- `Content-Type: application/x-ndjson` with **one JSON object per line** (the
  body size limit for this content type is `1mb`).

```json
{ "inserted": 2 }
```

An empty body, a non-object/array JSON body, or a malformed/empty NDJSON body
returns `400 VALIDATION_ERROR`. Rows are coerced against the declared column
types before writing.

```bash
# Single object
curl -X POST http://localhost:3000/api/ns/my-ns/tables/items \
  -H "Content-Type: application/json" \
  -d '{"id": 1, "name": "widget", "qty": 5, "meta": {"color": "red"}}'

# NDJSON batch — Content-Type is what selects the NDJSON parser
curl -X POST http://localhost:3000/api/ns/my-ns/tables/items \
  -H "Content-Type: application/x-ndjson" \
  --data-binary '{"id": 2, "name": "gadget", "qty": 12}
{"id": 3, "name": "widget", "qty": 30}'
```

#### `PATCH` / `DELETE` — mutation by primary key

Both require an equality filter on the table's declared primary key:

```
/api/ns/:ns/tables/:table?pk=eq.<value>
```

- A missing `?pk=` or a `pk` value without the `eq.` prefix returns
  `400 VALIDATION_ERROR` — there is no bare-column filter form.
- A table that declares no primary key cannot be mutated this way:
  `400 VALIDATION_ERROR`.
- `PATCH` takes a JSON **object** of column values (not an array); an unknown
  column name in the body returns `400 VALIDATION_ERROR`.

```bash
# Update every row whose primary key equals 2
curl -X PATCH "http://localhost:3000/api/ns/my-ns/tables/items?pk=eq.2" \
  -H "Content-Type: application/json" \
  -d '{"qty": 15}'
# → { "updated": 1 }

# Delete that row
curl -X DELETE "http://localhost:3000/api/ns/my-ns/tables/items?pk=eq.2"
# → { "deleted": 1 }
```

> **v1 semantics:** these are table-row mutations over the append-log storage
> reality — the matching rows are rewritten in the table's JSONL file. There is
> no query-rewrite engine and no WAL, and no bare-column or range predicate is
> accepted: the only filter a mutation honours is the primary-key equality
> above.

#### `GET /api/ns/:ns/openapi.json` — generated OpenAPI 3.1

An OpenAPI 3.1 document generated from the namespace's registry on every
request (never a hand-written blob), so it always reflects the current
declarations: one path per declared table, one query parameter per declared
column with the operator conventions, the `limit` default/maximum, the POST
content types (`application/json`, `application/x-ndjson`), the required `pk`
parameter on PATCH/DELETE, and the declared column types as the row schema.

```bash
curl http://localhost:3000/api/ns/my-ns/openapi.json
```

**Error summary**

| Status | Code | Cause |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Unknown filter column or operator; bad `limit`; empty/non-object insert body; malformed NDJSON; missing or non-`eq.` `pk`; PATCH on a table with no primary key; unknown column in a PATCH body |
| `403` | `FORBIDDEN` | The token has no namespace grant for `<ns>` |
| `404` | `NOT_FOUND` | No such declared table in the namespace |
| `503` | serializer codes | `schema.json`-backed inserts only: the namespace lock is held (`SERIALIZER_LOCKED` / `SERIALIZER_FENCED`) or the server is shutting down |

---

### Realtime Change Feed (SUPA-5)

`GET /api/ns/:ns/changes`

Server-Sent Events stream of **committed** changes to one namespace. A change
is published only after the namespace git commit containing both its data row
and its accepted audit row exists — the feed never exposes pending, uncommitted
writes, and every event is resumable after a server restart. WebSocket is not
part of v1; SSE is the only transport.

> **Legacy distinction:** the older `/api/events/:namespace` scaffold above is
> a **different, incompatible contract**. Its unversioned `connected` /
> `memory:*` payloads, broadcast POST, and connection stats share no state with
> this route, offer no resume or replay, and must not be used as a change feed.
> The change feed is always `duckbrain.change.v1` (event name carries the
> version); the legacy route's payloads are unversioned.

Requires the [namespace grant](#per-token-namespace-grants) for `:ns` plus
`tables.read` on every selected table (SUPA-4). The namespace must already
exist — an unknown namespace is a clean `404 NOT_FOUND` before any stream byte
is written.

#### Subscription grammar

| Query param | Grammar | Semantics |
|---|---|---|
| `tables` | absent, or comma-separated declared table names | absent = every table the principal may read (always includes the built-in `memories` plus declared tables); present = allow-list. Duplicates or empty tokens are `400 INVALID_SUBSCRIPTION`. An unauthorized or unknown table fails the **whole** request (`403` / `400`) before any byte — never a partial stream. |
| `ops` | absent, or comma-separated subset of `insert,update,delete` | absent = all three. Unknown token is `400 INVALID_SUBSCRIPTION`. |
| `cursor` | one opaque cursor (see below) | Resume strictly after that committed event. Mutually exclusive with a *non-identical* `Last-Event-ID` header (`400` when both are supplied and differ). |

A successful response is `200 text/event-stream` with
`Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, and
`X-Accel-Buffering: no`. All subscription failures are returned as ordinary
JSON errors **before** the headers switch to SSE, so a rejected request never
produces a partial stream.

**Example — subscribe to all readable tables:**

```bash
curl -N "http://localhost:3000/api/ns/my-project/changes" \
  -H "X-API-Key: $DUCKBRAIN_API_KEY"
```

**Example — filter to inserts/updates on one table:**

```bash
curl -N "http://localhost:3000/api/ns/my-project/changes?tables=memories&ops=insert,update" \
  -H "X-API-Key: $DUCKBRAIN_API_KEY"
```

#### Wire schema

The first frame is always a control event (no SSE `id`):

```
event: duckbrain.ready.v1
data: {"version":1,"namespace":"my-project","head":"dbch1.<…>|null"}
```

`head` is the latest committed cursor, or `null` when the namespace has no
committed change yet. Then one `duckbrain.change.v1` per committed change:

```
event: duckbrain.change.v1
id: dbch1.<…>
data: {"version":1,"cursor":"dbch1.<…>","namespace":"my-project","table":"memories","op":"insert","row":{…},"position":{"commit":"<40-hex sha>","ordinal":3},"committedAt":"2026-09-17T12:00:00.000Z","tombstone":false,"schemaVersion":1,"key":{"id":"<uuid>"}}
```

| Field | Required | Rule |
|---|---:|---|
| `version` | yes | integer literal `1` |
| `cursor` | yes | opaque restart-safe cursor; identical to the SSE `id` |
| `namespace` | yes | equals the route `:ns` |
| `table` | yes | declared table name (built-in `memories` included) |
| `op` | yes | `insert`, `update`, or `delete` |
| `row` | yes | post-operation row image; for `delete` the appended **tombstone row** — never `null` |
| `position` | yes | `{ commit: <40-hex SHA>, ordinal: <positive int> }` |
| `committedAt` | yes | ISO-8601 creation time of the containing commit (not client time) |
| `tombstone` | yes | `true` only for `delete` |
| `schemaVersion` | yes | declared table schema version (`1` for `memories`) |
| `key` | yes | every declared key column and value (`{"id": <id>}` for `memories`) |

Unknown fields must be ignored by v1 consumers; required fields are always
present.

**Heartbeat:** a `: heartbeat` SSE comment every `realtime.heartbeatMs`
(default **15 s**). It is sent only while the subscriber is keeping up (empty
queue, unblocked socket). Use it to detect half-open proxies; it carries no
state.

#### Cursor: the `dbch1` format and resume

A cursor is opaque ASCII: `dbch1.<base64url(canonical-json)>` where the JSON is
exactly `{"v":1,"ns":"<name>","commit":"<40-hex SHA>","ordinal":<n>}` — keys in
that order, no whitespace, **not signed**. Treat it as a black box: store it
verbatim and replay it verbatim; never construct, decode-and-re-encode, or
persist a modified cursor. The server validates the exact canonical encoding,
version, namespace match, and that the position is reachable from retained
first-parent history — anything else is `400 INVALID_CURSOR`.

**Resume (equivalent forms):** pass the last persisted cursor as `?cursor=` or
as the SSE-standard `Last-Event-ID` header — event-source clients get the
latter automatically:

```bash
# Explicit query param
curl -N "http://localhost:3000/api/ns/my-project/changes?cursor=dbch1.<stored>" \
  -H "X-API-Key: $DUCKBRAIN_API_KEY"

# Last-Event-ID form (what a browser EventSource sends after reconnect)
curl -N "http://localhost:3000/api/ns/my-project/changes" \
  -H "Last-Event-ID: dbch1.<stored>" \
  -H "X-API-Key: $DUCKBRAIN_API_KEY"
```

Replay is strictly after the cursor, in committed order, with no gap before
live delivery begins. A cursor that is older than the retained window
(configurable: `realtime.maxReplayEvents` default 10 000 events /
`maxReplayCommits` default 10 000 commits / `retentionDays` default 7 days) or
whose commit was pruned is:

```
410 CHANGE_CURSOR_GONE
{"error":"…","code":"CHANGE_CURSOR_GONE","guidance":"Reconnect without a cursor to perform a full resync."}
```

**410 recovery is a full resync, not a retry:** reconnecting alone does NOT
recover — the retained window is the entire replayable history. To resync,
reconnect **without** a cursor (live-only from now), take a fresh snapshot via
`GET /api/memories?namespace=<ns>&limit=…` pagination, and reconcile rows
idempotently by declared key (memories: `id`). The stream buffers subscribed
commits while you snapshot, so reconciliation over snapshot ∪ buffered events
converges; there is no atomic snapshot+stream API in v1 — a row can change
between your snapshot read and the buffered event that describes it, so apply
events by committed order (compare `position`) rather than letting snapshot
data overwrite newer buffered events.

**Live-only, no cursor:** subscribing without a cursor streams changes
committed **from now on** (strictly after the subscription's HEAD). It does not
replay past history; that is what the cursor resume is for.

#### Ordering and delivery guarantees

- **Committed-only:** a write is invisible (and cursor-less) until its
  namespace git commit lands. Delivery is driven by observed reachable HEAD
  movement (post-flush notification plus a 1 s poll
  (`realtime.pollIntervalMs`)), never by timers alone.
- **Namespace ordering:** a total order **within one namespace subscription
  only** — first-parent commit order oldest→newest, canonical audit-ledger
  order within a commit (`position.ordinal`). No ordering claim across
  namespaces or across concurrent client requests.
- **At-least-once, dedupe required:** delivery is at-least-once, never
  exactly-once. A disconnect after the server wrote bytes but before you
  persisted the id can yield a duplicate on resume. Deduplicate by `cursor`
  (or `position.commit` + `position.ordinal`) and apply rows idempotently by
  declared key.
- **Overflow isolation:** a subscriber that stops draining is disconnected
  **alone** once its queue exceeds `maxQueueEvents` (default 256) or
  `maxQueueBytes` (default 1 MiB). It receives `event: duckbrain.overflow.v1`
  with its last delivered cursor, then the connection closes; healthy
  subscribers on the same namespace are unaffected. Resume from the overflow
  cursor; if it is now outside the retained window you get `410` (resync as
  above).
- **Authorization revocation:** grants are re-checked before every live
  enqueue. A revoked grant ends the stream with
  `event: duckbrain.revoked.v1` then close — no further rows leak.
- **History rewrite:** a squash/compaction that rewrites first-parent history
  re-anchors the feed on the new HEAD (already-delivered events are not
  withdrawn); old cursors may become unreachable (`400` / `410` per the rules
  above) — resync after a rewrite.
- **Corrupt changelog:** a replay-integrity violation (segment rewrite, gap,
  data/audit mismatch, …) fails the feed with `500 CHANGELOG_CORRUPT` rather
  than silently skipping an event. Requires operator repair.

#### Error codes

| Status | `code` | When |
|---|---|---|
| 400 | `INVALID_SUBSCRIPTION` | Bad grammar: unknown/duplicate/empty `tables`/`ops` token, `cursor` + differing `Last-Event-ID` |
| 400 | `INVALID_CURSOR` | Not a canonical `dbch1` cursor, wrong namespace, unreachable position |
| 403 | `FORBIDDEN` | Missing namespace grant or `tables.read` (all-or-nothing) |
| 404 | `NOT_FOUND` | Namespace does not exist, or realtime feed disabled (`realtime.enabled: false`) |
| 410 | `CHANGE_CURSOR_GONE` | Cursor commit pruned or outside the retained window → full resync (reconnect without cursor + fresh snapshot) |
| 503 | `SUBSCRIBER_LIMIT` | Process-wide subscriber cap (`maxSubscribers`, default 100) reached — retry with backoff |

**Example — subscribe, then resume after restart:**

```bash
# Terminal 1: subscribe and persist the last seen id (jq extracts the SSE id lines)
curl -Ns "http://localhost:3000/api/ns/my-project/changes" \
  -H "X-API-Key: $DUCKBRAIN_API_KEY" | tee /tmp/feed.log
# On the next event, the id line carries the cursor:
#   id: dbch1.<…>   ← persist this verbatim

# Terminal 2 (or after a crash/reconnect): resume strictly after the persisted id
LAST=$(grep '^id: ' /tmp/feed.log | tail -1 | cut -d' ' -f2)
curl -Ns "http://localhost:3000/api/ns/my-project/changes?cursor=$LAST" \
  -H "X-API-Key: $DUCKBRAIN_API_KEY"
```

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

### Custom Auth Store Path (`--auth-file`)

By default the server reads credentials from `~/.duckbrain/auth.json`. A
scratch or test daemon can point at a different auth store so it never
touches the production one:

```bash
# Flag form
pnpm start -- http --auth=apikey --auth-file=/tmp/scratch-auth.json

# Env fallback (used when the flag is absent)
DUCKBRAIN_AUTH_FILE=/tmp/scratch-auth.json pnpm start -- http --auth=apikey
```

- Precedence: `--auth-file` flag > `DUCKBRAIN_AUTH_FILE` env > prod default.
- When an override is set, `~/.duckbrain/auth.json` is **not consulted at
  all** — the override file must exist and parse, otherwise the server
  exits at startup with a clear error (never a silent fallback to the prod
  store).
- When unset, behavior is unchanged: the prod file is authoritative.
- The override is runtime-only and never persisted (same philosophy as
  `DUCKBRAIN_CONFIG_PATH`).

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

The command prints the token and records the grants in the resolved auth store (default `~/.duckbrain/auth.json`):

```json
{
  "apiKeys": [
    { "key": "<generated>", "name": "agent-alpha", "namespaces": ["my-project", "chat-archive"] }
  ]
}
```

**Role grants (`--role`).** `duckbrain token --role=<role>` grants SUPA-4 roles (spec: `docs/specs/SUPA-4-auth.md`) to the token. Valid roles are exactly `admin`, `writer`, `analyst`, and `uploader`; the flag is repeatable and accepts both `--role=<role>` and the space form `--role <role>`. Absent = `["admin"]` (backward-compatible default). A token with several grants holds the union of them:

```bash
duckbrain token --name=agent-readonly --role=analyst
duckbrain token --name=agent-pipeline --role=writer --role=uploader
duckbrain token --name=agent-pipeline --role writer --role uploader   # space form
```

An unknown role is **fatal before minting**: the command prints
`Unknown role: <v>. Valid roles: admin, writer, analyst, uploader.` to stderr,
exits `1`, and never writes the auth store. The minted entry stores
`roles: [...]`, e.g. `{ "key": "<generated>", "name": "agent-pipeline", "roles": ["writer", "uploader"] }`.

| Role | `tables.read` | `tables.write` | `files.read` | `files.upload` | `sql.read` | `sql.write` |
|------|:-------------:|:--------------:|:------------:|:--------------:|:----------:|:-----------:|
| `admin` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `writer` | ✓ | ✓ | — | — | ✓ | ✓ |
| `analyst` | ✓ | — | ✓ | — | ✓ | ✓ |
| `uploader` | ✓ | — | ✓ | ✓ | — | — |

Precedence rules (SUPA-4): a multi-role token holds the **union** of its roles'
grants; an explicit `tableGrants` map **restricts** a non-admin role's default
(a table missing from the map is denied even when the role would allow it);
`admin` bypasses per-table grants; a token with no `roles` field (pre-SUPA-4
shape) is admin-equivalent; and namespace scope is orthogonal to roles — see
[Per-Token Namespace Grants](#per-token-namespace-grants).

Minting writes to the auth store resolved by `--auth-file` /
`DUCKBRAIN_AUTH_FILE` (falling back to `~/.duckbrain/auth.json`) — see
[Custom Auth Store Path](#custom-auth-store-path---auth-file).

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
