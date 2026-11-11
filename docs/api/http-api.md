# HTTP API Reference

DuckBrain's HTTP server provides REST API access to memories, namespaces, and system information, plus Streamable HTTP transport for remote MCP connections.

## Starting the HTTP Server

```bash
# Default port 3000, localhost only — API-key auth is ON by default
pnpm start http

# Custom port
pnpm start http --port=8080

# Explicit local-only mode: no authentication (unsafe; emits a warning)
pnpm start http --auth=none

# Bind to all interfaces (for remote access)
pnpm start http --bind-all --port=8080 --auth=apikey

# With authentication
pnpm start http --auth=apikey --rate-limit=60
```

### HTTP Server Options

| Option | Default | Description |
|--------|---------|-------------|
| `--port` | 3000 | HTTP server port |
| `--bind-all` | — | Bind to `0.0.0.0` (all interfaces) instead of localhost |
| `--auth` | apikey | Authentication type: `none`, `basic`, or `apikey`; use `none` only for explicit local-only development |
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

`POST /mcp`

Streamable HTTP transport for remote MCP clients. Accepts JSON-RPC requests per the Model Context Protocol specification. Tools are registered automatically on first request.

> **Note — only `POST` is supported:** `GET /mcp` (the optional server-to-client SSE stream in the Streamable HTTP transport) is **not offered** — DuckBrain is request/response only and the singleton server cannot hold a long-lived GET stream while also answering POSTs. A `GET /mcp` returns **405** with `Allow: POST` and `"Method Not Allowed: this endpoint does not offer a GET SSE stream"`; a Streamable HTTP client treats 405 as "no SSE stream here" and continues with POST only.

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

Lists the namespaces known to the daemon. Use the REST API (`/api/namespaces`) for full namespace management.

The list is filtered to the caller's token grant (card t_667d7e6c): a token
carrying `namespaces` grants sees only those names, and `currentNamespace` is
omitted when the active namespace is outside the grant. Unrestricted tokens
and `--auth=none` see the full list.

**Response:**

```json
{
  "namespaces": ["default"]
}
```

### Users

`GET /users`

Returns the distinct authors across the caller's visible namespaces, aggregated
from git commit history (falling back to JSONL memory data when a namespace has
no git history).

The author scan follows the caller's namespace grant (card t_667d7e6c): only
the token's visible namespaces are scanned, so a scoped token neither learns
foreign namespace names nor their authors.

**Note:** the scan walks every visible namespace serially (git log per
namespace, JSONL fallback), so on installs with very many namespaces or heavy
git history this endpoint can take a long time to respond.

**Response:**

```json
{
  "users": ["agent-alpha@duckbrain.local", "kara@duckbrain.local"],
  "count": 2
}
```

### Activity Feed

`GET /activity`

Returns recent memory activity across all namespaces — the newest non-tombstone
rows from every namespace's JSONL segments, ordered by `timestamp` descending.

| Query Param | Default | Description |
|-------------|---------|-------------|
| `limit` | 50 | Max activities to return (capped at 200) |
| `namespace` | — | Restrict the feed to one namespace. Grant-checked: a token without a grant for it gets `403 Forbidden`. |

**Authorization:** an unrestricted token (or `--auth=none`) sees the
every-namespace feed. A token carrying `namespaces` grants sees **only its
granted namespaces**, whether or not `?namespace=` is given — ungranted
namespaces' segments are not read at all.

**Note:** the feed is assembled from JSONL segment reads across the visible
namespaces; on installs with very many namespaces this can take a long time
without `?namespace=` scoping.

**Response:**

