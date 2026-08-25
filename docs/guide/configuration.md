# Configuration Reference

DuckBrain can be configured through environment variables and a JSON configuration file. Environment variables take precedence over the config file.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DUCKBRAIN_HOME` | `~/.duckbrain` | Base directory for DuckBrain data, sockets, and configuration |
| `DUCKBRAIN_NAMESPACE` | `default` | Active namespace for operations |
| `DUCKBRAIN_NAMESPACES_PATH` | `./namespaces` | Directory containing namespace repositories |
| `DUCKBRAIN_DATA_DIR` | — | Override data directory (used for PID file location) |
| `DUCKBRAIN_API_PORT` | `3000` | HTTP API server port |
| `DUCKBRAIN_UI_PORT` | `8989` | Web UI server port |
| `DUCKBRAIN_HTTP_SOCKET` | — | Unix socket path for HTTP server (used by `service install` unit) |
| `DUCKBRAIN_HTTP_SOCKET_MODE` | — | Socket file permissions octal string (e.g. `0660`), used by `service install` unit |
| `DUCKBRAIN_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `AUTH_TYPE` | `none` | HTTP authentication type: `none`, `basic`, `apikey` |
| `AUTH_TOKEN` | — | Authentication token (API key or password depending on auth type) |
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
(same philosophy as `DUCKBRAIN_CONFIG_PATH`). `duckbrain token` minting is
unaffected — it always writes to `~/.duckbrain/auth.json`.

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
