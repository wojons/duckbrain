# Configuration Reference

DuckBrain can be configured through environment variables and a JSON configuration file. Environment variables take precedence over the config file.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DUCKBRAIN_HOME` | — | **Not implemented.** No code reads this variable; the home directory is derived from `DUCKBRAIN_HOME_ROOT` / the install layout |
| `DUCKBRAIN_NAMESPACE` | — | **Not implemented.** No code reads this variable; use the per-call namespace parameter or the config file's `defaultNamespace` |
| `DUCKBRAIN_HOME_ROOT` | — | Explicit install-root override for the DuckBrain home directory (read at `src/config/index.ts`). Set when the derived install root cannot be resolved (e.g. non-standard layouts) |
| `DUCKBRAIN_DURABILITY_MODE` | — | Runtime override of the namespace durability write mode (SUPA-1). A malformed value fails config load through the schema enum — never a silent fallback to buffered, because a silently-buffered namespace means acked writes are not durable. Never persisted into `duckbrain.config.json`. Precedence: `durability.overrides[ns]` > this env var > config default |
| `DUCKBRAIN_NAMESPACES_PATH` | `./namespaces` | Directory containing namespace repositories. Env-only, never persisted into `duckbrain.config.json` (BUG-037) |
| `DUCKBRAIN_API_PORT` | `3000` | HTTP API server port |
| `DUCKBRAIN_UI_PORT` | — | **Not implemented.** The Web UI (packages/ui) is a separate Vite app; no code reads this variable |
| `DUCKBRAIN_HTTP_SOCKET` | — | Unix socket path for HTTP server (used by `service install` unit) |
| `DUCKBRAIN_HTTP_SOCKET_MODE` | — | Socket file permissions octal string (e.g. `0660`), used by `service install` unit |
| `DUCKBRAIN_LOG_LEVEL` | — | **Not implemented.** No code reads this variable |
| `DUCKBRAIN_SEARCH_MIN_SCORE` | — | Operator knob for the semantic recall relevance floor (0..1). Absent or invalid → the search default (0.25) applies. Read by `src/mcp/tools/recall.ts` |
| `DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS` | `5000` | Row bound for the read-path keyword-search auto-build: a namespace with more source rows is refused inline indexing (the read keeps its pre-change behavior) instead of blocking on a multi-minute rebuild. A value of 0 refuses every auto-build. Read by `src/search/index.ts` |
| `DUCKBRAIN_ALLOWED_HOSTS` | — | Comma-separated extra Host-header values the DNS-rebinding guard accepts on top of `localhost`/`127.0.0.1`. Empty/absent keeps the loopback-only default. Overridden by an explicit `--allowed-hosts` flag (see [Deployment Guide](deployment)) |
| `DUCKBRAIN_REALTIME_POLL_MS` | `1000` | Runtime override of the realtime change feed's per-namespace HEAD-observation poll interval (`realtime.pollIntervalMs`) in milliseconds — how often the SSE stream (`GET /api/ns/:ns/changes`) checks for new commits, which bounds change-delivery latency. Must be a positive integer; a malformed or non-positive value fails config load rather than silently falling back. Runtime-only, never persisted into `duckbrain.config.json` |
| `DUCKBRAIN_REALTIME_HEARTBEAT_MS` | `15000` | Runtime override of the realtime change feed's heartbeat interval (`realtime.heartbeatMs`) in milliseconds — the `:heartbeat` keep-alive comment frame sent on an idle SSE stream. Same validation and runtime-only rules as `DUCKBRAIN_REALTIME_POLL_MS` |
| `DUCKBRAIN_SKIP_SEARCH_REBUILD` | — | When set (to any non-empty value), the `post-checkout` / `post-merge` / `post-rewrite` git hooks installed by `duckbrain search-index install-hooks` exit without rebuilding the keyword search index. The detached `search-index rebuild` re-spawn sets this to `1` itself so nested git operations cannot re-trigger the hooks (mirror of `DUCKBRAIN_SKIP_EMBED_REBUILD`) |
| `DUCKBRAIN_KEYS_CACHE` | `enabled` | Key-list materialization cache for `list_keys` (the per-namespace `.keys/` sidecar). Set to `off` to disable the cache so every call runs the full cold SQL aggregation; any other value — including unset — leaves the cache enabled |
| `AUTH_TYPE` | — | **Not implemented.** No code reads this variable. HTTP auth is configured via the auth file (`~/.duckbrain/auth.json`, overridable with `--auth-file` / `DUCKBRAIN_AUTH_FILE` — see [Deployment Guide](deployment)) |
| `AUTH_TOKEN` | — | **Not implemented.** No code reads this variable; see `DUCKBRAIN_AUTH_FILE` above |
| `DUCKBRAIN_AUTH_FILE` | — | Path to the auth file (users/apiKeys) read by the HTTP server. Precedence: explicit `--auth-file` > this env var > `~/.duckbrain/auth.json` |
| `NODE_ENV` | — | Set to `production` for production deployments |

---

## Configuration File

DuckBrain reads configuration from `duckbrain.config.json` in the current directory. If the file does not exist, defaults are used.

```json
{
  "defaultNamespace": "default",
  "authorEmail": "duckbrain@localhost.localdomain",
  "namespacesPath": "./namespaces",
  "gitBatching": {
    "maxLines": 100,
    "maxSeconds": 30,
    "enabled": true
  },
  "storage": {
    "maxLinesPerChunk": 1000,
    "maxBytesPerChunk": 1048576
  },
  "squash": {
    "maxAgeDays": 30,
    "thresholdRecords": 1000,
    "autoCompact": false,
    "squashGitHistory": true,
    "compressionLevel": 6
  },
  "namespaceMappings": {}
}
```

### Top-Level Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultNamespace` | string | `"default"` | Default namespace for operations when none is specified |
| `authorEmail` | string | `"duckbrain@localhost.localdomain"` | Author email for attributing memories (used for git commits) |
| `namespacesPath` | string | `"./namespaces"` | Path to the directory containing namespace subdirectories |
| `gitBatching` | object | (see below) | Git commit batching settings |
| `storage` | object | (see below) | Storage chunk settings |
| `squash` | object | (see below) | Compaction and squash settings |
| `namespaceMappings` | object | `{}` | Alias-to-path mappings for namespaces |