```json
{
  "activities": [
    {
      "id": "…",
      "key": "/projects/myapp",
      "domain": "concept",
      "timestamp": "2026-10-02T10:30:00Z",
      "author": "agent-alpha@duckbrain.local",
      "action": "add",
      "content": "…",
      "attributes": {},
      "namespace": "my-project"
    }
  ],
  "count": 1,
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

`GET /api/search` additionally forwards the documented search query names —
`q`, `contains`, `namespace`, `limit` and `allNamespaces` — into the redirect
target whenever the request carries them, percent-encoded (DF-2026-21). `q` is
always present in the target (empty when the request omits it); any other
query name is not forwarded, because `GET /api/memories` refuses unknown
parameters.

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

**Response headers:** every successful (2xx) write response carries

- `X-Durability: buffered|fsync|direct` — the mode the write **achieved**;
- `X-Durability-Configured: buffered|fsync|direct` — the mode configured for
  the namespace;
- `X-Durability-Degraded: configured=<mode>; achieved=<mode>` — present only
  when the write path could not reach the configured mode (e.g. a legacy
  `.table.json` row under a `direct`-configured namespace, which achieves
  `fsync` because a legacy line cannot be block-framed).

Before DURABILITY-HONESTY-001 the single `X-Durability` header echoed the
CONFIGURED mode, so a page-cache append could advertise `fsync`. Denied or
failed writes never emit any of these headers.

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
> non-tombstoned version, while the list route returns all of them. Tombstoned
> versions (deleted memories) are excluded from both the default list and the
> `historical=true` view; only live versions are returned. Versions
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
| `allNamespaces` | `false` | RETR-007: cross-namespace keyword search — with `contains=`, union the keyword hits over EVERY manifest namespace (each hit carries its own `namespace`). Requires an unrestricted token; mutually exclusive with `namespace` (the scoped param is ignored when this flag is set) |
| `after` | — | Only rows at or after this ISO-8601 instant (timestamp or chat-archive key date facet) |
| `before` | — | Only rows at or before this ISO-8601 instant |
| `between` | — | ISO-8601 range as `START,END` — shorthand for `after` + `before` |
| `as_of` | — | Read the namespace state at a git ref or ISO-8601 date (memory-as-of, RETR-004) — see the error contract below |

> **Note — `as_of` error contract (DF-0925-04):** `?as_of=` accepts an ISO-8601 date (`2026-08-10`; date-only input is inclusive of the whole day) or a git ref (commit hash, branch, tag), resolved to a concrete commit BEFORE the query runs. It cannot be combined with `q` or `contains` — semantic/keyword search indexes have no historical state. Failure modes, all **400 `VALIDATION_ERROR`** (never a 500 or a silent unfiltered list):
>
> - `as_of` + `q`/`contains` → "as_of cannot be combined with 'query' or 'contains' — memory-as-of reads the git state at that ref and does not run semantic or keyword search".
> - Unresolvable value → "Invalid --as-of value '<value>': not an ISO-8601 date and not a resolvable git commit, branch, or tag".
> - Date before the first commit → "No commit found at or before <value>".
> - Namespace without git history → "Namespace at <path> is not a git repository — as-of recall requires namespace git history".
> - Empty value → "--as-of requires a date or a git commit reference".
>
> The MCP `recall` tool exposes the same argument as `asOf` and returns the same error strings inside its `error` result (see [mcp-tools.md](mcp-tools.md#recall)).
| `attr.<name>` | — | Attribute filter: only rows whose `attributes` match `name=value` (repeatable) |
| `historical` | `false` | View selector: `true` = historical view including ALL rows regardless of validity window (expired `valid_until` / future `valid_from` facts stay visible); `false`/absent = current view (validity-filtered). Tombstoned versions (deleted memories) are excluded from BOTH views — only live versions are returned |
| `limit` | 50 | Max results to return |
| `offset` | 0 | Pagination offset |
| `namespace` | `default` | Namespace to query |
| `debug` | — | DF-1013-03: opt-in diagnostics. `?debug=search` (the only accepted value, and only together with `q=`) appends a `searchDebug` object to the response — see the note below. Any other value, or `debug=search` without `q=`, is a 400 `VALIDATION_ERROR` |

> **Note — unknown query parameters (DF-0926-02):** this endpoint accepts exactly the parameters in the table above (`attr.<name>` as a repeatable prefix). Any OTHER query parameter is refused with **400 `VALIDATION_ERROR`** whose message names the offending parameter and lists the valid ones — it is never silently ignored. In particular `?key=` and `?query=` are not parameters of this endpoint: `?key=…` returns a 400 pointing at `GET /api/memories/key/:key` (or `?prefix=` to filter the list), and `?query=…` returns a 400 pointing at `?q=` / `?contains=`. Before the fix these two were accepted and dropped, so a client that believed it had recalled one key — or run one search — received HTTP 200 with the unfiltered list.

> **Note — semantic search (`?q=`) and embeddings (DB-GAP-036):** `?q=` needs a reachable embedding provider at query time (LM Studio / Ollama with a loaded embedding model, or `DUCKBRAIN_EMBEDDING_API_KEY` for the `openai` provider). When no provider can embed, the endpoint returns **503 `EMBEDDINGS_UNAVAILABLE`** with an explicit message telling you to start an embedding provider or run `duckbrain embeddings rebuild` — never a silent unfiltered list. Keyword search (`?contains=`) works offline; its per-namespace index is refreshed automatically when it is missing or older than the newest write (bounded and single-flight — `DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS`, default 5000 source rows), with `duckbrain search-index rebuild` as the escape hatch for namespaces over that bound. Check `GET /health` — its `embedding` block reports provider health.

> **Performance (PERF-005):** On a healthy local Ollama provider, warm semantic requests are expected to complete in under 5 seconds; actual latency depends on model load, provider capacity, network, and namespace size. At most two uncached candidate texts (each no longer than 1,500 characters) are embedded per query in one Ollama `/api/embed` batch; longer uncached texts are omitted from semantic ranking until their embeddings exist in cache. Older Ollama versions fall back to bounded individual embedding calls. Set `DUCKBRAIN_SEARCH_TIMING=1` on the daemon to log provider discovery, query embedding, keyword search, DuckDB candidate fetch, candidate embedding, cache lookup, and scoring durations. `?contains=` remains an offline FTS query and does not call the embedding provider.

> **Search diagnostics (DF-1013-03):** add `&debug=search` to a `?q=` request to receive a `searchDebug` object at the top level of the response. Without the flag the response shape is exactly the envelope above — `searchDebug` is never present. The object reports what `DUCKBRAIN_SEARCH_TIMING=1` logs to stderr, per request:
>
> - `indexFreshness` — the keyword (FTS) index state as observed BEFORE this request's rebuild: `missing` | `stale` | `fresh` (the same classification the boot warm-up summary reports per namespace as `searchFreshness`)
> - `indexRebuilt` — `true` when THIS request rebuilt the FTS sidecar (i.e. the first slow query paid the inline rebuild; matches the warm-up summary's `searchRebuilt` semantics)
> - `indexSkipReason` — present when the index could not be made usable (over-bound row-count refusal or rebuild failure; the warm-up summary's `searchSkipReason`)
> - `keywordCandidates` — rows the keyword leg ranked
> - `semanticCandidates` — rows the semantic leg fetched from DuckDB
> - `cacheHits` / `uniqueMisses` — candidate vectors found in the embedding cache vs. texts that needed an embed
> - `embedMs` / `queryEmbedMs` — candidate-embed and query-embed wall time in ms
>
> Fields a request's degradation ladder did not reach are omitted (e.g. `cacheHits`/`embedMs` are absent when the keyword leg was unavailable and the response degraded to keyword-only). The freshness fields read the SAME `ensureFreshIndex`/`indexFreshness` state the warm-up summary observes, so `indexFreshness` on a response agrees with the last warm-up line for that namespace.
>
> ```bash
> curl "http://localhost:3000/api/memories?q=pgbouncer&debug=search"
> ```
>
> ```json
> {
>   "items": [],
>   "total": 0,
>   "offset": 0,
>   "limit": 50,
>   "hasMore": false,
>   "nextOffset": null,
>   "count": 0,
>   "memories": [],
>   "searchDebug": {
>     "indexFreshness": "fresh",
>     "indexRebuilt": false,
>     "keywordCandidates": 0,
>     "semanticCandidates": 12,
>     "cacheHits": 12,
>     "uniqueMisses": 0,
>     "embedMs": 0.4,
>     "queryEmbedMs": 18.2
>   }
> }
> ```

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

> **Note — namespace auto-creation (NAMESPACE-AUTOCREATE-001):** if the target namespace does not exist yet, the write still succeeds (201) and the namespace is created automatically (`mkdir -p` + git init) — the long-standing fleet behavior, unchanged by default. Such a write is **loud**: the 201 body carries `"namespace_autocreated": true` (the field is absent when the namespace already existed), and the daemon logs a `[namespace-autocreate]` WARN — so a typo'd `?namespace=` is visible in both the response and the log instead of silently scattering memories into a directory nobody meant to create. To **reject** such writes instead, set `"namespaces": { "autoCreate": false }` in `duckbrain.config.json`, or `DUCKBRAIN_NAMESPACES_AUTOCREATE=false` in the daemon's environment (runtime-only, never persisted — same convention as `DUCKBRAIN_DURABILITY_MODE`; only the exact spellings `true` / `false` are accepted, anything else fails config load). In strict mode a write to a non-existent namespace returns **404 `NAMESPACE_NOT_FOUND`** and creates nothing on disk; create the namespace first with `POST /api/namespaces`. Read endpoints were already 404 for missing namespaces (GAP-025) and are unaffected.

> **Note — field naming across surfaces:** The HTTP API accepts `content` for the memory body. This maps directly to the MCP `remember` tool's `embedding_text` field — both surfaces store and return the **same** underlying text field (see [MCP Tools Reference](mcp-tools.md#remember)). A memory written via HTTP with `content` is retrievable via MCP `recall` with the text in `embedding_text`, and vice versa.

> **Note — write durability (SUPA-1):** the response carries
> `X-Durability` with the mode the write **achieved**, plus
> `X-Durability-Configured` with the namespace's configured mode (and
> `X-Durability-Degraded` when they differ). In `fsync`/`direct` mode the
> `fdatasync` + directory `fsync` complete **before** the 201 is sent
> (RPO = 0 for acked writes on a single node); in `buffered` mode the write
> is a page-cache append with the documented OS-crash/power-loss window. See
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
  "action": "add",
  "namespace": "default"
}
```

