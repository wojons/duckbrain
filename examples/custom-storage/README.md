# Custom Storage Example

This example demonstrates how to run DuckBrain with a custom configuration
file: where the config lives, which keys the schema actually accepts, and how
to verify a scratch daemon picks it up.

## The config file

DuckBrain reads its configuration from `duckbrain.config.json`. Without an
override this file lives in the duckbrain root (the directory that owns the
config file also owns the `namespacesPath` storage root — see GAP-062).
Set `DUCKBRAIN_CONFIG_PATH` to point the process at a different config file:

```bash
DUCKBRAIN_CONFIG_PATH=./examples/custom-storage/duckbrain.config.json \
  node bin/duckbrain.js config show
```

`config show` prints the fully-resolved configuration — file content merged
with schema defaults — so it is the quickest way to see what a custom config
actually changes.

## A valid custom config

Everything below is a real key from the zod schema in `src/config/index.ts`.
DuckBrain ignores unknown keys with a warning (the config still loads with
defaults), but a config full of unknown keys means nothing you tune takes
effect, so only real keys are shown:

```json
{
  "defaultNamespace": "personal",
  "authorEmail": "you@example.com",
  "storage": {
    "maxLinesPerChunk": 2000,
    "maxBytesPerChunk": 2097152
  },
  "durability": {
    "defaultMode": "fsync",
    "overrides": {
      "bulk-import": "buffered"
    }
  },
  "gitBatching": {
    "maxLines": 250,
    "maxSeconds": 60,
    "enabled": true
  },
  "squash": {
    "maxAgeDays": 14,
    "thresholdRecords": 5000,
    "autoCompact": true,
    "squashGitHistory": true,
    "compressionLevel": 6
  },
  "realtime": {
    "enabled": true,
    "pollIntervalMs": 1000,
    "heartbeatMs": 15000
  }
}
```

What the real schema offers at the top level:

| Block | Keys | Tuning use |
|-------|------|------------|
| `storage` | `maxLinesPerChunk`, `maxBytesPerChunk` | JSONL chunk file sizing |
| `durability` | `defaultMode` (`buffered`/`fsync`/`direct`), `overrides` | per-namespace write durability |
| `gitBatching` | `maxLines`, `maxSeconds`, `enabled` | CLI-worker git commit batching |
| `namespaces` | `autoCreate` | strict mode: refuse writes that would create a namespace |
| `serialization` | `maxPendingRows`, `maxPendingBytes` | fan-in queue bounds |
| `realtime` | `enabled`, `pollIntervalMs`, `heartbeatMs`, `maxSubscribers`, `maxQueueEvents`, `maxQueueBytes`, `maxReplayEvents`, `maxReplayCommits`, `retentionDays` | SSE change feed |
| `ddl` | `inferenceCompat.{shippedAt,graceDays,minMinorReleases,minorReleasesShipped}` | `read_json_auto` compatibility window |
| `squash` | `maxAgeDays`, `thresholdRecords`, `autoCompact`, `squashGitHistory`, `compressionLevel` | compaction |
| `namespaceMappings` | `{ alias: path }` | alias → absolute namespace path |
| `embedding` | `provider`, `model`, `baseUrl`, `apiKey`, `dimensions`, `cacheDir`, `concurrency` | embedding store |
| `s3` | `enabled`, `endpoint`, `region`, `bucket`, `prefix`, `profile`, `forcePathStyle`, `pushOnCommit`, `intervalSec` | native S3 sync |

Scalar top-level keys: `defaultNamespace`, `authorEmail`, `namespacesPath`.

Note: there is no `api` or `ui` block in the config schema — server settings
like the port, bind address, auth and rate limiting are **flags on the
`http` command**, not config-file keys.

## Environment variables

Runtime-only overrides (never persisted into the config file by writes):

```bash
DUCKBRAIN_CONFIG_PATH=./path/to/duckbrain.config.json  # redirect the config FILE
DUCKBRAIN_NAMESPACES_PATH=/abs/path/to/namespaces      # redirect namespace storage
DUCKBRAIN_NAMESPACE=personal                           # active namespace for this process
DUCKBRAIN_NAMESPACES_AUTOCREATE=false                  # strict mode: typo'd namespace fails
DUCKBRAIN_DURABILITY_MODE=fsync                        # override the default write mode
DUCKBRAIN_REALTIME_POLL_MS=250                         # SSE HEAD-observation interval
DUCKBRAIN_REALTIME_HEARTBEAT_MS=5000                   # SSE comment heartbeat
DUCKBRAIN_EMBEDDING_API_KEY=...                        # key for remote embedding providers
DUCKBRAIN_AUTH_FILE=/path/to/auth.json                 # auth store for the http daemon
```