### gitBatching Settings

Controls how the CLI worker batches git commits. Note: MCP tools always commit synchronously on each operation — batching only applies to the CLI worker.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxLines` | number | `100` | Max JSONL lines before forcing a git commit |
| `maxSeconds` | number | `30` | Max seconds before forcing a git commit |
| `enabled` | boolean | `true` | Enable/disable the background batch worker |

### storage Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxLinesPerChunk` | number | `1000` | Maximum lines per JSONL chunk file |
| `maxBytesPerChunk` | number | `1048576` | Maximum bytes per JSONL chunk file (1 MB) |

### squash Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxAgeDays` | number | `30` | Partitions older than this many days are eligible for compaction |
| `thresholdRecords` | number | `1000` | Only compact partitions with more than this many records |
| `autoCompact` | boolean | `false` | Enable automatic background compaction |
| `squashGitHistory` | boolean | `true` | Rewrite git history during compaction |
| `compressionLevel` | number | `6` | Parquet compression level (1–9) |

### namespaceMappings

Maps namespace aliases to filesystem paths:

```json
{
  "namespaceMappings": {
    "work": "/home/user/duckbrain-ns/work",
    "personal": "/home/user/duckbrain-ns/personal"
  }
}
```

---

## Authentication Configuration

Authentication credentials can be stored in `~/.duckbrain/auth.json`:

