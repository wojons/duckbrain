# HTTP API Reference

DuckBrain's HTTP server provides REST API access to memories, namespaces, and system information, plus Streamable HTTP transport for remote MCP connections.

## Starting the HTTP Server

```bash
# Default port 3000, localhost only
npm start -- http

# Custom port
npm start -- http --port=8490

# Bind to all interfaces (for remote access)
npm start -- http --bind-all --port=8080

# With authentication
npm start -- http --auth=apikey --rate-limit=60
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

**Example:**

```bash
# List available tools
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
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
| `limit` | 50 | Max results to return |
| `offset` | 0 | Pagination offset |
| `namespace` | `default` | Namespace to query |

**Response:**

```json
{
  "items": [
    {
      "id": "uuid-string",
      "key": "/projects/myapp/database",
      "domain": "architecture",
      "content": "Using PostgreSQL with PgBouncer",
      "attributes": { "author": "alice", "confidence": "high" },
      "timestamp": "2026-07-19T12:00:00.000Z",
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

**Example:**

```bash
curl "http://localhost:3000/api/memories?domain=architecture&limit=10"
```

#### `GET /api/memories/key/:key`

Get the latest memory by key path. Returns 404 if the key does not exist.

**Example:**

```bash
curl "http://localhost:3000/api/memories/key/projects/myapp/database"
```

#### `GET /api/memories/:id`

Get a memory by its unique ID. Returns 404 if the ID is not found.

**Example:**

```bash
curl "http://localhost:3000/api/memories/a1b2c3d4-e5f6-7890-abcd-ef1234567890"
```

#### `POST /api/memories`

Create a new memory.

**Request:**

```json
{
  "key": "/projects/myapp/database",
  "domain": "architecture",
  "content": "Using PostgreSQL with PgBouncer for connection pooling",
  "attributes": {
    "author": "alice",
    "confidence": "high"
  }
}
```

**Response:** (201 Created)

```json
{
  "id": "uuid-string",
  "key": "/projects/myapp/database",
  "domain": "architecture",
  "content": "Using PostgreSQL with PgBouncer...",
  "attributes": { "author": "alice", "confidence": "high" },
  "timestamp": "2026-07-19T12:00:00.000Z",
  "author": "alice@example.com",
  "isTombstone": false,
  "action": "add"
}
```

**Example:**

```bash
curl -X POST http://localhost:3000/api/memories \
  -H "Content-Type: application/json" \
  -d '{"key":"/projects/myapp/database","domain":"architecture","content":"Using PostgreSQL"}'
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
  "domain": "architecture",
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
npm start -- http --auth=apikey

# Configure keys in ~/.duckbrain/auth.json
# {"apiKeys": [{"key": "sk-duckbrain-abc123", "name": "default"}]}

# Authenticated request
curl http://localhost:3000/api/memories \
  -H "X-API-Key: sk-duckbrain-abc123"
```

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
