# MCP Tools Reference

DuckBrain exposes Model Context Protocol (MCP) tools that AI agents can use to store, query, and manage memories.

## Available Tools

| Tool | Description |
|------|-------------|
| [`remember`](#remember) | Store a new memory |
| [`recall`](#recall) | Query memories by key, domain, or similarity |
| [`list_keys`](#list_keys) | List available memory keys (guard against hallucinations) |
| [`forget`](#forget) | Mark a memory as tombstoned |
| [`squash`](#squash) | Compact old memory partitions |
| [`get_compaction_stats`](#get_compaction_stats) | Repository compaction statistics |
| [`create_namespace`](#create_namespace) | Create a new namespace |
| [`list_namespaces`](#list_namespaces) | List all available namespaces |
| [`switch_namespace`](#switch_namespace) | Switch the active namespace |
| [`delete_namespace`](#delete_namespace) | Delete a namespace (requires confirmation) |

## Tool Details

### `remember`

Store a new memory in DuckBrain.

**Parameters:**

```typescript
{
  key: string;           // Hierarchical path (e.g., "/projects/mcp/schema")
  domain: string;        // Domain: person | event | concept | message | config | raw_note
  embedding_text: string; // Memory content — text used for vector embedding
  attributes: {          // Additional metadata (arbitrary JSON)
    [key: string]: any;
  };
  namespace?: string;    // Optional: namespace to write to (default: current active namespace)
}
```

> **Note:** The content field is `embedding_text`, not `content`. It is stored and used for vector similarity search.

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
  error?: string;
}
```

**Usage:**

```
AI: "Remember that we're using PostgreSQL for the database"
→ Calls remember({key: "/projects/myapp/database", domain: "concept",
                  embedding_text: "Using PostgreSQL...", attributes: {...}})
→ Returns { success: true, id: "...", key: "/projects/myapp/database" }
```

---

### `recall`

Query memories with flexible filtering.

**Parameters:**

```typescript
{
  key?: string;         // Exact key lookup
  keyPrefix?: string;   // Prefix glob query (e.g., "/projects/")
  domain?: string;      // Filter by domain (person, event, concept, message, config, raw_note)
  query?: string;       // Semantic search query (uses DuckDB VSS extension)
  limit?: number;       // Max results (default: 10)
  namespace?: string;   // Namespace to query (default: current active namespace)
}
```

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

**Semantic search:**
```json
{
  "query": "database connection pooling",
  "limit": 5
}
```

**Combined:**
```json
{
  "keyPrefix": "/projects/myapp/architecture/",
  "domain": "concept",
  "limit": 20
}
```

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
  error?: string;
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

**Parameters:**

```typescript
{
  name: string;         // Namespace name to switch to
}
```

**Returns:**

```typescript
{
  success: boolean;
  previous?: string;    // Previously active namespace
  current?: string;     // Newly active namespace
  error?: string;
}
```

---

### `delete_namespace`

Delete a namespace. Requires explicit confirmation. The `default` namespace and the currently active namespace cannot be deleted.

**Parameters:**

```typescript
{
  name: string;         // Namespace name to delete
  confirm: boolean;     // Must be true to confirm deletion (required)
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

| Domain | Use For |
|--------|---------|
| `person` | People, contacts, team members |
| `event` | Meetings, incidents, milestones |
| `concept` | Ideas, architecture, design decisions |
| `message` | Communication records, notes from conversations |
| `config` | Configuration values and settings |
| `raw_note` | Unstructured notes and observations |

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