```json
{
  "users": [
    {
      "username": "admin",
      "passwordHash": "$2a$10$..."
    }
  ],
  "apiKeys": [
    {
      "key": "sk-duckbrain-abc123",
      "name": "default"
    },
    {
      "key": "sk-duckbrain-scoped-456",
      "name": "agent-alpha",
      "namespaces": ["my-project"]
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `users` | For `basic` auth | Array of username/passwordHash objects (bcrypt hashes) |
| `apiKeys` | For `apikey` auth | Array of key/name objects |
| `apiKeys[].namespaces` | No | Per-token namespace grants (DB-GAP-031): when present, the token may only access these namespaces (403 otherwise); absent = unrestricted. Mint scoped tokens with `duckbrain token --namespace=<ns>[,<ns>...]` (repeatable). |
| `apiKeys[].roles` | No | Per-token role grants (SUPA-4): one or more of `admin`, `writer`, `analyst`, `uploader`; a multi-role token holds the union of its roles' grants and `admin` bypasses per-table grants. Absent = admin-equivalent (backward compatible). Mint with `duckbrain token --role=<role>` (repeatable; `--role=<r>` and `--role <r>` both accepted). |

### Alternate Auth Store Path (`--auth-file`, DB-GAP-043)

The HTTP server normally reads this file at `~/.duckbrain/auth.json`. A
scratch/test daemon can be pointed at a different auth store so it never
reads or writes the production one:

```bash
duckbrain http --auth=apikey --auth-file=/tmp/scratch-auth.json
# or, via environment (used only when the flag is absent):
DUCKBRAIN_AUTH_FILE=/tmp/scratch-auth.json duckbrain http --auth=apikey
```

Precedence: `--auth-file` flag > `DUCKBRAIN_AUTH_FILE` env > the default
`~/.duckbrain/auth.json`. With an override set, the default file is not
consulted at all; the override file must exist and parse or the server
refuses to start (exit non-zero). With no override, behavior is unchanged.
The override is runtime-only and is never written back into any file
(same philosophy as `DUCKBRAIN_CONFIG_PATH`). `duckbrain token` resolves the
same override when minting — `--auth-file` flag > `DUCKBRAIN_AUTH_FILE` env >
the default `~/.duckbrain/auth.json` (DOGFOOD-026). An explicit `--auth-file`
that is missing or unparseable is a fatal error, so a minted token is never
silently written to the production store; the env form is created on first
mint.

### Author Stamping

With `--auth=apikey` or `--auth=basic`, the HTTP API stamps the `author`
field of every memory write (create/update/delete) from the authenticated
principal (the token `name` / basic username — mapped to an email-shaped
identity: `<name>@duckbrain.local` when the name is not already an email)
and ignores any client-supplied `?author=` value — see
[HTTP API — Author Stamping](../api/http-api#author-stamping).
In `--auth=none` mode the git-config fallback is used.

---

## MCP Server Configuration

When using DuckBrain as an MCP server via stdio, configure your AI agent's MCP settings:

```json
{
  "mcpServers": {
    "duckbrain": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/duckbrain/bin/duckbrain.js",
        "stdio"
      ],
      "env": {
        "DUCKBRAIN_NAMESPACE": "my-project"
      }
    }
  }
}
```

For HTTP transport with Streamable HTTP, point your MCP client to:

```
POST http://localhost:3000/mcp
GET  http://localhost:3000/mcp
```

---

## Git Configuration

Each namespace is a standalone git repository. DuckBrain auto-commits after every write operation when using MCP tools, and batches commits via a background worker when using the CLI.

### Namespace Repository Structure

```
namespaces/
  ├── default/
  │   ├── .git/
  │   ├── manifest.json
  │   └── <domain>/
  │       └── <YYYY-MM>/
  │           └── current.jsonl
  └── my-project/
      ├── .git/
      ├── manifest.json
      └── <domain>/
          └── <YYYY-MM>/
              └── current.jsonl
```

### Git User Configuration

For proper attribution, ensure git is configured with a user email:

```bash
git config --global user.email "your-email@example.com"
git config --global user.name "Your Name"
```

DuckBrain uses the git author email for memory attribution. If not configured, it falls back to `duckbrain@localhost.localdomain`.
