# MCP Tools Reference

DuckBrain exposes Model Context Protocol (MCP) tools that AI agents can use to store, query, and manage memories.

## Available Tools

| Tool                                            | Description                                                                                                      |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [`remember`](#remember)                         | Store a new memory                                                                                               |
| [`recall`](#recall)                             | Query memories by key, domain, or similarity                                                                     |
| [`list_keys`](#list_keys)                       | List available memory keys (guard against hallucinations)                                                        |
| [`forget`](#forget)                             | Mark a memory as tombstoned                                                                                      |
| [`squash`](#squash)                             | Compact old memory partitions                                                                                    |
| [`get_compaction_stats`](#get_compaction_stats) | Repository compaction statistics                                                                                 |
| [`create_namespace`](#create_namespace)         | Create a new namespace                                                                                           |
| [`list_namespaces`](#list_namespaces)           | List all available namespaces                                                                                    |
| [`switch_namespace`](#switch_namespace)         | Switch the active namespace                                                                                      |
| [`delete_namespace`](#delete_namespace)         | Delete a namespace (requires confirmation)                                                                       |
| [`server_status`](#server_status)               | Check whether the HTTP server is listening (TCP port and/or Unix socket), report PID and MCP-over-HTTP endpoints |
| [`server_http_start`](#server_http_start)       | Trigger the HTTP server to start as a detached background process (port, socket, permissions, auth, rate-limit)  |
| [`list_profiles`](#list_profiles)               | Inspect available connection profiles (tool-visibility presets) and the active selection                         |
| [`create_profile`](#create_profile)             | Create a named profile of tool-visibility directives                                                             |
| [`update_profile`](#update_profile)             | Update a profile you own (full directive replacement)                                                            |
| [`select_profiles`](#select_profiles)           | Activate profiles for this connection/session                                                                    |

> **Profiles are visibility presets, not security boundaries.** Selecting
> profiles changes `tools/list` advertising only — every `tools/call` remains
> subject to authentication, namespace grants, and tool/runtime safeguards.
> See [Connection Profiles](../guide/connection-profiles.md).

## Tool Details

### `remember`

Store a new memory in DuckBrain.

**Parameters:**

```typescript
{
  key: string;           // Hierarchical path (e.g., "/projects/mcp/schema")
  domain: string;        // Domain: person | event | concept | message | config | raw_note
  embedding_text: string; // Memory content — text used for vector embedding
  attributes: {          // REQUIRED: object of arbitrary key/value metadata (pass {} if none)
    [key: string]: any;
  };
  namespace?: string;    // Optional: namespace to write to (default: current active namespace)
}
```

> **Note:** `attributes` is **required** by the remember schema — it is NOT optional, even though it may be an empty object `{}`. Omitting it fails validation with an `attributes is required` error.

> **Note:** The content field is `embedding_text`, not `content`. It is stored and used for vector similarity search. The HTTP API accepts the same text under the name `content` (see [HTTP API Reference](http-api.md#post-apimemories)) — both surfaces store and return the same underlying field, so a memory written via MCP with `embedding_text` is retrievable via HTTP `GET /api/memories` as `content`, and vice versa.

**Example:**

```json
{
  "key": "/projects/myapp/architecture/database",
  "domain": "concept",
  "embedding_text": "Using PostgreSQL with connection pooling via PgBouncer",
  "attributes": {
    "decision_date": "2026-01-15",
    "author": "alice",
    "confidence": "high"
  }
}
```

**Returns:**

```typescript
{
  success: boolean;
  id?: string;          // Memory UUID
  key?: string;
  partition?: string;   // Partition the memory was written to (e.g. "concept/time/2026-07")
  author?: string;      // Author email from git config
  namespace?: string;   // Namespace ACTUALLY written — resolved from the arg,
                        // or the active namespace when omitted (DOGFOOD-017)
  warning?: string;     // Present when the write landed outside the 'default'
                        // namespace (DOGFOOD-017)
  error?: string;
}
```

**Usage:**

```typescript
AI: "Remember that we're using PostgreSQL for the database"
→ Calls remember({key: "/projects/myapp/database", domain: "concept",
                  embedding_text: "Using PostgreSQL...", attributes: {...}})
→ Returns { success: true, id: "...", key: "/projects/myapp/database",
            namespace: "default" }
```

> ⚠️ **The active namespace is sticky across processes (DOGFOOD-017).** When
> the `namespace` arg is omitted, the write goes to `config.defaultNamespace`
> — which `switch_namespace` persists into `duckbrain.config.json`, so it
> affects ALL later processes, not just the current session. The response
> always echoes the namespace actually written. When the arg is omitted and the
> write lands somewhere other than the `'default'` namespace, the response
> carries a `warning` (DF-0919-06: an explicit `namespace` argument never
> warns — you named the destination, so there is nothing surprising about it).
> Pass `namespace` explicitly if the destination matters.

---

### `recall`

Query memories with flexible filtering.

**Parameters:**

```typescript
{
  // Lookup — at most ONE of these applies (precedence: key → id → keyPrefix → domain)
  key?: string;            // Exact key lookup
  id?: string;             // Exact memory UUID lookup
  keyPrefix?: string;      // Prefix glob query (e.g., "/projects/")
  domain?: string;         // Domain filter: person | event | concept | message | config | raw_note
  author?: string;         // Exact author filter (e.g. "agent-alpha@duckbrain.local")

  // Search — query and contains are mutually exclusive
  query?: string;          // Semantic search (hybrid semantic + keyword fusion, RETR-002)
  contains?: string;       // Keyword-only filter (offline FTS over content/key/attributes, RETR-001)

  // Paging
  limit?: number;          // Max results to return (default: 10; 0 = count-only empty page)
  offset?: number;         // Row offset for paging (default: 0, non-negative integer)

  // Namespace scope — namespace and allNamespaces are mutually exclusive
  namespace?: string;      // Namespace to query (default: the ACTIVE namespace)
  allNamespaces?: boolean; // With contains=: union keyword hits over EVERY namespace

  // Time range — one inclusive window; between is shorthand for after + before
  after?: string;          // ISO-8601: only rows at or after this instant
  before?: string;         // ISO-8601: only rows at or before this instant
  between?: string;        // ISO-8601 "START,END" — shorthand for after=START & before=END
  asOf?: string;           // ISO-8601 date or git ref: read the namespace state at that point in git history

  // Attribute and validity-view filters
  attr?: Record<string, string>; // Attribute filters: only rows matching EVERY name → value pair
  historical?: boolean;    // false (default) = current view (validity-filtered); true = all rows
}
```

**Field reference:**

| Field                   | Type                      | Default           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`                   | `string`                  | —                 | Exact key lookup. Highest-precedence lookup filter: when combined with `id`/`keyPrefix`/`domain`, only `key` is applied and the others are silently ignored.                                                                                                                                                                                                                                                                                                                 |
| `id`                    | `string`                  | —                 | Exact memory UUID lookup. Applied only when `key` is absent.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `keyPrefix`             | `string`                  | —                 | Prefix glob (e.g. `/projects/myapp/`). Applied only when neither `key` nor `id` is present.                                                                                                                                                                                                                                                                                                                                                                                  |
| `domain`                | `string`                  | —                 | Domain filter: `person`, `event`, `concept`, `message`, `config`, `raw_note`. Applied only when none of `key`/`id`/`keyPrefix` is present.                                                                                                                                                                                                                                                                                                                                    |
| `author`                | `string`                  | —                 | Exact author filter (the author email recorded on the row). ANDed with the lookup filter — it does not compete with `key`/`id`/`keyPrefix`/`domain`.                                                                                                                                                                                                                                                                                                                         |
| `query`                 | `string`                  | —                 | Semantic search over content embeddings — **hybrid** since RETR-002: the keyword leg (FTS sidecar) runs alongside the semantic leg and both are fused (Reciprocal Rank Fusion), degrading to keyword-only or semantic-only when one leg is unavailable. Requires a reachable embedding provider. Mutually exclusive with `contains`.                                                                                            |
| `contains`              | `string`                  | —                 | Keyword-only full-text filter over content/key/attributes — offline, no embedding provider needed (exact-token matches rank first). Mutually exclusive with `query`.                                                                                                                                                                                                                                                                                                           |
| `limit`                 | `number`                  | `10`              | Max results to return. `limit: 0` is a valid request for an empty page that still reports the true `total` (count-only).                                                                                                                                                                                                                                                                                                                                                       |
| `offset`                | `number`                  | `0`               | Row offset for paging (non-negative integer). Applied to the ORDERED result set as `[offset, offset+limit)`. On the ranked paths (semantic / hybrid / keyword) the page is taken from a bounded candidate pool (cap 1000) — an offset beyond the pool returns an empty page, never an out-of-order row. `total` is never affected by `limit`/`offset`.                                                                                                                            |
| `namespace`             | `string`                  | active namespace  | Namespace to query. Omitting it queries the ACTIVE namespace (the sticky `config.defaultNamespace` that `switch_namespace` persists) — the response echoes the namespace actually queried. Mutually exclusive with `allNamespaces`.                                                                                                                                                                                                            |
| `allNamespaces`         | `boolean`                 | `false`           | RETR-007 cross-namespace keyword search: with `contains=`, searches EVERY manifest namespace and unions the keyword hits, each carrying its own `namespace` facet. Meaningless without `contains` — that combination is refused. Mutually exclusive with `namespace`. Requires an unrestricted token (a namespace-scoped token is refused).                                                                                                                                    |
| `after`                 | `string`                  | —                 | ISO-8601 date/datetime: only rows at or after this instant (inclusive). A date-only value means the START of that day (UTC). Mutually exclusive with `between`.                                                                                                                                                                                                                                                                                                               |
| `before`                | `string`                  | —                 | ISO-8601 date/datetime: only rows at or before this instant (inclusive). A date-only value means the END of that day (UTC), so `before: "2026-08-12"` includes all of 2026-08-12. Mutually exclusive with `between`.                                                                                                                                                                                                                                                          |
| `between`               | `string`                  | —                 | ISO-8601 range as `"START,END"` (two comma-separated values) — shorthand for `after: "START"` + `before: "END"`. Mutually exclusive with `after`/`before`.                                                                                                                                                                                                                                                                                                                     |
| `asOf`                  | `string`                  | —                 | RETR-004 memory-as-of: an ISO-8601 date (resolved to the nearest commit at-or-before it) or a git ref (commit hash, branch, tag). Reads rows straight from the namespace git history — never a checkout or a write. Mutually exclusive with `query`/`contains`.                                                                                                                                                                                                                |
| `attr`                  | `Record<string, string>`  | —                 | RETR-006 attribute filters: only rows whose `attributes` JSON matches EVERY `name → value` pair (exact match, ANDed with each other and with every other filter). Values must be STRINGS (`{"tick": "403"}`, not `{"tick": 403}`); numeric/boolean attributes match by their string form, so `{"tick": "403"}` matches both `403` and `"403"`. A row lacking the attribute does not match. An empty record is a no-op.                                                       |
| `historical`            | `boolean`                 | `false`           | RETR-011 view selector. `false`/absent = CURRENT view: rows whose validity window does not contain "now" are excluded (`valid_until` in the past = expired; `valid_from` in the future = not yet valid). `true` = HISTORICAL view: every row regardless of validity — expired facts stay visible. Has no effect on `asOf` reads (those are inherently historical git-state reads).                                                                                               |

**Time-range semantics (RETR-003):**

- All bounds are **inclusive** (`after` = "since", `before` = "until").
- Accepted ISO-8601 shapes: `YYYY-MM-DD` or a datetime `YYYY-MM-DDTHH:MM[:SS[.fff]]` with an optional `Z` / `±HH:MM` offset. Naive datetimes (no `Z`, no offset) are treated as **UTC**, not host-local.
- Date-only bounds are widened to the whole day: `after: "2026-08-10"` → `2026-08-10T00:00:00.000Z`, `before: "2026-08-12"` → `2026-08-12T23:59:59.999Z`.
- The window matches both the row `timestamp` and the chat-archive key date facet (`/chats/<view>/<YYYY-MM-DD>`) — those rows' timestamps are ingestion time while the message date lives in the key.
- Invalid values (bad ISO date, a malformed `between`, or `after` later than `before`) never crash the tool: they come back as `{ memories: [], count: 0, error: "Invalid time filter: …" }` **before** any namespace work.
- The three time params are ANDed with every other filter and they **do** combine with `asOf` (they window the historical row set read at that ref).

**Mutual exclusions and precedence:**

| Combination                              | Behaviour                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `between` + `after`/`before`             | Refused — `Invalid time filter: Use either 'between' or 'after'/'before' — combining them is not supported`.                                                                       |
| `asOf` + `query`/`contains`              | Refused — `as_of cannot be combined with 'query' or 'contains' — memory-as-of reads the git state at that ref and does not run semantic or keyword search`.                        |
| `query` + `contains`                     | Refused — `Use either 'query' (hybrid semantic+keyword fusion, RETR-002) or 'contains' (keyword-only) — combining both filters is not supported`.                                   |
| `allNamespaces` without `contains`       | Refused — `allNamespaces only applies to keyword search — combine it with 'contains' (plain recall is single-namespace)`.                                                          |
| `allNamespaces` + `namespace`            | Refused — `allNamespaces cannot be combined with a specific namespace — omit namespace for a cross-namespace search`.                                                              |
| `key` + `id` + `keyPrefix` + `domain`    | Not an error: the first one present wins, in the order `key` → `id` → `keyPrefix` → `domain`. The others are ignored — pass only the one you mean.                                  |
| `after` later than `before`              | Refused — `Invalid time filter: after (<instant>) must not be later than before (<instant>)`.                                                                                       |

Refusals are returned in the tool result's `error` field (not as a transport error), matching the [Error Handling](#error-handling) contract — see the note there on MCP in-band errors.

**Examples:**

**By key prefix:**

```json
{
  "keyPrefix": "/projects/myapp/"
}
```

**By domain:**

```json
{
  "domain": "concept"
}
```

**By exact key (`key`), by UUID (`id`), or by author:**

```json
{ "key": "/projects/myapp/database" }
```

```json
{ "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }
```

```json
{ "author": "agent-alpha@duckbrain.local", "domain": "concept", "limit": 50 }
```

**Targeting a namespace (`namespace`):**

```json
{
  "keyPrefix": "/projects/myapp/",
  "namespace": "my-project"
}
```

Omitting `namespace` queries the ACTIVE namespace instead of `default` — the response always echoes the namespace actually queried.

**Semantic search:**

```json
{
  "query": "database connection pooling",
  "limit": 5
}
```

**Keyword search (offline, no embedding provider):**

```json
{
  "contains": "connection pooling",
  "domain": "concept"
}
```

**Cross-namespace keyword search (RETR-007):**

```json
{
  "contains": "PgBouncer",
  "allNamespaces": true
}
```

Unions keyword hits over every namespace and tags each hit with its own `namespace`. Do not pass `namespace` alongside `allNamespaces`.

**Combined:**

```json
{
  "keyPrefix": "/projects/myapp/architecture/",
  "domain": "concept",
  "limit": 20
}
```

`domain` is ignored here — `keyPrefix` takes precedence.

**Time-scoped (RETR-003):**

```json
{
  "domain": "message",
  "after": "2026-08-10",
  "before": "2026-08-12"
}
```

```json
{
  "domain": "message",
  "between": "2026-08-10,2026-08-12"
}
```

Both forms return the same rows (2026-08-10 through 2026-08-12 inclusive). Never combine `between` with `after`/`before`.

**Paging:**

```json
{
  "domain": "concept",
  "limit": 20,
  "offset": 40
}
```

Returns the third page of 20 (`[40, 60)` of the ordered match set) with the unlimited `total` alongside.

**Count-only (empty page):**

```json
{
  "domain": "concept",
  "limit": 0
}
```

Returns `{ "memories": [], "count": 0, "total": 137 }` — the true match count without fetching rows.

**Attribute filter (RETR-006):**

```json
{
  "domain": "config",
  "attr": { "tick": "403" }
}
```

Matches rows whose `attributes.tick` is `403` or `"403"`.

**Historical view (RETR-011):**

```json
{
  "keyPrefix": "/projects/myapp/",
  "historical": true
}
```

Includes rows whose validity window has passed (`valid_until` in the past) or has not started yet (`valid_from` in the future) — the default current view hides those.

**Time travel (RETR-004):**

```json
{
  "keyPrefix": "/projects/myapp/",
  "asOf": "2026-08-10"
}
```

Reads the namespace state as it existed at the nearest commit at-or-before 2026-08-10. Accepts ISO dates or git refs (commit hashes, branch names, tags). Cannot combine with `query` or `contains` — semantic/keyword search indexes have no historical state. `asOf` **does** combine with `key`/`id`/`keyPrefix`/`domain`/`author`/`after`/`before`/`between`/`attr`/`limit`/`offset`, which filter the historical row set.

**Returns:**

```typescript
{
  memories: Array<{
    id: string;
    key: string;
    domain: string;
    embedding_text: string;   // Memory content
    attributes: object;
    timestamp: string;
    author: string;
    action: "add" | "update" | "tombstone";
  }>;
  count: number;        // Rows in THIS response (= memories.length, bounded by limit)
  total?: number;       // True match count, unlimited by limit/offset (GAP-024) — the
                        // number to page against. Present on every successful result
                        // (list, keyword contains=, semantic/hybrid query, as-of,
                        // count-only limit=0); on the ranked (query/contains) paths it
                        // is the ranked candidate-pool size, not the namespace row count
  error?: string;
  namespace?: string;   // Namespace ACTUALLY queried — resolved from the arg,
                        // or the active namespace when omitted (DOGFOOD-017);
                        // "all" for an allNamespaces union
}
```

**Usage:**

```
AI: "What database are we using?"
→ Calls recall({query: "database"})
→ Returns matching memories with PostgreSQL info

AI: "List all architecture decisions"
→ Calls recall({domain: "concept", keyPrefix: "/projects/myapp/architecture/"})
→ Returns all memories under that prefix
```

---

### `list_keys`

List available memory keys to prevent hallucinations.

**Parameters:**

```typescript
{
  prefix?: string;      // Key prefix filter (default: "/")
  maxDepth?: number;    // Max hierarchy depth to return (default: 3)
  limit?: number;       // Max keys to return (default: 50)
  offset?: number;      // Pagination offset (default: 0)
  namespace?: string;   // Namespace to query
}
```

**Examples:**

```json
{
  "prefix": "/projects/myapp/",
  "maxDepth": 3,
  "limit": 50
}
```

**Returns:**

```typescript
{
  keys: string[];
  prefixes?: string[];   // Intermediate prefixes (folders)
  hasMore: boolean;
  error?: string;
}
```

**Usage:**

```
AI: "What keys exist in this project?"
→ Calls list_keys({prefix: "/projects/myapp/"})
→ Returns ["/projects/myapp/database", "/projects/myapp/auth", ...]
```

---

### `forget`

Mark a memory as tombstoned (soft delete).

**Parameters:**

```typescript
{
  id: string;           // UUID of the memory to forget
  reason?: string;      // Optional reason for deletion
  namespace?: string;   // Namespace to search
  domain?: string;      // Domain to search (optimization)
}
```

**Example:**

```json
{
  "id": "a1b2c3d4-0000-4000-8000-000000000001",
  "reason": "Task completed and no longer relevant"
}
```

**Returns:**

```typescript
{
  success: boolean;
  error?: string;
}
```

**Usage:**

```
AI: "Remove that old TODO about fixing the login bug"
→ Calls forget({id: "a1b2c3d4-..."})
→ Memory is marked as tombstoned (full history preserved in git)
```

---

### `squash`

Compact old memory partitions to reduce repository size. Converts JSONL to Parquet, removes tombstones, and optionally squashes git history.

**Parameters:**

```typescript
{
  partition?: string;    // Specific partition to squash (optional — defaults to all old partitions)
  dryRun?: boolean;      // Preview without making changes (default: false)
  aggressive?: boolean;  // Squash git history aggressively (default: false)
  namespace?: string;    // Namespace to compact
}
```

**Examples:**

**Preview what would be compacted:**

```json
{
  "dryRun": true
}
```

**Compact one partition with history rewrite:**

```json
{
  "partition": "concept/time/2025-01",
  "aggressive": true
}
```

**Returns:**

```typescript
{
  success: boolean;
  message: string;      // Human-readable summary
  stats?: {
    partitionsCompacted?: number;
    totalRecordsKept?: number;
    totalRecordsRemoved?: number;
    tombstonesRemoved?: number;
  };
  errors?: string[];
}
```

**Usage:**

```
AI: "Compact old memory partitions"
→ Calls squash({dryRun: true}) to preview first
→ Then squash({}) to compact partitions older than 30 days with > 1000 records
```

---

### `get_compaction_stats`

Get repository compaction statistics. No input parameters.

**Parameters:** none (`{}`)

**Returns:**

```typescript
{
  success: boolean;
  stats?: {
    totalSize: number;          // Total repo size in bytes
    totalPartitions: number;
    parquetPartitions: number;
    jsonlPartitions: number;
    totalRecords: number;
    tombstoneRecords: number;
    tombstonePercent: number;   // Percentage of records that are tombstones
    parquetRatio: number;       // Ratio of Parquet to total partitions
    oldPartitions: string[];    // Partitions eligible for compaction
    largePartitions: Array<{ path: string; size: number; records: number }>;
  };
  error?: string;
}
```

**Usage:**

```
AI: "How healthy is the memory repo?"
→ Calls get_compaction_stats({})
→ Returns tombstone percentage, Parquet ratio, and partition health
```

---

### `create_namespace`

Create a new memory namespace (a separate git repository).

**Parameters:**

```typescript
{
  name: string;         // Namespace name (lowercase alphanumeric, hyphens/underscores)
  setDefault?: boolean; // Set as the default namespace (default: false)
}
```

**Example:**

```json
{
  "name": "my-new-project",
  "setDefault": true
}
```

**Returns:**

```typescript
{
  success: boolean;
  path?: string;        // Filesystem path of the new namespace
  error?: string;
}
```

---

### `list_namespaces`

List all available namespaces. No input parameters.

**Parameters:** none (`{}`)

**Returns:**

```typescript
{
  success: boolean;
  namespaces: Array<{
    name: string;
    path: string;
    isDefault: boolean;
  }>;
  currentNamespace?: string;
  error?: string;
}
```

**Usage:**

```
AI: "What namespaces do I have?"
→ Calls list_namespaces({})
→ Returns [{name: "default", path: "./namespaces/default", isDefault: true}, ...]
```

---

### `switch_namespace`

Switch the active (default) namespace.

> ⚠️ **The active namespace is STICKY ACROSS PROCESSES (DOGFOOD-017).** The
> switch persists `defaultNamespace` into `duckbrain.config.json`
> (`updateConfig`), so it applies to every LATER separate process too — any
> namespace-less `remember`/`recall`/`forget` call in a new session resolves
> to this namespace, not to `'default'`. Responses to `remember`/`recall`
> echo the resolved namespace so you can see where data actually landed
> (and `remember` warns when the write goes outside `'default'`). To switch
> back, call `switch_namespace({name: "default"})` — or pass `namespace`
> explicitly on every call and never rely on the active default.

**Parameters:**

```typescript
{
  name: string; // Namespace name to switch to
}
```

**Returns:**

```typescript
{
  success: boolean;
  previous?: string;    // Previously active namespace
  current?: string;     // Newly active namespace (persisted to duckbrain.config.json)
  error?: string;
}
```

---

### `delete_namespace`

Delete a namespace. Requires explicit confirmation. The `default` namespace and the currently active namespace cannot be deleted.

**Parameters:**

```typescript
{
  name: string; // Namespace name to delete
  confirm: boolean; // Must be true to confirm deletion (required)
}
```

**Example:**

```json
{
  "name": "old-project",
  "confirm": true
}
```

**Returns:**

```typescript
{
  success: boolean;
  error?: string;
}
```

---

### `server_status`

Check whether the DuckBrain HTTP server is listening. Reports TCP port and/or Unix socket status, the PID from the sidecar PID file, and the MCP-over-HTTP endpoints that are currently reachable.

**Parameters:**

```typescript
{
  port?: number;    // TCP port to check (default: 3000)
  socket?: string;  // Unix socket path to check (e.g. /tmp/duckbrain.sock)
}
```

**Example:**

```json
{
  "port": 3000,
  "socket": "/tmp/duckbrain.sock"
}
```

**Returns:**

```typescript
{
  success: boolean;          // true if port and/or socket is listening
  port?: number;             // the port that was checked
  portListening?: boolean;   // whether the TCP port is reachable
  socket?: string;           // the socket path that was checked
  socketListening?: boolean; // whether the Unix socket file exists and is a socket
  pid?: number | null;       // PID read from the sidecar PID file, if present
  pidFile?: string;          // path of the sidecar PID file
  endpoints?: string[];      // reachable MCP endpoints (http://127.0.0.1:<port>/mcp, unix:<socket> -> POST /mcp)
}
```

**Example response:**

```json
{
  "success": true,
  "port": 3000,
  "portListening": true,
  "socket": "/tmp/duckbrain.sock",
  "socketListening": true,
  "pid": 4719,
  "pidFile": "/tmp/duckbrain-http-3000.pid",
  "endpoints": [
    "http://127.0.0.1:3000/mcp",
    "unix:/tmp/duckbrain.sock -> POST /mcp"
  ]
}
```

---

### `server_http_start`

Start the DuckBrain HTTP server as a detached background process if it is not already listening on the requested port. Mirrors the `duckbrain http` CLI options (port, bind-all, auth, rate-limit, Unix socket, socket permissions/group). Use this to enable MCP-over-HTTP from an MCP client.

**Parameters:**

```typescript
{
  port?: number;        // TCP port (default: 3000)
  bindAll?: boolean;    // Bind to 0.0.0.0 instead of 127.0.0.1 (default: false)
  authType?: "none" | "basic" | "apikey";  // Authentication type (default: apikey; use none only for explicit local mode)
  rateLimit?: number;   // Requests per minute per IP (default: 100)
  socket?: string;      // Also listen on a Unix domain socket at this path
  socketMode?: string;  // Socket file permissions as octal string (default: 0660)
  socketGroup?: string; // Group name or numeric GID to chown the socket to
  force?: boolean;      // Start even if the port is already listening (default: false)
}
```

**Example:**

```json
{
  "port": 3000,
  "socket": "/tmp/duckbrain.sock",
  "authType": "apikey"
}
```

**Returns:**

```typescript
{
  success: boolean;          // true if the server is listening after the call
  alreadyRunning?: boolean;  // true if the port was already listening (and force was false)
  spawned?: boolean;         // true if a new process was spawned
  pid?: number | null;       // PID of the spawned process
  message: string;           // human-readable status (e.g. "HTTP server already listening on port 3000")
}
```

**Example response:**

```json
{
  "success": true,
  "alreadyRunning": true,
  "message": "HTTP server already listening on port 3000"
}
```

---

### `list_profiles`

Inspect available connection profiles and the active selection for this
connection. Profiles are tool-visibility presets (see
[Connection Profiles](../guide/connection-profiles.md) for the full model).

**Parameters:** none (empty object).

**Returns:**

```typescript
{
  success: boolean;
  profiles: Array<{
    name: string;
    owner: string;
    description?: string;
    directives: Array<{ tool: string; visibility: "hidden" | "exclusive" | "default" }>;
    createdAt: string;
    updatedAt: string;
  }>;
  builtInTools: string[];          // every built-in tool name
  registeredCustomTools: string[]; // custom tools registered on THIS server (when present)
  activeSelection: string[] | undefined;
  note: string;                    // the visibility-not-authorization contract
}
```

---

### `create_profile`

Create a named profile of tool-visibility directives. Any connection may
create profiles — profiles do not control authorization, so creation
requires no privilege. Creates never overwrite: use `update_profile`.

**Parameters:**

```typescript
{
  name: string;          // unique profile name
  owner: string;         // owner label (only the owner can update later)
  description?: string;  // human-readable purpose
  directives: Array<{ tool: string; visibility: "hidden" | "exclusive" | "default" }>;
}
```

**Returns:** `{ success, profile, preview, note }` where `preview` shows
`visibleTools`, `hiddenTools`, and `unknownProfiles` as they would apply to
the new profile alone.

---

### `update_profile`

Update a profile you own — a FULL replacement of its directives (not a
merge). Overwriting another owner's profile is refused: profiles are
per-agent connection state, and one agent must not mutate another's.

**Parameters:**

```typescript
{
  name: string;          // profile to update
  owner: string;         // must match the stored owner
  description?: string;
  directives: Array<{ tool: string; visibility: "hidden" | "exclusive" | "default" }>;
}
```

**Returns:** `{ success, profile, preview, note }` or
`{ success: false, error }` (missing profile / foreign owner).

---

### `select_profiles`

Activate one or more profiles for THIS connection/session. Selection is
session state: it filters `tools/list` for this connection only and never
touches another connection's state. Never grants or restricts authority.

**Parameters:**

```typescript
{
  profiles: string[];    // profile names; empty array clears the selection
}
```

**Returns:** `{ success, selected, scope: "connection", preview, note }`.

Over MCP-over-HTTP, a client can also pass the selection per request with
the `X-DuckBrain-Profiles` header (comma-separated profile names), which
takes precedence over the connection slot for that single request — see
[Connection Profiles](../guide/connection-profiles.md).

---

## Memory Key Conventions

Use consistent hierarchical keys for better organization:

```
/projects/[PROJECT_NAME]/
  ├── architecture/     # Design decisions and patterns
  ├── code/             # Implementation details
  ├── decisions/        # Decision logs with reasoning
  ├── todos/            # Task lists and checklists
  ├── errors/           # Known issues and solutions
  ├── context/          # Session context and state
  └── docs/             # Documentation
```

**Examples:**

- `/projects/webapp/architecture/database-choice`
- `/projects/webapp/code/auth-middleware`
- `/projects/webapp/todos/sprint-5`
- `/projects/webapp/errors/database-timeout`

## Domain Categories

The `domain` field is an enum with six values:

| Domain     | Use For                                         |
| ---------- | ----------------------------------------------- |
| `person`   | People, contacts, team members                  |
| `event`    | Meetings, incidents, milestones                 |
| `concept`  | Ideas, architecture, design decisions           |
| `message`  | Communication records, notes from conversations |
| `config`   | Configuration values and settings               |
| `raw_note` | Unstructured notes and observations             |

## Error Handling

Tools return consistent error responses. Most tools use:

```typescript
{
  success: false;
  error: "Description of what went wrong";
}
```

The `recall` and `list_keys` tools return an `error` field alongside (possibly empty) result arrays instead.

**Common errors:**

- `Namespace not found` — Create it with `create_namespace` or `duckbrain init`
- `Key not found` — Use `list_keys` to check valid keys
- `Permission denied` — Check file permissions on the namespaces directory
- `Invalid key format` — Keys must start with `/` and use only alphanumeric characters, hyphens, underscores, and slashes

## Best Practices

1. **Use hierarchical keys** — `/projects/myapp/feature/component`
2. **Include reasoning** — Store not just what but why in `embedding_text`
3. **Use attributes** — Add metadata like author, date, confidence
4. **Organize by domain** — Makes searching easier
5. **Update rather than overwrite** — Use new keys for new versions
6. **Clean up old memories** — Use `forget` for obsolete information
7. **Compact periodically** — Use `squash` (with `dryRun: true` first) to keep the repo small

## Examples

### Storing Architecture Decisions

```
AI: "Remember we chose PostgreSQL over MongoDB because we need ACID transactions for financial data"

→ remember({
    key: "/projects/myapp/decisions/database",
    domain: "concept",
    embedding_text: "Chose PostgreSQL over MongoDB. Reason: need ACID transactions for financial data.",
    attributes: {
      "decision_date": "2026-07-19",
      "alternatives": ["MongoDB"],
      "confidence": "high"
    }
  })
```

### Namespace Workflow

```
AI: "Create a namespace for the new mobile app project and switch to it"

→ create_namespace({name: "mobile-app", setDefault: true})
→ Returns { success: true, path: "./namespaces/mobile-app" }

Later:
→ list_namespaces({})
→ switch_namespace({name: "default"})
```
