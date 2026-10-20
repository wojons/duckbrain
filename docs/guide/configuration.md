# Configuration Reference

DuckBrain can be configured through environment variables and a JSON configuration file. Environment variables take precedence only for settings whose source code implements an override; all other settings are taken from the JSON file or their schema defaults.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DUCKBRAIN_HOME` | — | **Not implemented.** No code reads this variable (no non-test read in `src/`, `bin/`, `packages/` or `scripts/`); the DuckBrain home directory is derived from `DUCKBRAIN_CONFIG_PATH` / `DUCKBRAIN_HOME_ROOT` / the install layout (`resolveDuckbrainRoot`, `src/config/index.ts`) |
| `DUCKBRAIN_NAMESPACE` | `default` | Active namespace for operations — the per-process isolation knob an agent sets so one DuckBrain instance serves one namespace per agent. Runtime override of the config file's `defaultNamespace` (read at `src/config/index.ts` — `applyEnvOverrides`, DF-0926-04); a blank/whitespace value is treated as unset. Never persisted: `updateConfig` merges against the file config (GAP-007), so an env-pinned agent cannot rewrite a shared `duckbrain.config.json`. Precedence: explicit parameter (MCP arg / CLI `--namespace` / HTTP `?namespace=`) > this env var > config `defaultNamespace` > `"default"` |
| `DUCKBRAIN_NAMESPACES_AUTOCREATE` | `true` | Runtime-only override of `namespaces.autoCreate`. Accepts only the exact strings `true` or `false`; any other non-empty value fails config loading. It is never written to `duckbrain.config.json`. Set `false` to reject writes to a namespace that does not already exist; unset preserves the JSON value or the `true` schema default. |
| `DUCKBRAIN_HOME_ROOT` | — | Explicit install-root override for the DuckBrain home directory (read at `src/config/index.ts`). Set when the derived install root cannot be resolved (e.g. non-standard layouts) |
| `DUCKBRAIN_DURABILITY_MODE` | — | Runtime override of the namespace durability write mode (SUPA-1). A malformed value fails config load through the schema enum — never a silent fallback to buffered, because a silently-buffered namespace means acked writes are not durable. Never persisted into `duckbrain.config.json`. Precedence: `durability.overrides[ns]` > this env var > config default |
| `DUCKBRAIN_NAMESPACES_PATH` | `./namespaces` | Directory containing namespace repositories. Env-only, never persisted into `duckbrain.config.json` (BUG-037) |
| `DUCKBRAIN_DATA_DIR` | per-uid/pid dir | Base directory for HTTP server pidfiles and transient data (read at `src/utils/pidfile.ts`). When unset, falls back to a per-uid+pid directory under the system temp dir. Override to place pidfiles in a stable location (e.g. systemd `RuntimeDirectory`) |
| `DUCKBRAIN_API_PORT` | `3000` | HTTP API server port |
| `DUCKBRAIN_UI_PORT` | `8989` (dev tooling) | **Not implemented** as a DuckBrain runtime variable: nothing in `src/` or `bin/` reads it, so the shipped CLI and HTTP server ignore it. It is honored only by the Web UI *dev tooling* — the Vite dev server (`packages/ui/vite.config.ts`) and the `launch.sh` dev launcher export it as the Vite port. Set it only when running the UI dev server (`pnpm dev`), not to re-port a deployed server |
| `DUCKBRAIN_UI_DIST_DIR` | — | Explicit path to the built Web UI static assets directory (read at `src/cli/http.ts`). When unset, the server scans upward from its own location for `packages/ui/dist`. Set when the UI build output lives in a non-standard location (e.g. packaged deployments) |
| `DUCKBRAIN_HTTP_SOCKET` | — | Unix socket path for HTTP server (used by `service install` unit) |
| `DUCKBRAIN_HTTP_SOCKET_MODE` | — | Socket file permissions octal string (e.g. `0660`), used by `service install` unit |
| `DUCKBRAIN_LOG_LEVEL` | — | **Not implemented.** No code reads this variable — no non-test read in `src/`, `bin/`, `packages/` or `scripts/`, and it is never consulted for logger configuration. Setting it has no effect; log verbosity follows the logger's own defaults. (`.env.example` still advertises `DUCKBRAIN_LOG_LEVEL=info` — ignore it.) |
| `DUCKBRAIN_SEARCH_MIN_SCORE` | — | Operator knob for the semantic recall relevance floor (0..1). Absent or invalid → the search default (0.25) applies. Read by `src/mcp/tools/recall.ts` |
| `DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS` | `5000` | Row bound for the read-path keyword-search auto-build: a namespace with more source rows is refused inline indexing (the read keeps its pre-change behavior) instead of blocking on a multi-minute rebuild. A value of 0 refuses every auto-build. Read by `src/search/index.ts` |
| `DUCKBRAIN_WARM_NAMESPACES` | enabled | Startup namespace warm-up (AUG-096): after `listen()`, the daemon warms every manifest namespace's DuckDB singleton connection, first partition scan, FTS search sidecar (`ensureFreshIndex`) and embedding-cache directory in the background. `0` / `false` disables the whole pass. Read by `src/http/namespace-warmup.ts` |
| `DUCKBRAIN_WARM_BUDGET_MS` | `300000` | Overall wall-clock budget for the startup warm-up pass: namespaces dequeued after the deadline are reported as skipped (budget exhausted), never silently dropped; a namespace already in flight is allowed to finish. Malformed/non-positive values fall back to the default. Read by `src/http/namespace-warmup.ts` |
| `DUCKBRAIN_WARM_PER_NAMESPACE_TIMEOUT_MS` | `30000` | Per-namespace wait bound during startup warm-up: stops WAITING after the bound (the native DuckDB work itself is not cancellable and finishes in the background, leaving a valid connection), logs the skip, and does not evict. Read by `src/http/namespace-warmup.ts` |
| `DUCKBRAIN_WARM_CONCURRENCY` | `4` | Width of the startup warm-up worker pool: how many namespaces warm concurrently. Higher values trade boot I/O pressure for a shorter total warm-up window. Read by `src/http/namespace-warmup.ts` |
| `DUCKBRAIN_ALLOWED_HOSTS` | — | Comma-separated extra Host-header values the DNS-rebinding guard accepts on top of `localhost`/`127.0.0.1`. Empty/absent keeps the loopback-only default. Overridden by an explicit `--allowed-hosts` flag (see [Deployment Guide](deployment)) |
| `DUCKBRAIN_REALTIME_POLL_MS` | `1000` | Runtime override of the realtime change feed's per-namespace HEAD-observation poll interval (`realtime.pollIntervalMs`) in milliseconds — how often the SSE stream (`GET /api/ns/:ns/changes`) checks for new commits, which bounds change-delivery latency. Must be a positive integer; a malformed or non-positive value fails config load rather than silently falling back. Runtime-only, never persisted into `duckbrain.config.json` |
| `DUCKBRAIN_REALTIME_HEARTBEAT_MS` | `15000` | Runtime override of the realtime change feed's heartbeat interval (`realtime.heartbeatMs`) in milliseconds — the `:heartbeat` keep-alive comment frame sent on an idle SSE stream. Same validation and runtime-only rules as `DUCKBRAIN_REALTIME_POLL_MS` |
| `DUCKBRAIN_SKIP_SEARCH_REBUILD` | — | When set (to any non-empty value), the `post-checkout` / `post-merge` / `post-rewrite` git hooks installed by `duckbrain search-index install-hooks` exit without rebuilding the keyword search index. The detached `search-index rebuild` re-spawn sets this to `1` itself so nested git operations cannot re-trigger the hooks (mirror of `DUCKBRAIN_SKIP_EMBED_REBUILD`) |
| `DUCKBRAIN_KEYS_CACHE` | `enabled` | Key-list materialization cache for `list_keys` (the per-namespace `.keys/` sidecar). Set to `off` to disable the cache so every call runs the full cold SQL aggregation; any other value — including unset — leaves the cache enabled |
| `AUTH_TYPE` | — | **Not implemented.** No code reads this variable. HTTP auth is configured via the auth file (`~/.duckbrain/auth.json`, overridable with `--auth-file` / `DUCKBRAIN_AUTH_FILE` — see [Deployment Guide](deployment)) |
| `AUTH_TOKEN` | — | **Not implemented.** No code reads this variable; see `DUCKBRAIN_AUTH_FILE` above |
| `DUCKBRAIN_AUTH_FILE` | — | Path to the auth file (users/apiKeys) read by the HTTP server. Precedence: explicit `--auth-file` > this env var > `~/.duckbrain/auth.json` |
| `DUCKBRAIN_S3_ACCESS_KEY_ID` | — | S3 access key ID for direct S3 storage credentials (read at `src/s3/query.ts`). Precedence: `AWS_ACCESS_KEY_ID` > this variable. Use when S3 credentials differ from the AWS CLI/SDK default chain and `AWS_ACCESS_KEY_ID` is not already set |
| `DUCKBRAIN_S3_SECRET_ACCESS_KEY` | — | S3 secret access key paired with `DUCKBRAIN_S3_ACCESS_KEY_ID` (read at `src/s3/query.ts`). Precedence: `AWS_SECRET_ACCESS_KEY` > this variable |
| `S3_SYNC_NAMESPACE_DEADLINE_S` | `300` | Per-namespace wall-clock deadline in seconds for the native S3 sync (S3-GIT-007, read at `src/s3/sync.ts` — `namespaceDeadlineSeconds`): a namespace push/pull that never settles is aborted after the deadline — the in-flight SDK calls are cancelled via an abort signal before the namespace lock is released — with the warning `[S3] sync <ns> timed out after <N>s (S3-GIT-007)`; the sync-all pass then continues with the remaining namespaces and exits nonzero for the failed one(s). Only finite positive numbers are accepted: unset, `0`, negative, or non-numeric values fall back to the 300s default |
| `S3_SYNC_ALL_DEADLINE_S` | `3600` | Whole-run timeout in seconds applied by the deployment wrapper `scripts/s3/duckbrain-s3-native-sync.sh` around its single `s3 sync all push` call (S3-GIT-007): on expiry GNU `timeout` kills the node process (`rc=124`), the wrapper logs `FAIL sync-all-deadline rc=124` and exits `1`, so the S3 alert gate counts the run as failed. Passed straight to `timeout`, so it does not get the numeric fallback above: a negative or non-numeric value makes `timeout` exit `125` immediately (the run fails loudly), and `0` disables the deadline entirely. Wrapper-only — the daemon's in-process sync has no all-pass deadline. See [scripts/s3/README.md](../../scripts/s3/README.md) |
| `DUCKBRAIN_GIT_AUTHOR_NAME` | — | Last-resort override for the git author name stamped on namespace commits (read at `src/git/identity.ts`). Precedence: repo-local git config `user.name` > global git config `user.name` > this env var > **null (throws setup error)**. Production deployments should configure git identity via `git config` rather than relying on env vars. Test setup seeds `"DuckBrain Test"` via this env var |
| `DUCKBRAIN_GIT_AUTHOR_EMAIL` | — | Last-resort override for the git author email stamped on namespace commits (read at `src/git/identity.ts`). Precedence: repo-local git config `user.email` > global git config `user.email` > this env var > **null (throws setup error)**. Production deployments should configure git identity via `git config` rather than relying on env vars. Test setup seeds `"duckbrain-test@example.com"` via this env var |
| `NODE_ENV` | — | Set to `production` for production deployments |

---

## Configuration File

DuckBrain reads configuration from `duckbrain.config.json` in the current directory. If the file does not exist, defaults are used.

```json
{
  "defaultNamespace": "default",
  "authorEmail": "you@example.com",
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
  "namespaces": {
    "autoCreate": true
  },
  "serialization": {
    "maxPendingRows": 10000,
    "maxPendingBytes": 33554432
  },
  "realtime": {
    "enabled": true,
    "pollIntervalMs": 1000,
    "heartbeatMs": 15000,
    "maxSubscribers": 100,
    "maxQueueEvents": 256,
    "maxQueueBytes": 1048576,
    "maxReplayEvents": 10000,
    "maxReplayCommits": 10000,
    "retentionDays": 7
  },
  "ddl": {
    "inferenceCompat": {
      "shippedAt": "2026-09-17T00:00:00.000Z",
      "graceDays": 90,
      "minMinorReleases": 2,
      "minorReleasesShipped": 0
    }
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
| `authorEmail` | string | — (optional) | Optional author email. **Not consulted at runtime** — memory attribution resolves through the git identity chain (see [Git User Configuration](#git-user-configuration)) |
| `namespacesPath` | string | `"./namespaces"` | Path to the directory containing namespace subdirectories |
| `gitBatching` | object | (see below) | Git commit batching settings |
| `storage` | object | (see below) | Storage chunk settings |
| `namespaces` | object | `{ "autoCreate": true }` | Namespace-creation policy for writes |
| `serialization` | object | (see below) | Per-namespace pending-write queue bounds |
| `realtime` | object | (see below) | Committed change-feed (SSE) settings |
| `ddl` | object | (see below) | Bounded declaration-inference compatibility settings |
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

### namespaces Settings

`namespaces.autoCreate` controls only **writes** to a namespace that does not
yet exist. Reads (`recall`, search, and `list_keys`) never create namespaces.
Omitting this block applies the schema default shown below.

| Field | Type | Default | Validation | Configuration and runtime behavior |
|-------|------|---------|------------|------------------------------------|
| `autoCreate` | boolean | `true` | Must be a boolean | Applied from `duckbrain.config.json` and persisted there when configuration is written. With `true`, a write to a missing namespace creates its directory and initializes its repository; the write reports/logs that auto-creation occurred. With `false`, the same write is rejected as `NAMESPACE_NOT_FOUND` and creates nothing. `DUCKBRAIN_NAMESPACES_AUTOCREATE` is the only override: it is runtime-only, accepts only `true` or `false`, and is never persisted. |

Use strict mode when a misspelled namespace must fail rather than create an
unexpected repository:

```json
{
  "namespaces": {
    "autoCreate": false
  }
}
```

### serialization Settings

These bounds apply to each namespace's pending data-write queue. Both fields
are read from `duckbrain.config.json` (and persisted there when configuration
is written); there is no environment-variable override for this block. Omit the
block to use both schema defaults.

| Field | Type | Default | Validation | Configuration and runtime behavior |
|-------|------|---------|------------|------------------------------------|
| `maxPendingRows` | integer | `10000` | Positive integer | Config-file setting, not runtime-only. Limits queued data rows for one namespace. When the bound is reached, a new write is rejected with `SERIALIZER_QUEUE_FULL` and `Retry-After: 1`; it is neither written nor silently dropped. |
| `maxPendingBytes` | integer | `33554432` (32 MiB) | Positive integer | Config-file setting, not runtime-only. Limits queued serialized data bytes for one namespace. Crossing this bound has the same `SERIALIZER_QUEUE_FULL` behavior and leaves the queue intact. |

See the [serialization contract](../specs/SUPA-2-serialization) for the
single-writer, ordering, audit, and overflow rules.

### realtime Settings

This block configures the committed, resumable SSE feed at
`GET /api/ns/:ns/changes`. All fields are applied from
`duckbrain.config.json` and persisted there when configuration is written.
Omitting the block uses the schema defaults. Only the two timing fields have
environment overrides; no other realtime field has one.

| Field | Type | Default | Validation | Configuration and runtime behavior |
|-------|------|---------|------------|------------------------------------|
| `enabled` | boolean | `true` | Must be a boolean | Config-file setting, not runtime-only. Enables the realtime route; when `false`, the feed is unavailable. No environment override. |
| `pollIntervalMs` | integer | `1000` | Positive integer | Config-file setting. Maximum interval between HEAD observations for a subscribed namespace, which bounds how long a new committed change can go unnoticed. `DUCKBRAIN_REALTIME_POLL_MS` can replace it for the current process only; the override must be a positive integer number of milliseconds and is never persisted. |
| `heartbeatMs` | integer | `15000` | Positive integer | Config-file setting. Interval for idle `: heartbeat` SSE comments while a subscriber is keeping up. `DUCKBRAIN_REALTIME_HEARTBEAT_MS` can replace it for the current process only; the override must be a positive integer number of milliseconds and is never persisted. |
| `maxSubscribers` | integer | `100` | Positive integer | Config-file setting, not runtime-only. Maximum concurrent subscribers per process; a new subscription over the cap receives `503 SUBSCRIBER_LIMIT`. No environment override. |
| `maxQueueEvents` | integer | `256` | Positive integer | Config-file setting, not runtime-only. Per-subscriber queued-event bound. A slow subscriber over this bound receives `duckbrain.overflow.v1` and is disconnected; healthy subscribers continue. No environment override. |
| `maxQueueBytes` | integer | `1048576` (1 MiB) | Positive integer | Config-file setting, not runtime-only. Per-subscriber queued-payload-byte bound, with the same isolated overflow event and disconnect behavior as `maxQueueEvents`. No environment override. |
| `maxReplayEvents` | integer | `10000` | Positive integer | Config-file setting, not runtime-only. Maximum committed events replayed for one resume cursor. A cursor outside the replayable window requires a full resync (`410 CHANGE_CURSOR_GONE`). No environment override. |
| `maxReplayCommits` | integer | `10000` | Positive integer | Config-file setting, not runtime-only. Maximum first-parent commits retained for cursor resolution. A cursor whose required commit is no longer retained requires a full resync (`410 CHANGE_CURSOR_GONE`). No environment override. |
| `retentionDays` | number | `7` | Positive number | Config-file setting, not runtime-only. Maximum age in days for a cursor's commit. This is a positive number rather than an integer-only field. A cursor outside the retention window requires a full resync (`410 CHANGE_CURSOR_GONE`). No environment override. |

The feed publishes only changes whose namespace git commit has completed; it
does not expose pending writes. Clients must persist opaque cursors and tolerate
at-least-once delivery. For subscription grammar, replay/resync procedure,
overflow handling, and API errors, see the [Realtime Change Feed API
reference](../api/http-api#realtime-change-feed-supa-5) and the [SUPA-5
realtime specification](../specs/SUPA-5-realtime).

### ddl.inferenceCompat Settings

`ddl.inferenceCompat` is a temporary migration policy for schema inference. It
does not enable generic per-query inference: generic declared-table reads and
writes use declared types and headers. While the compatibility window is open,
only create-time inference through DDL `inferFrom` remains available. All
fields are applied from `duckbrain.config.json` and persisted there when
configuration is written; there are no environment-variable overrides. Omit
this block to use the schema defaults.

| Field | Type | Default | Validation | Configuration and runtime behavior |
|-------|------|---------|------------|------------------------------------|
| `shippedAt` | string | `"2026-09-17T00:00:00.000Z"` | Schema accepts a string; runtime requires it to parse as a valid instant | Config-file setting, not runtime-only. Starts the compatibility clock. An unparseable value causes a runtime `CONFIG_INVALID` error when the inference window is resolved. No environment override. |
| `graceDays` | number | `90` | Positive number | Config-file setting, not runtime-only. The time condition for closing the window is met only after this many days from `shippedAt`. No environment override. |
| `minMinorReleases` | integer | `2` | Positive integer | Config-file setting, not runtime-only. The release-count condition for closing the window is met only after this many minor releases have shipped. No environment override. |
| `minorReleasesShipped` | integer | `0` | Integer greater than or equal to `0` | Config-file setting, not runtime-only. Records progress toward the release-count condition. No environment override. |

The window closes only when **both** conditions are true: the configured number
of minor releases has shipped and the grace period has ended (two releases or
90 days by default, whichever is later). Once it closes, generic inference is
rejected with `409 SCHEMA_DECLARATION_REQUIRED`; it does not silently extend.
While open, compatibility accesses are counted and warned once per
namespace/file per process so operators can find undeclared data before the
deadline. See [Declared Tables](../api/http-api#declared-tables-supa-3supa-6)
and the [SUPA-6 declared DDL specification](../specs/SUPA-6-ddl).

For the existing configurable custom behavior surface, see [Custom MCP Tools](../api/custom-tools).

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

DuckBrain uses the git author email for memory attribution. Resolution
order: repo-local git config > global git config > `DUCKBRAIN_GIT_AUTHOR_EMAIL`
(see the environment table above). If nothing resolves, DuckBrain refuses to
invent an identity and fails with an actionable setup error (GIT-IDENTITY-001)
— it never writes a synthetic author.
