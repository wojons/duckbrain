# MCP Tools Reference

DuckBrain exposes Model Context Protocol (MCP) tools that AI agents can use to store, query, and manage memories.

## Available Tools

| Tool | Description |
|------|-------------|
| [`remember`](#remember) | Store a new memory |
| [`recall`](#recall) | Query memories by key, domain, or similarity |
| [`list_keys`](#list_keys) | List available memory keys (guard against hallucinations) |
| [`forget`](#forget) | Mark a memory as tombstoned |

## Tool Details

### `remember`

Store a new memory in DuckBrain.

**Parameters:**

```typescript
{
  key: string;        // Hierarchical path (e.g., "/projects/mcp/schema")
  content: string;    // Memory content
  domain?: string;    // Optional: domain category
  attributes?: {      // Optional: additional metadata
    [key: string]: string | number | boolean;
  };
}
```

**Example:**

```json
{
  "key": "/projects/myapp/architecture/database",
  "content": "Using PostgreSQL with connection pooling via PgBouncer",
  "domain": "architecture",
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
  status: "success" | "error";
  key: string;
  id?: string;        // Memory ID
  error?: string;
}
```

**Usage:**

```
AI: "Remember that we're using PostgreSQL for the database"
→ Calls remember({key: "/projects/myapp/database", content: "Using PostgreSQL..."})
→ Returns success confirmation
```

---

### `recall`

Query memories with flexible filtering.

**Parameters:**

```typescript
{
  key?: string;           // Exact key or pattern (supports wildcards: *, ?)
  domain?: string;        // Filter by domain
  semantic?: string;      // Semantic search query
  limit?: number;         // Max results (default: 10)
  includeTombstoned?: boolean;  // Include deleted memories
}
```

**Examples:**

**By key pattern:**
```json
{
  "key": "/projects/myapp/*"
}
```

**By domain:**
```json
{
  "domain": "architecture"
}
```

**Semantic search:**
```json
{
  "semantic": "database connection pooling",
  "limit": 5
}
```

**Combined:**
```json
{
  "key": "/projects/myapp/architecture/*",
  "domain": "architecture",
  "limit": 20
}
```

**Returns:**

```typescript
{
  status: "success" | "error";
  memories: Array<{
    key: string;
    content: string;
    domain?: string;
    timestamp: string;
    attributes?: object;
  }>;
  count: number;
  error?: string;
}
```

**Usage:**

```
AI: "What database are we using?"
→ Calls recall({semantic: "database"})
→ Returns matching memories with PostgreSQL info

AI: "List all architecture decisions"
→ Calls recall({domain: "architecture"})
→ Returns all memories in architecture domain
```

---

### `list_keys`

List available memory keys to prevent hallucinations.

**Parameters:**

```typescript
{
  prefix?: string;    // Filter by key prefix
  domain?: string;    // Filter by domain
  limit?: number;     // Max results (default: 100)
}
```

**Examples:**

```json
{
  "prefix": "/projects/myapp/",
  "limit": 50
}
```

**Returns:**

```typescript
{
  status: "success" | "error";
  keys: string[];
  count: number;
  error?: string;
}
```

**Usage:**

```
AI: "What keys exist in this project?"
→ Calls list_keys({prefix: "/projects/myapp/"})
→ Returns ["/projects/myapp/database", "/projects/myapp/auth", ...]

AI: "Check if we have any TODO items"
→ Calls list_keys({domain: "todos"})
→ Returns keys in the todos domain
```

---

### `forget`

Mark a memory as tombstoned (soft delete).

**Parameters:**

```typescript
{
  key: string;        // Key of memory to forget
  reason?: string;    // Optional: reason for deletion
}
```

**Example:**

```json
{
  "key": "/projects/myapp/todos/old-task",
  "reason": "Task completed and no longer relevant"
}
```

**Returns:**

```typescript
{
  status: "success" | "error";
  key: string;
  error?: string;
}
```

**Usage:**

```
AI: "Remove that old TODO about fixing the login bug"
→ Calls forget({key: "/projects/myapp/todos/login-bug-fix"})
→ Memory is marked as tombstoned

AI: "What were the old architecture decisions we rejected?"
→ Can recall tombstoned memories with includeTombstoned: true
```

---

## Memory Key Conventions

Use consistent hierarchical keys for better organization:

```
/projects/[PROJECT_NAME]/
  ├── architecture/     # Design decisions and patterns
  ├── code/            # Implementation details
  ├── decisions/       # Decision logs with reasoning
  ├── todos/          # Task lists and checklists
  ├── errors/         # Known issues and solutions
  ├── context/        # Session context and state
  └── docs/           # Documentation
```

**Examples:**

- `/projects/webapp/architecture/database-choice`
- `/projects/webapp/code/auth-middleware`
- `/projects/webapp/todos/sprint-5`
- `/projects/webapp/errors/database-timeout`

## Domain Categories

Common domains for organizing memories:

| Domain | Use For |
|--------|---------|
| `architecture` | High-level design decisions |
| `code` | Implementation details, patterns |
| `decisions` | Decision logs with trade-offs |
| `todos` | Task lists and action items |
| `errors` | Known issues and debugging notes |
| `context` | Session state and current focus |
| `docs` | Documentation and references |

## Error Handling

All tools return consistent error responses:

```typescript
{
  status: "error";
  error: "Description of what went wrong";
}
```

**Common errors:**

- `Namespace not found` - Initialize with `duckbrain init`
- `Key not found` - Use `list_keys` to check valid keys
- `Permission denied` - Check file permissions on memory directory
- `Invalid key format` - Keys must start with "/" and use only alphanumeric characters, hyphens, underscores, and slashes

## Best Practices

1. **Use hierarchical keys** - `/projects/myapp/feature/component`
2. **Include reasoning** - Store not just what but why
3. **Use attributes** - Add metadata like author, date, confidence
4. **Organize by domain** - Makes searching easier
5. **Update rather than overwrite** - Use new keys for new versions
6. **Clean up old memories** - Use `forget` for obsolete information

## Examples

### Storing Architecture Decisions

```
AI: "Remember we chose PostgreSQL over MongoDB because we need ACID transactions for financial data"

→ remember({
  key: "/projects/myapp/decisions/database",
  content: 