> **Note — effective namespace echo (DF-1003-03):** the 201 body carries
> `"namespace"` — the namespace the write **actually** landed in, after
> server-side resolution (explicit param > `DUCKBRAIN_NAMESPACE` > config
> `defaultNamespace` > `"default"`). A caller that omitted the namespace — or
> typo'd it and received `namespace_autocreated: true` — reads the truth from
> the body instead of trusting its own request. On the happy path (explicit
> namespace) the echo is simply that same namespace.

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
| `namespace` | active namespace | Namespace to query — grant-checked (`403` on a token without that grant) |

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
| `namespace` | active namespace | Namespace to query — grant-checked (`403` on a token without that grant) |

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

A row whose namespace directory is missing on disk (registry row survived an
out-of-band `rm -rf`) carries `"directoryMissing": true`; healthy rows omit
the field entirely (REG-GONE-001).

**Drift warning (DB-GAP-065):** when directory-missing rows accumulate to a
level that makes the listing misleading — `deadCount >= 25`, or
`deadCount > 2 * liveCount` — the body gains:

```json
"driftWarning": {
  "deadCount": 143,
  "liveCount": 90,
  "hint": "run 'duckbrain namespaces prune --apply'"
}
```

Below threshold (and for a clean registry) the field is omitted entirely, so
the absence of `driftWarning` means the registry is healthy. `duckbrain
namespaces prune` (dry-run by default; `--apply` to write) removes exactly
the dead set — see the CLI reference for the safety contract.


**Authorization (card t_667d7e6c):** the listing is filtered to the caller's
token grant — the rows cover exactly the namespaces in the token's
`namespaces` list (registry rows *and* on-disk-only rows), and
`currentNamespace` is **omitted from the body** when the active namespace is
outside the grant. An unrestricted token (`namespaces` absent) and an
`--auth=none` daemon receive the full listing, unchanged.

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

### Read Ledger (OBS-DUCKBRAIN-001)

`GET /api/reads` aggregates the per-route read ledger (`.duckbrain-audit/reads.jsonl`) over an arbitrary historical time window. Every authenticated read of a documented route is recorded there — including reads that failed auth, because the ledger middleware mounts **before** `authMiddleware` (a 401 would otherwise leave no trace). Writes, `/health`, `/stats`, and the `/api/reads` query surface itself are never recorded. DNS-rebinding and rate-limit blocks are the denial auditor's domain and stay unrecorded.

The ledger is durable on disk and append-only: the active segment is `reads.jsonl`; when it reaches `max_bytes` it is sealed as `reads.NNNN.jsonl` under the next monotonic number and never reopened or deleted, so a window that lies entirely **before** the current process started is queryable — historical queries do not require the process to have been alive in the window. Appends are asynchronous by design; the route drains the pending tail before aggregating, so a query issued immediately after reads sees its own rows.