An invalid `DUCKBRAIN_NAMESPACES_AUTOCREATE` or `DUCKBRAIN_DURABILITY_MODE`
value fails config load loudly instead of silently falling back.

## Running the server with this config

```bash
DUCKBRAIN_CONFIG_PATH=./examples/custom-storage/duckbrain.config.json \
  node bin/duckbrain.js http --port=39472
```

The daemon binds `127.0.0.1` by default, requires API keys by default
(`--auth=none` is an explicit opt-out; `/health` is always answerable), and
writes a PID file under `DUCKBRAIN_DATA_DIR` (or a per-UID dir in the system
temp directory). Stop it with Ctrl-C or by killing the PID from the PID file.

> Do not use the `--`-separator spelling (`pnpm start` + `--` + `http`) here:
> under the repo's pinned pnpm the `--` separator is forwarded to the CLI
> verbatim and DuckBrain exits with `Unknown command: --`. There is also no
> config-validation flag in any spelling — verify a config with
> `node bin/duckbrain.js config show` (shown above). A config
> file that fails to parse logs a warning and DuckBrain runs on schema
> defaults; an invalid `durability` block aborts startup instead, because a
> silent downgrade to `buffered` would break the durability contract.

Flag reference (`node bin/duckbrain.js http --help`): `--port`, `--bind-all`,
`--allowed-hosts`, `--auth`, `--auth-file`, `--rate-limit`, `--unix-socket`,
`--unix-socket-mode`, `--unix-socket-group`.

## Docker

The repo's `Dockerfile` copies the source and runs it via tsx; its entrypoint
is `/app/scripts/docker-entrypoint.sh` and the default command is
`http --port=3000 --bind-all`. The compose file serves the equivalent stack
(`docker compose up -d`):

```yaml
services:
  duckbrain:
    build: .
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - duckbrain-data:/data
    environment:
      - NODE_ENV=production
      - DUCKBRAIN_DATA_DIR=/data
    restart: unless-stopped
```

To ship a custom config file into the container, mount it and redirect the
config path:

```bash
docker run -d \
  -p 127.0.0.1:3000:3000 \
  -v /path/to/duckbrain.config.json:/app/duckbrain.config.json \
  -v duckbrain-data:/data \
  --name duckbrain \
  duckbrain:latest
```

## Data layout

Namespaces live under `namespacesPath` (default `./namespaces`), resolved
relative to the directory that owns the config file — not the process cwd.
Each namespace is a git repository of JSONL chunk files; chunk sizing is the
`storage` block above. Vectors are never stored in git: the embedding cache
lives in each namespace's `embedding.cacheDir` (default `.embeddings`,
gitignored).

## Performance tuning

### Chunk sizing

```json
{
  "storage": {
    "maxLinesPerChunk": 5000,
    "maxBytesPerChunk": 8388608
  }
}
```

### Compaction

```json
{
  "squash": {
    "maxAgeDays": 7,
    "thresholdRecords": 2000,
    "autoCompact": true,
    "compressionLevel": 9
  }
}
```

## Testing the config live

```bash
# 1. Inspect what the file resolves to (no server needed)
DUCKBRAIN_CONFIG_PATH=./examples/custom-storage/duckbrain.config.json \
  node bin/duckbrain.js config show

# 2. Boot a scratch daemon on a private port
DUCKBRAIN_CONFIG_PATH=./examples/custom-storage/duckbrain.config.json \
  node bin/duckbrain.js http --port=39472 &

# 3. Probe it (auth-exempt), then stop the exact process you started
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:39472/health
kill %1
```

## Troubleshooting

### Config looks ignored

`config show` prints the effective configuration. If a key you set is missing
from the output, it is not a schema key — check the table above. A config
file that fails JSON parsing or schema validation logs a `Warning:` line and
the process continues on defaults (except `durability`, which aborts).

### Port already in use

The daemon refuses to double-bind and no longer clobbers the running
instance's PID file. Pick another `--port`, or stop the old daemon first
(its PID file is `duckbrain-http-<port>.pid` under `DUCKBRAIN_DATA_DIR` or
the per-UID temp dir).

### Permission issues

```bash
# Fix data directory permissions
chown -R 1000:1000 /path/to/data
chmod 755 /path/to/data
```

### Git remote authentication

Namespaces are plain git repositories; configure credentials as you would
for any git remote:

```bash
git config --global credential.helper store
# Or use SSH key
export GIT_SSH_COMMAND='ssh -i /path/to/key'
```