**Auth:** gated like every sibling `/api/*` route — an unauthenticated request is rejected with `401` (the daemon requires API keys by default; see [Authentication](#authentication)).

#### Query Parameters

All four parameters are optional and combinable. Parameters combine as a logical AND (each narrows the previous result set).

| Query Param | Default | Description |
|-------------|---------|-------------|
| `from` | — | Inclusive ISO 8601 lower bound on the row timestamp (e.g. `2026-10-01T00:00:00Z`) |
| `to` | — | Inclusive ISO 8601 upper bound on the row timestamp |
| `route` | — | Exact normalized route template, e.g. `GET /api/memories` (percent-encode the space as `%20`) |
| `ns` | — | Exact explicitly-scoped namespace value. Rows recorded with a null namespace (reads that carried no explicit scope) are never matched by `ns=` |

Empty or malformed input is never silently narrowed: an empty parameter value, an unparseable `from`/`to`, or a non-string value is rejected with **`400 VALIDATION_ERROR`** whose message names the offending parameter.

> **Note — grant scoping (DB-GAP-062):** a scoped principal (an API key carrying a `namespaces` allow-list, see [Per-Token Namespace Grants](#per-token-namespace-grants)) sees only rows whose namespace is in its grants. Rows recorded with a **null** namespace stay visible to scoped principals — they carry no namespace name at all, so they cannot leak a namespace a token was not granted. Unrestricted tokens and `--auth=none` daemons see every row.

#### Response

```json
{
  "window": { "from": null, "to": null },
  "filter": { "route": "GET /api/memories", "ns": null },
  "total": 13595,
  "routes": [
    {
      "route": "GET /api/memories",
      "method": "GET",
      "count": 13595,
      "statuses": { "200": 13137, "400": 235, "401": 159, "403": 21, "404": 13, "500": 30 }
    }
  ],
  "by_status": { "200": 13137, "400": 235, "401": 159, "403": 21, "404": 13, "500": 30 },
  "skipped_malformed": 1,
  "files_read": ["reads.0001.jsonl", "reads.0002.jsonl", "reads.0003.jsonl", "reads.0004.jsonl", "reads.0005.jsonl", "reads.jsonl"],
  "ledger": {
    "file": ".duckbrain-audit/reads.jsonl",
    "segments": "reads.NNNN.jsonl (sealed, monotonic)",
    "max_bytes": 10485760
  }
}
```

| Field | Description |
|-------|-------------|
| `window` | Echoes the applied `from`/`to` bounds (`null` = unbounded) |
| `filter` | Echoes the applied `route`/`ns` filters (`null` = unfiltered) |
| `total` | Rows matching every filter and grant |
| `routes` | Per-route tallies, `count` descending then route name ascending; each entry carries its own `statuses` breakdown |
| `by_status` | Status code → count across all matching rows |
| `skipped_malformed` | Malformed ledger lines skipped while reading — never silent |
| `files_read` | Ledger files read, in traversal order (sealed segments first, active segment last) |
| `ledger` | Ledger block: backing `file`, `segments` naming pattern, and rotation threshold `max_bytes` (10 MiB) |

**Example:**

```bash
# All reads of the memories list route in October 2026
curl -s "http://localhost:3000/api/reads?route=GET%20/api/memories&from=2026-10-01T00:00:00Z&to=2026-10-31T23:59:59Z" \
  -H "X-API-Key: $DUCKBRAIN_KEY"

# Reads scoped to one namespace (unrestricted token)
curl -s "http://localhost:3000/api/reads?ns=my-project" \
  -H "X-API-Key: $DUCKBRAIN_KEY"

# Bad window bound is a 400, never a silent narrowing
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:3000/api/reads?from=notadate" \
  -H "X-API-Key: $DUCKBRAIN_KEY"
# => 400
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
| `POST` | `/api/ns/:ns/tables/:table/declare` | Declare a table (same core as the CLI verb and the MCP tool) |
| `GET` | `/api/ns/:ns/tables/:table` | Read rows (filter / order / page) |
| `POST` | `/api/ns/:ns/tables/:table` | Insert row(s) |
| `PATCH` | `/api/ns/:ns/tables/:table?pk=eq.<value>` | Update rows by primary key |
| `DELETE` | `/api/ns/:ns/tables/:table?pk=eq.<value>` | Delete rows by primary key |
| `GET` | `/api/ns/:ns/openapi.json` | Generated OpenAPI 3.1 document |

#### Declare a table

Tables are served ONLY from declarations on disk — a fresh install has no
declarations and the layer stays empty until you create one. There are three
transports and **one implementation** (`declareTable()` in
`src/tables/declare.ts`): the CLI verb, the HTTP route below, and the MCP
`tables_declare` tool. They validate identically, journal identically and
refuse identically.

**Recommended path for a new table: declare it over HTTP (or MCP) without
`legacy`**, so `schema.json` is written and inserts ride the SUPA-2 serializer
(validation → ordered write → audit + DB-SUPA-5 change record → commit). See
`docs/decisions/ADOPT-DECLARED-001-declaration-shape.md` for why the 949
pre-existing legacy declarations are NOT migrated as part of this route.

The CLI verb writes the SUPA-6 persistent schema (merging into an existing
`schema.json`) or the legacy per-table file:

```bash
duckbrain tables declare <namespace> <table> \
  --column <name>=<type> [--column <name>=<type> ...] \
  [--primary <col>] [--format jsonl-objects|jsonl-positional] \
  [--legacy] [--force]
```

Column types: `varchar | integer | bigint | double | boolean | timestamp | json`
(the DB-SUPA-3 storage types; they are mapped to the SUPA-6 canonical
declared types — `integer` becomes `float64`, which stores JSON numbers
exactly below 2^53, so the natural `POST {"id": 1}` works).

Example — declare and then insert through the REST route:

```bash
duckbrain tables declare e2e-supagap widgets \
  --column id=integer --column name=varchar --primary id
# → namespaces/e2e-supagap/schema.json (SUPA-6 format):
{
  "schemaVersion": 1,
  "tables": {
    "widgets": {
      "schemaVersion": 1,
      "storage": { "path": "tables/widgets/current.jsonl" },
      "rowShape": "object",
      "keyColumns": ["id"],
      "columns": [
        { "name": "id", "type": "float64", "nullable": false },
        { "name": "name", "type": "string", "nullable": true }
      ]
    }
  },
  "views": {}
}
# insert a row (201 on success):
curl -s -X POST "http://localhost:3000/api/ns/e2e-supagap/tables/widgets" \
  -H "Content-Type: application/json" -d '{"id": 1, "name": "a"}'
# read rows / generated OpenAPI:
curl -s "http://localhost:3000/api/ns/e2e-supagap/tables/widgets"
curl -s "http://localhost:3000/api/ns/e2e-supagap/openapi.json"
```

`--force` replaces an existing declaration of the same table (without it, a
conflicting contract is refused and the run exits nonzero); `--legacy`
writes `namespaces/<ns>/tables/<table>.table.json` (the historical
declaration shape) instead of `schema.json`. Re-declaring an identical
contract is idempotent. The schema switch goes through the DDL fence and is
journaled under `<ns>/.duckbrain-ddl/` like every other schema change.

#### `POST /api/ns/:ns/tables/:table/declare` — declare over HTTP

An agent with an API key can create the table it wants to write to; no shell on
the box is required. The body is the same document the MCP `tables_declare` tool
takes:

```json
{
  "columns": [
    { "name": "id", "type": "integer" },
    { "name": "label", "type": "varchar" }
  ],
  "primary": "id",
  "format": "jsonl-objects",
  "legacy": false,
  "force": false
}
```

`columns` is required (each `{name, type}`, types as in the CLI). `primary`
defaults to the first column; `format` defaults to `jsonl-objects`. Unknown
fields are rejected rather than ignored, so a typo cannot silently declare
nothing.

```bash
curl -s -X POST "http://localhost:3000/api/ns/e2e-supagap/tables/widgets/declare" \
  -H "x-api-key: $DUCKBRAIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"columns":[{"name":"id","type":"integer"},{"name":"name","type":"varchar"}],"primary":"id"}'
# 201 {"namespace":"e2e-supagap","table":"widgets","path":"…/schema.json",
#      "format":"schema.json","replacedExisting":false,"declaration":{…}}
```

| Status | Meaning |
|---|---|
| `201` | Declaration written; `declaration` is the resulting REST contract |
| `200` | Identical contract already existed, or `force` replaced a different one |
| `400` `INVALID_DECLARATION` | Body shape or column names/types are invalid (the CLI's own message) |
| `403` `FORBIDDEN` | No namespace grant, or no per-table **write** grant for this table |
| `409` `DECLARATION_REFUSED` | Well-formed, refused by state on disk (conflicting contract without `force`) |

The route is a **sub-resource** of the table (`/:table/declare`) rather than the
row-insert verb `POST /:table`: overloading the data verb would make an insert
whose columns happened to look like a declaration write schema instead of rows.
Declaring is a write, so it is gated exactly like `POST /:table` — namespace
grant plus per-table write grant — and a token restricted to specific tables
cannot invent a new one.

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
conventions. The supported set is fixed and auditable — every operator below
is either implemented, deliberately absent (with the reason a JSONL document
store gives), or a tracked TODO. Nothing is silently dropped.

| Operator | Status | Meaning / why it is absent |
|---|---|---|
| `eq` | IMPLEMENTED | Equal |
| `neq` (alias `ne`) | IMPLEMENTED | Not equal |
| `gt` / `gte` | IMPLEMENTED | Greater than / greater than or equal — numeric on a `int64`/`float64` column, chronological on `timestamp`, lexicographic on `string` |
| `lt` / `lte` | IMPLEMENTED | Less than / less than or equal |
| `like` | IMPLEMENTED | SQL `LIKE` pattern (`%` wildcards, `_` single char) |
| `ilike` | IMPLEMENTED | Case-insensitive `LIKE` |
| `in` | IMPLEMENTED | Membership in a parenthesized list |
| `is` | IMPLEMENTED | `is.null` / `is.true` / `is.false` / `is.unknown` — the NULL-safe exact check |
| `isdistinct` | IMPLEMENTED | `IS DISTINCT FROM`: unlike `neq`, a NULL column **is** distinct from a value |
| `fts` | IMPLEMENTED | Full-text: comma-separated terms, all must match (AND), whole tokens, case-insensitive |
| `plfts` | IMPLEMENTED | Full-text: whitespace-separated words, all must match (AND) |
| `phfts` | DELIBERATELY-ABSENT | `phraseto_tsquery` needs a text-search config (stemmer + stopwords); a JSONL table has no tsvector or dictionaries, so a "phrase" here would be a term-AND wearing a different name — use `plfts` |
| `wfts` | DELIBERATELY-ABSENT | `websearch_to_tsquery` syntax (`OR`, `-term`, quoted phrases) would need its own parser; `fts`/`plfts` terms are literals and boolean tsquery punctuation (`&`, `|`, `!`, `(`, `)`, `:`) is rejected by name rather than reinterpreted |
| `match` | DELIBERATELY-ABSENT | Regex over documents: RE2 is linear so it is cheap to add, but a regex operator invites clients to re-implement word matching that `fts` already does; no consumer has asked |
| `imatch` | DELIBERATELY-ABSENT | Same as `match`, case-insensitive |
| `cs` | DELIBERATELY-ABSENT | Postgres array "contains": a `json` column is opaque text here, with no array element semantics |
| `cd` | DELIBERATELY-ABSENT | Postgres array "contained in": same reason |
| `ov` | DELIBERATELY-ABSENT | Array/range "overlaps": no range type on a document store |
| `sl` | DELIBERATELY-ABSENT | Range "strictly left of": no range type |
| `sr` | DELIBERATELY-ABSENT | Range "strictly right of": no range type |
| `nxr` | DELIBERATELY-ABSENT | Range "does not extend right": no range type |
| `nxl` | DELIBERATELY-ABSENT | Range "does not extend left": no range type |
| `adj` | DELIBERATELY-ABSENT | Range "adjacent": no range type |
| `or` | DELIBERATELY-ABSENT | Logical filter groups are not part of the supported query vocabulary: this store ANDs per-column predicates and has no boolean predicate tree to hang a group on. `?or=(id.eq.1,id.eq.2)` is refused with `400 UNSUPPORTED_QUERY` naming `or`, never silently ignored (a dropped group used to answer 200 with **every** row, so the caller believed the filter applied) |
| `and` | DELIBERATELY-ABSENT | Same as `or`: several `&`-joined filters already express an AND of per-column predicates, and a nested group is not supported; `?and=(…)` is refused with `400 UNSUPPORTED_QUERY` rather than silently ignored |
| `not.and` | DELIBERATELY-ABSENT | Negation applies per **column** (`?name=not.eq.widget`), never to a group; `?not.and=(…)` is refused with `400 UNSUPPORTED_QUERY` rather than silently ignored |
| `not.or` | DELIBERATELY-ABSENT | Same as `not.and`: there is no boolean group to negate; `?not.or=(…)` is refused with `400 UNSUPPORTED_QUERY` rather than silently ignored |

- A value with no operator prefix is `eq`: `?qty=5` is `?qty=eq.5`.
- `in` takes a comma-separated, parenthesized list:
  `?name=in.(widget,gadget)`.
- Several filters AND together: `?qty=gte.10&name=like.wid%25`.
- **Negation:** any operator takes the PostgREST `not.` prefix —
  `?name=not.eq.widget`, `?qty=not.in.(5,9)`, `?archived_at=not.is.null`.
  The predicate is wrapped in `NOT (...)`, so a NULL column never satisfies a
  negated comparison (SQL three-valued logic), exactly as `NOT (col = x)`
  behaves. Use `isdistinct` when you want NULL to count as "different".
- **Full text** (`fts.opts`): `?title=fts.alpha,beta` matches rows whose
  `title` contains **all** terms as whole words (case-insensitive); `helloworld`
  does not match `fts.hello`. `plfts` is the same with whitespace as the term
  separator. There is no stemmer: a term matches the token exactly, so search
  for the stem you indexed (`report` does not match `reports`). The filter is
  a predicate on the same JSONL scan every table read performs — no second
  index is maintained. It does **not** route to the namespace's
  `.search/fts.duckdb` memory index: that index covers memory records
  (`id` / `content` / `key` / `attributes`), so a table column called `title`
  is not in it, and matching against it would return rows by the wrong text.
- An unknown filter column (`?typo=eq.1`) returns
  `400 VALIDATION_ERROR`, and the error names the declared columns. A
  querystring key that is neither a declared column nor shaped like
  `op.value` is ignored, so tracing/cache-busting parameters pass through.
- An unknown operator (`?qty=between.1`) returns `400 VALIDATION_ERROR`
  naming the operator, the closest supported operator
  (`closest supported: 'lte'`) and the full supported list. A filter is never
  ignored: an operator this grammar does not know is an error, not a no-op.
- **Logical filter groups** (`?or=(…)`, `?and=(…)`, `?not.and=(…)`,
  `?not.or=(…)`, and a bare `?not=`) are control KEYS rather than column
  operators, and are not part of the supported query vocabulary: they return
  `400 UNSUPPORTED_QUERY` and the error names the offending key. The refusal is
  for the WHOLE request — a valid column filter sent alongside an `?or=` is
  never applied on its own, so no partial `WHERE` is ever executed. (Before
  this was refused the group fell through the unknown-key rule and the request
  answered 200 with every row, which is why it is now a named error rather than
  a silent skip.) The same check is shared with the MCP `table_select` tool, so
  a logical group in its `filters` map is refused identically.

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

> **Tuning:** the per-namespace HEAD-observation poll interval (default `1000`
> ms — the upper bound on how long a new commit can go unnoticed) and the SSE
> heartbeat keep-alive interval (default `15000` ms) are tunable at runtime
> via the `DUCKBRAIN_REALTIME_POLL_MS` and `DUCKBRAIN_REALTIME_HEARTBEAT_MS`
> environment variables — see
> [Configuration Reference](../guide/configuration#environment-variables).

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

### Operations (SURFACE-HTTP-OPS-001)

Maintenance verbs used to be CLI-only, so a remote agent could write memories
but could not maintain them. These routes close that gap. Every route requires
the **admin** role, refuses destructive work without an explicit confirmation,
and appends one line to the namespace lifecycle ledger
(`<namespaces>/.s3state/lifecycle.log`). The verbs that stay CLI-only, and why,
are recorded in [ops-surface-decisions.md](ops-surface-decisions.md).

#### `POST /api/ops/namespaces/prune`

Remove namespace-registry mappings whose directory no longer exists. Same
implementation as `duckbrain namespaces prune`.

**Request (all fields optional):**

```json
{ "dryRun": true, "confirm": false, "residueOnly": false }
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dryRun` | boolean | `true` | Report the removal set without writing. |
| `confirm` | boolean | `false` | Required as `true` when `dryRun` is `false`, otherwise `400 CONFIRMATION_REQUIRED`. |
| `residueOnly` | boolean | `false` | Restrict the dead set to test-residue names (`pytest-*`, `auger-pytest-*`, ...). |

**Response:**

```json
{
  "success": true,
  "dryRun": true,
  "registry": { "mappings": 12, "live": 10, "dead": 2, "refused": 0 },
  "dead": [{ "name": "old-probe", "path": "./namespaces/old-probe" }],
  "refused": []
}
```

An applied run additionally returns `removed`, `manifestsPruned`,
`bytesBefore` and `bytesAfter`.

#### `GET /api/ops/s3/status`

The `duckbrain s3 status --json` report, unchanged and complete: effective
config plus one row per namespace. Query parameters:

- `namespace` — restrict the report to one namespace.
- `verify=true` (or the legacy `probe=true`) — compare a bounded remote sample
  against the push manifest; `sample=N` sets its size (default 1000) and
  `allowManyObjects=true` lifts the 5000-object budget. A sample over budget is
  a `400` that names the flag.
- default — **recorded state only**, no bucket listing: each row carries
  `objectsRecorded`/`bytesRecorded` and `countSource: "recorded"`, and `remote`
  is `null`. A status GET used to LIST every object in the namespace, which for
  scheduler (258,578 objects) meant it could not answer (S3-STATUS-SCALE-001).

#### `POST /api/ops/consolidate`

Read-only daily analysis: the per-namespace delta rows, dedup counts and the
digest text for a UTC day. Body: `{ "date": "YYYY-MM-DD" }` (default
yesterday). The `--write-digest` half stays on the CLI (see the decision doc).

#### `POST /api/compaction/squash` (changed contract)

The squash route now follows the same rules: admin role, dry run **by
default**, and `confirm: true` required alongside `dryRun: false`. Every run
writes one lifecycle-ledger line. `GET /api/compaction/stats` is unchanged and
stays available to namespace-granted readers.

### Object store — `s3` verbs (SURFACE-S3-001)

`duckbrain s3 status|sync|clear|ghosts` used to be shell-only, so a remote
agent could read and write memories but could not answer "is this namespace
pushed?", push it, or finish the compaction runbook's cleanup. These routes
mount under the namespace they act on, so the token's namespace grant is
graded on the same value the handler touches.

| Route | Role | What it does |
|-------|------|--------------|
| `GET /api/ns/:ns/s3` | any namespace-granted token | Object counts (local, remote, bookkeeping, data), drift, last push, resolved bucket/prefix |
| `POST /api/ns/:ns/s3/sync` | admin or writer | Run `s3 sync <ns>` through the same engine, lock and deadline watchdog; answer with the CLI's counts |
| `GET`/`POST /api/ns/:ns/s3/ghosts` | any namespace-granted token | Is this namespace ghost sync state? Plus the full ghost plan |
| `POST /api/ns/:ns/s3/ghosts/clear` | admin | Prune **this** namespace's ghost manifest + stale mapping (confirm required) |
| `POST /api/ns/:ns/s3/clear` | admin | DESTROY the namespace's remote objects (dry run by default; confirm + reason) |

Every run appends one line to `<namespaces>/.s3state/lifecycle.log` with
`op`, `surface: "rest"`, `principal` and the outcome counts.

**Drift, and why it is not `local - remote`.** The engine stores its own
checksum ledger as a bucket object under `<prefix>/<ns>/.s3state/`. Counting
that as data would make every healthy namespace look one object ahead of disk
forever, so `objects.remote` is the raw listing, `objects.bookkeeping` is the
subset that is the engine's own state, `objects.data` is the difference, and
`drift.objects` is `local - data`. `drift.state` is one of `in-sync`,
`local-ahead`, `remote-ahead`, `unknown` (listing failed or `probe=false` —
never `0`) and `s3-disabled`.

#### `GET /api/ns/:ns/s3?probe=false`

```bash
curl "http://localhost:3000/api/ns/fleet-quality/s3" -H "X-API-Key: $KEY"
```

```json
{
  "success": true,
  "namespace": "fleet-quality",
  "enabled": true,
  "store": { "endpoint": "https://s3.example", "bucket": "duckbrain", "prefix": "duckbrain", "pathStyle": true },
  "objects": { "local": 2884, "remote": 2885, "bookkeeping": 1, "data": 2884 },
  "bytes": { "local": 2318849 },
  "drift": { "state": "in-sync", "objects": 0 },
  "lastPushAt": "2026-11-06T09:14:02.117Z"
}
```

`probe=false` skips the bucket listing (no network): `objects.remote`,
`objects.bookkeeping` and `objects.data` are `null` and `drift.state` is
`unknown`.

#### `POST /api/ns/:ns/s3/sync`

Body: `{ "direction": "push" | "pull" }` (default `push`). Same engine, same
cross-process lock, same per-object verification and deadline as
`duckbrain s3 sync`.

```bash
curl -X POST "http://localhost:3000/api/ns/fleet-quality/s3/sync" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"direction":"push"}'
```

```json
{
  "success": true,
  "namespace": "fleet-quality",
  "direction": "push",
  "uploaded": 4, "downloaded": 0, "skipped": 2880, "failed": 0,
  "verified": 0, "unverified": 0, "durationMs": 812,
  "checksumLedger": "pushed",
  "failures": [],
  "summary": "[S3] push fleet-quality: uploaded=4 downloaded=0 skipped=2880 in 812ms"
}
```

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `VALIDATION_ERROR` | `direction` is not `push`/`pull` |
| 404 | `NAMESPACE_NOT_FOUND` | Push for a namespace with no local directory (use `pull` to restore one) |
| 409 | `SYNC_IN_PROGRESS` | Another sync holds the namespaces-root lock — retry when it finishes; nothing was done |
| 409 | `S3_DISABLED` | `s3.enabled` is false on this daemon |
| 502 | `SYNC_FAILED` | The run itself failed; the message names the leg |

A run with object-level failures answers `success: false` and lists them in
`failures[]` — a partial push never reads as success. Progress is not streamed:
the route is request-scoped, which is why the engine's own deadline (not a
client disconnect) bounds the work.

#### `GET`/`POST /api/ns/:ns/s3/ghosts`

Ghost sync state = a sync manifest (or a registry mapping) whose namespace
directory is gone; those namespaces stay on every push cadence and retry
`ENOENT` forever. The response names this namespace and carries the whole plan:

```json
{
  "success": true,
  "namespace": "dead-a",
  "isGhost": true,
  "thisNamespace": { "ghostManifest": { "ns": "dead-a", "lastSyncAt": "2026-09-01T00:00:00Z" }, "ghostMapping": null },
  "ghosts": { "manifests": [ … ], "mappings": [ … ], "total": 2 }
}
```

Listing works while S3 is disabled — it reads local state files only.

#### `POST /api/ns/:ns/s3/ghosts/clear`

Body: `{ "confirm": true, "reason": "…" }`. Prunes the ghost manifest and stale
registry mapping for **the namespace in the path only** — the CLI sweeps
everything, a route mounted under one namespace must not prune a sibling's
state. Returns `cleared: false` (200) when the namespace was not a ghost.

#### `POST /api/ns/:ns/s3/clear`

Body: `{ "dryRun": true (default), "confirm": false, "reason": "…" }`.
Destroying remote objects requires `dryRun: false` **and** `confirm: true`
**and** a `reason`; the plan is re-listed at execution time, so it destroys
exactly what it announced. Disk is never touched.

`missing or wrong` answers `400 CONFIRMATION_REQUIRED` / `400 VALIDATION_ERROR`;
a failed deletion answers `502 S3_CLEAR_FAILED`. An `enabled: false` store is a
`409 S3_DISABLED`.

#### What stays CLI-only

`s3 query` (arbitrary SQL over the bucket through DuckDB httpfs, needing a
host-side credential decision) and `s3 config` (prints the resolved store, a
host diagnostic) stay on the CLI. The reasons are recorded in
[ops-surface-decisions.md](ops-surface-decisions.md). No MCP tool was added for
any of these verbs: an agent reaches every one of them over HTTP with its API
key, which is what the compaction runbook needs, and a second surface would be
a second thing to keep in sync (`docs/api/surface-parity.md` tracks the
matrix).

### Compaction

Compaction operates on the current namespace's git-backed memory store (see `POST /api/namespaces/switch`). Both routes are namespace-grant-checked: `?namespace=` — or `namespace` in the squash body — selects the namespace they operate on, and a token without a grant for it is rejected with `403 Forbidden` before the tool runs, exactly like `/api/memories`.

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
| `namespace` | string | active namespace | Namespace to compact. Also accepted as `?namespace=`. Grant-checked. |
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

The HTTP server supports three authentication modes configured via `--auth` or `~/.duckbrain/auth.json` (see [Configuration](../guide/configuration) for details). **The default is `apikey`** — a fresh daemon that omits `--auth` rejects unauthenticated reads and writes with `401` (a valid `X-API-Key` is required); `--auth=none` is an explicit opt-out for local-only use and logs an unauthenticated-mode warning at boot.

| Mode | Mechanism | Header |
|------|-----------|--------|
| `none` | No authentication (explicit `--auth=none` only) | — |
| `basic` | HTTP Basic Auth (bcrypt) | `Authorization: Basic ...` |
| `apikey` | API key in header (**default**) | `X-API-Key: <key>` |

The `/health` endpoint always bypasses authentication.

### Custom Auth Store Path (`--auth-file`)

By default the server reads credentials from `~/.duckbrain/auth.json`. A
scratch or test daemon can point at a different auth store so it never
touches the production one:

```bash
# Flag form
pnpm start http --auth=apikey --auth-file=/tmp/scratch-auth.json

# Env fallback (used when the flag is absent)
DUCKBRAIN_AUTH_FILE=/tmp/scratch-auth.json pnpm start http --auth=apikey
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
pnpm start http --auth=apikey

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
  reads AND writes AND namespace creation). The check is mounted on every
  namespace-scoped REST surface — `/api/memories`, `/api/namespaces`,
  `/api/ns/:ns/tables`, `/api/keys` (and `/api/keys/flat`),
  `/api/compaction/stats`, `/api/compaction/squash` and `/activity` — plus the
  namespace-scoped MCP tools, and every denial is written to the denial audit
  with reason `namespace_scope` (see `GET /api/keys?namespace=` on a token
  without that grant for the wire shape).
- `/activity` is the one cross-namespace feed: an explicit
  `?namespace=<ns>` is grant-checked exactly like the routes above (`403`
  when ungranted), and **without** it a scoped token's feed is silently
  confined to its granted namespaces — an ungranted namespace's rows are
  neither read from disk nor returned. An unrestricted token keeps the
  historical every-namespace feed.
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
