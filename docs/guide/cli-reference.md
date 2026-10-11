# DuckBrain CLI Reference

Complete command-line reference for DuckBrain. Run `duckbrain --help` (or
`node bin/duckbrain.js --help` from the repo) to see the top-level list live;
most verbs also accept `--help` for their own flags.

Conventions used below: `<angle>` = required value, `[square]` = optional,
`<a|b>` = pick one. Flag style is `--flag=value` (space-separated values also
work for most flags).

## Top-level commands

| Command | Description |
|---------|-------------|
| `duckbrain stdio` | Start MCP server (stdio transport for Claude/Cursor) |
| `duckbrain http` | Start HTTP API server |
| `duckbrain service` | Manage systemd service (`install` / `start` / `stop` / `restart` / `status`) |
| `duckbrain remember <key>` | Store a memory (body via `--content=`, `--text=`, or stdin) |
| `duckbrain recall` | Query memories (prefix, exact key, semantic, attribute, time-window) |
| `duckbrain search <query>` | Keyword full-text search (offline; index refreshes automatically) |
| `duckbrain search-index` | Manage the keyword search index (`rebuild` / `status` / `install-hooks`) |
| `duckbrain list-keys` | Browse memory structure (renders a plain-text tree) |
| `duckbrain forget <id>` | Delete a memory by UUID |
| `duckbrain consolidate` | Daily cross-namespace consolidation digest |
| `duckbrain query` | Read-only SQL over a namespace (`SELECT ...` or `--template`) |
| `duckbrain squash` | Compact old JSONL partitions (options: `--stats` / `--dry-run` / `--partition` / `--aggressive` / `--segments`) |
| `duckbrain embeddings` | Manage embedding cache (`rebuild` / `status` / `install-hooks` / `providers` / `migrate`) |
| `duckbrain config` | Show or set configuration (`show` / `set` / `get`) |
| `duckbrain namespace` (alias `namespaces`) | Manage namespaces (`create` / `list` / `delete-disk` / `clear-s3` / `use` / `set-remote`) |
| `duckbrain pull` | Pull changes from a namespace's remote |
| `duckbrain push` | Push changes to a namespace's remote |
| `duckbrain remote` | Configure a namespace's git remote (`add` / `remove`) |
| `duckbrain status` | Show system status |
| `duckbrain token` | Generate an API token for HTTP authentication |
| `duckbrain ssh-test` | Test SSH tunnel setup |
| `duckbrain ssh-connect` | Connect to remote DuckBrain via SSH tunnel |
| `duckbrain servers` | Manage server connections (`list` / `add` / `remove`) |
| `duckbrain s3` | Native S3 sync/query (`status` / `sync` / `query` / `config` / `clear` / `ghosts`) |
| `duckbrain git` | Git identity tools (`repair-identity` / `bare`) |
| `duckbrain tables` | Declare tables for the table→REST layer (`declare`) |
| `duckbrain help` | Show top-level help |

## Global options

| Option | Description |
|--------|-------------|
| `--namespace=NAME` | Select namespace (default: config `defaultNamespace`) |
| `--socket=NAME` | Use remote connection via Unix socket |
| `--version`, `-v` | Print the CLI version and exit |
| `--help`, `-h` | Show help for the command (top-level help when bare) |

Namespace resolution order: explicit `--namespace` / parameter >
`DUCKBRAIN_NAMESPACE` env var > config `defaultNamespace` > `"default"`.

## HTTP server options

These apply to `duckbrain http`:

| Option | Description |
|--------|-------------|
| `--port=PORT` | HTTP server port (default: 3000; env `DUCKBRAIN_API_PORT`) |
| `--bind-all` | Bind to all interfaces (0.0.0.0) instead of localhost |
| `--auth=TYPE` | `none`, `basic`, or `apikey` (default: `apikey`; use `none` only for explicit local mode) |
| `--auth-file=PATH` | Read auth users/apiKeys from PATH instead of `~/.duckbrain/auth.json` (env: `DUCKBRAIN_AUTH_FILE`); the file must exist — for scratch/test daemons |
| `--rate-limit=N` | Requests per minute per IP (default: 100) |
| `--unix-socket=PATH` | Also listen on a Unix domain socket at PATH |
| `--unix-socket-mode=OCTAL` | Socket file permissions (default: 0660) |
| `--unix-socket-group=NAME` | Chown socket to group NAME or numeric GID |

## Service commands

```bash
duckbrain service install [--system]  # Install as systemd service (--system = system-wide)
duckbrain service start               # Start the service
duckbrain service stop                # Stop the service
duckbrain service restart             # Restart the service
duckbrain service status              # Show service status
```

**Safety:** `install`/`start`/`stop`/`restart` change host services. Use
`--system` deliberately — the default installs a user-level unit. See
[Deployment](deployment) for the production setup.

## Memory verbs

### `duckbrain remember`

```
duckbrain remember <key> --domain=<domain> [--content=<text> | --text=<text>]
                    [--attr=<json>] [--namespace=<name>]
                    [--embedding-text=<text>] [--valid-from=<iso>] [--valid-until=<iso>] [--wait]
```

Stores one memory at a filesystem-style key (e.g. `/projects/myapp/schema`).
`--domain` is mandatory and one of `person|event|concept|message|config|raw_note`
(closed enum). The body comes from `--content=`, `--text=`, or stdin.
`--valid-from`/`--valid-until` bound the fact's validity window (ISO-8601);
`--wait` waits for durability instead of returning after the append.

**Safety:** additive — creates one record; nothing is overwritten or deleted.
Requires no auth locally; remote calls need a token with write access.

```bash
duckbrain remember /contacts/alice --domain=person --attr='{"name":"Alice"}' --content='Met at conference'
echo "project notes body" | duckbrain remember /notes/alpha --domain=raw_note
```

### `duckbrain recall`

```
duckbrain recall [--key=<key>] [--prefix=<prefix>] [--domain=<domain>] [--query=<text>]
                 [--contains=<text>] [--after=<iso>] [--before=<iso>] [--between=<a,b>]
                 [--as-of=<ref>] [--attr=<name>=<value>] [--historical] [--limit=<n>] [--namespace=<name>]
```

The read verb. Defaults to a prefix search over the whole store. Highlights:
`--query=` runs semantic search (needs an embedding provider), `--contains=`
is offline keyword filtering, `--attr=` filters on attribute equality
(repeatable), `--after/--before/--between` window by timestamp, and `--as-of`
reads the namespace state as of a git ref or ISO-8601 date (time travel).
`--historical` includes rows outside their validity window instead of the
current filtered view.

**Safety:** read-only.

```bash
duckbrain recall --prefix=/projects/
duckbrain recall --query="what database are we using?"
duckbrain recall --attr=domain=config --between=2026-09-01,2026-09-30
```

### `duckbrain search`

```
duckbrain search <query> [--namespace=<name>] [--all-namespaces] [--limit=<n>]
```

Keyword full-text search over content, keys, and attributes. The keyword
index refreshes automatically on a read; `search-index rebuild` forces one.
`--all-namespaces` unions hits over every namespace with a rebuilt index and
labels each hit with its source namespace.

**Safety:** read-only.

```bash
duckbrain search "GAP-020"
duckbrain search "GAP-02*" --namespace=default --limit=20
duckbrain search "S3" --all-namespaces --limit=20
```

### `duckbrain search-index`

```
duckbrain search-index rebuild          # Force a full index rebuild
duckbrain search-index status           # Show index state
duckbrain search-index install-hooks    # Install hooks that refresh the index on write
```

Manages the offline keyword index backing `search` and `recall --contains=`.
`--help` is not recognized on this verb; pass a bare action.

**Safety:** `rebuild` is idempotent and reads everything (can be slow on big
namespaces); `install-hooks` only adds hook files.

```bash
duckbrain search-index status
```

### `duckbrain list-keys`

```
duckbrain list-keys [--prefix=<prefix>] [--depth=<n>] [--limit=<n>] [--offset=<n>] [--namespace=<name>]
```

Renders the memory structure as a plain-text tree — the quickest way to see
what lives under a prefix (defaults: prefix `/`, depth 3, limit 50).

**Safety:** read-only.

```bash
duckbrain list-keys --depth=3 --limit=20
duckbrain list-keys --namespace=coding-hermes --prefix=/project/
```

### `duckbrain forget`

```
duckbrain forget <id> [--namespace=<name>] [--reason=<reason>]
```

Deletes one memory by its UUID. The deletion is recorded (tombstone), so the
removal itself is part of the git history; `query`/`recall` stop returning
the row.

**Safety:** destructive for the targeted record only — the `--reason` lands
in the audit trail. Idempotent-safe: deleting an unknown id is an error, not
a silent success.

```bash
duckbrain forget abc-123 --reason="obsolete"
```

### `duckbrain consolidate`

```
duckbrain consolidate [--date=YYYY-MM-DD] [--write-digest] [--digest-content=FILE]
```

Scans the target UTC day's JSONL deltas across every namespace, dedupes by
content hash, and prints per-namespace row counts, dedup stats, and capped
previews plus a digest block. `--write-digest` POSTs the digest to the HTTP
API under `/project/duckbrain/digest/<date>` (requires `DUCKBRAIN_API_KEY`;
setting that env var in the environment also triggers the write).
`--digest-content=FILE` substitutes your own summarized text.

**Safety:** read-only unless `--write-digest` (or `DUCKBRAIN_API_KEY` in the
environment) is in play; then it writes one digest record.

```bash
duckbrain consolidate --date=2026-10-10
duckbrain consolidate --write-digest
```

### `duckbrain query`

```
duckbrain query "SELECT ..." [--namespace=<name>] [--limit=<n>]
duckbrain query --template=<name> [--namespace=<name>]
```

Read-only SQL against a `memories` view (latest record per id, tombstones
excluded, validity-filtered). Mutating statements are rejected and results
are capped at 1000 rows. Saved templates: `incidents-by-day`,
`per-project-status`, `cost-series`.

**Safety:** read-only by construction (mutations rejected server-side of the
parser); results auto-capped.

```bash
duckbrain query "SELECT key, timestamp FROM memories WHERE key LIKE '/projects/%'"
duckbrain query "SELECT count(*) AS n FROM memories" --namespace=hermes-telemetry
duckbrain query --template cost-series
```

### `duckbrain squash`

```
duckbrain squash [--stats] [--dry-run] [--partition <id>] [--aggressive] [--segments]
```

Compacts memory partitions by converting old JSONL files to Parquet and
removing tombstoned records; compacted partitions also get their git history
squashed. `--aggressive` lowers the compaction thresholds. `--segments`
(DB-GAP-051) merges near-empty JSONL segments and splits oversize ones while
keeping the partition readable as JSONL — it requires `--partition`.

**Safety:** rewrites storage (Parquet conversion + git history squash) — run
`--dry-run` first. Records are preserved (tombstoned rows are dropped by
design); history before the squash is preserved by git itself.

```bash
duckbrain squash --stats
duckbrain squash --dry-run
duckbrain squash --partition 2026-09 --segments
```

### `duckbrain embeddings`

```
duckbrain embeddings status           # Cache stats, provider, health
duckbrain embeddings rebuild          # Re-embed all memories (expensive)
duckbrain embeddings install-hooks    # Install git hooks that rebuild on commit
duckbrain embeddings providers        # List embedding providers and health
duckbrain embeddings migrate          # Migrate between embedding dimensions/providers
```

Manages the embedding cache behind `recall --query=`. `rebuild` re-embeds
everything — run it after changing provider or model. `migrate` moves stored
embeddings to a new provider/dimension setup. `--help` is not recognized;
pass a bare action.

**Safety:** `rebuild`/`migrate` are expensive writes; everything else is
read-only or additive (hooks).

```bash
duckbrain embeddings providers
```

## Namespaces

### `duckbrain namespace`

```
duckbrain namespace create <name>              # Create a namespace (git-inits it)
duckbrain namespace list                       # List configured namespaces
duckbrain namespace use <name>                 # Set defaultNamespace in the config file
duckbrain namespace set-remote <name> <url>    # Attach a git remote to a namespace
duckbrain namespace delete-disk <name> --force [--requested-by=<who>] [--reason=<why>]
duckbrain namespace clear-s3 <name> --dry-run | --yes --requested-by=<who> --reason=<why>
```

`use` persists `defaultNamespace` into `duckbrain.config.json` (it is not a
shell-session variable; use `--namespace=` or `DUCKBRAIN_NAMESPACE` for a
per-call override). `set-remote` and `remote add` manage the same origin.

**Safety:** `create`/`use`/`set-remote` are additive and idempotent.
`delete-disk` removes the LOCAL copy and stops pushes — it requires
`--force`, and the S3 copy stays retrievable (`namespace delete <name>
--force --purge` is a legacy alias for the same op). `clear-s3` is the
reverse: it DESTROYS the remote S3 objects and refuses to touch local disk.
`clear-s3` is dry-run by default; executing requires `--yes` plus
`--requested-by` and `--reason` (who/why audit). To fully remove a namespace,
run `delete-disk` then `clear-s3` — deliberately two separate, individually
confirmed operations.

```bash
duckbrain namespace create my-project
duckbrain namespace use my-project
duckbrain namespace delete-disk old-ns --force --requested-by=bane --reason="retired"
duckbrain namespace clear-s3 old-ns --dry-run   # then repeat with --yes ...
```

### `duckbrain remote`

```
duckbrain remote add <namespace> <url>     # Set the remote as 'origin' for that namespace
duckbrain remote remove <namespace>        # Delete the 'origin' remote
```

Configures the git remote a namespace pushes/pulls to. Works with any git
remote — a bare repo, another host's clone, or an S3-compatible remote via
`git-remote-s3` (see the [Native S3 Storage Tier](../s3-native.md)).

**Safety:** `add` overwrites an existing `origin`; `remove` detaches without
deleting anything at the far end.

```bash
duckbrain remote add my-project git@github.com:you/my-project-memory.git
```

### `duckbrain pull` / `duckbrain push`

```
duckbrain pull [namespace]     # git pull --no-commit in the namespace's repo
duckbrain push [namespace]     # git push in the namespace's repo
```

Both default to the `default` namespace. `pull` uses `--no-commit` so merge
results are left uncommitted for you to inspect. `push` publishes whatever
the auto-commit machinery has already committed — it does not commit pending
appends by itself.

**Safety:** network + remote-write side effects; `pull` can create a merge
state locally (uncommitted). Not destructive.

```bash
duckbrain pull my-project
duckbrain push my-project
```

See [Getting Started → Multi-host git sync CLI](getting-started) for the full
sync walkthrough.

## S3

### `duckbrain s3`

```
duckbrain s3 status [ns]          — effective config + per-ns sync state
duckbrain s3 sync [ns|all] [push|pull]
duckbrain s3 query "SELECT ..."   — SQL over s3:// via DuckDB httpfs
duckbrain s3 config               — print effective config (no secrets)
duckbrain s3 clear <ns> --dry-run | --yes --requested-by=<who> --reason=<why>
duckbrain s3 ghosts [--sweep --yes --requested-by=<who>]
```

#### `s3 status`

Prints the effective S3 configuration and per-namespace sync state.

**Safety:** read-only.

```bash
duckbrain s3 status
duckbrain s3 status my-project
```

#### `s3 sync`

Pushes or pulls one namespace, or all of them (`sync all push`). Without a
direction argument it uses the configured default.

**Safety:** network + object-store writes; idempotent per run (a second push
of unchanged state is a no-op).

```bash
duckbrain s3 sync all push
duckbrain s3 sync my-project pull
```

#### `s3 query`

Runs read-only SQL over `s3://` paths through DuckDB's httpfs extension —
query the remote store without pulling it.

**Safety:** read-only.

```bash
duckbrain s3 query "SELECT key, domain FROM 's3://duckbrain/my-project/**/*.jsonl' LIMIT 10"
```

#### `s3 config`

Prints the effective config with secrets redacted.

**Safety:** read-only; safe to paste in tickets.

```bash
duckbrain s3 config
```

#### `s3 clear`

```
duckbrain s3 clear <ns> --dry-run | --yes --requested-by=<who> --reason=<why>
```

DESTROYS the namespace's remote S3 objects. The local disk copy is untouched,
and this is a separate operation from `namespace delete-disk` on purpose.
Dry-run is the default; executing requires `--yes` plus `--requested-by` and
`--reason`.

**Safety:** destructive (remote objects), guarded, audited.

```bash
duckbrain s3 clear old-ns --dry-run
duckbrain s3 clear old-ns --yes --requested-by=bane --reason="retired namespace"
```

#### `s3 ghosts`

Lists sync manifests that outlive their namespace directory (the state that
causes ghost pushes). Without flags it only lists; `--sweep --yes
--requested-by=<who>` prunes the ghost manifests.

**Safety:** listing is read-only; sweeping deletes sync-state files only —
S3 objects and local disk are untouched.

```bash
duckbrain s3 ghosts
duckbrain s3 ghosts --sweep --yes --requested-by=bane
```

## `duckbrain git`

```
duckbrain git repair-identity   # Remove synthetic local user.name/user.email pins
duckbrain git bare              # Identity health check
```

`repair-identity` scans the namespaces root (`DUCKBRAIN_NAMESPACES_PATH`,
default `./namespaces`) and removes ONLY synthetic local git identity pins
from namespace repos, so the global identity applies. It is idempotent — a
rerun reports "No synthetic git identity pins found". `bare` (the default
when no subcommand is given) is a doctor-style health report: it prints the
global identity and flags any namespace repos that still carry local pins,
exiting non-zero when unhealthy. Note: `duckbrain git --help` is not
recognized — it runs the same health check.

**Safety:** `repair-identity` rewrites git config files in namespace repos
(never commit content); `bare` is read-only.

```bash
duckbrain git bare
duckbrain git repair-identity
```

## `duckbrain config`

```
duckbrain config show                # Print the full effective config as JSON
duckbrain config get <key>           # Read a single key (e.g. defaultNamespace)
duckbrain config set <key> <value>   # Write a single key
```

Reads/writes `duckbrain.config.json` in the repo root. Dotted keys reach
nested settings — `git.batchLines`, `git.batchIntervalMs`,
`git.batchIntervalSeconds`, and `git.batching.enabled` are special-cased into
the nested `gitBatching` block; any other key is written verbatim (there is
no key allowlist, so a typo creates a dead key — check `config show`
afterwards). The `namespacesPath` key is honored at runtime, but env
`DUCKBRAIN_NAMESPACES_PATH` overrides it without persisting (GAP-007
precedent). See [Configuration](configuration) for the full key list.

**Safety:** `set` persists a change read by every later command; the rest is
read-only.

```bash
duckbrain config show
duckbrain config get defaultNamespace
duckbrain config set defaultNamespace my-project
```

## `duckbrain servers`

```
duckbrain servers list
duckbrain servers add --name=<name> --host=<user@server>
duckbrain servers remove <name>
```

Stores named `user@server` entries in `~/.duckbrain/servers.json` so
`--socket=NAME` and `ssh-connect --name=` can reference hosts by a short
name.

**Safety:** local config file only; `add` overwrites an entry with the same
name.

```bash
duckbrain servers add --name=prod --host=user@server
duckbrain servers list
```

## `duckbrain token`

```
duckbrain token [--name=<name>] [--namespace=<ns>[,<ns>...]] [--role=<role>] [--auth-file=<path>]
```

Generates an API token for `--auth=apikey` HTTP mode and writes it to
`~/.duckbrain/auth.json` (or `--auth-file=PATH`). Grants are optional:
`--namespace` restricts the token to listed namespaces (repeatable and/or
comma-separated; absent = unrestricted), `--role` picks a role (`admin`,
`writer`, `analyst`, `uploader`; absent = `admin` for backward
compatibility), and `--name` is a human-readable label that doubles as the
author identity. TOKEN-NAME-001: a bare `--name` without a value, or a name
that is a reserved literal (`true`/`false`/`null`/`undefined`), is refused
with exit code 2 rather than minting an ambiguous credential. An explicit
`--auth-file` path that is missing or unparseable is a fatal error — the
token is never silently written to the production store.

**Safety:** creates credentials; the token value is written to the auth
store (print carefully).

```bash
duckbrain token --name=cron-agent --namespace=hermes-telemetry --role=writer
```

## `duckbrain ssh-test` / `duckbrain ssh-connect`

```
duckbrain ssh-test --host=<user@server>
duckbrain ssh-connect --host=<user@server> [--name=<name>] [--identity-file=<path>] [--port=<port>]
```

`ssh-test` dry-runs the tunnel setup (SSH reachability, key auth). `ssh-connect`
opens the tunnel and registers it under `--name` (or the host string) so
`--socket=NAME` calls ride the tunnel to the remote DuckBrain.

**Safety:** network operations; `ssh-connect` starts a long-running tunnel —
keep the process alive while using `--socket`.

```bash
duckbrain ssh-test --host=user@server
duckbrain ssh-connect --host=user@server --name=prod
duckbrain --socket=prod status
```

## `duckbrain tables`

```
duckbrain tables declare <namespace> <table> --column <name>=<type> [...]
                [--primary <col>] [--format <fmt>] [--legacy] [--force]
```

Declares a table for the generic table→REST layer (DB-SUPA-3). Writes the
SUPA-6 persistent schema at `namespaces/<ns>/schema.json`, merging into an
existing schema document. Column types: `varchar|integer|bigint|double|boolean|timestamp|json`.
`--primary` names the primary key column (must be declared; defaults to the
FIRST declared column). `--format` selects the row shape: `jsonl-objects`
(default) or `jsonl-positional`. `--legacy` writes the historical
`tables/<table>.table.json` declaration instead. Without `--force`, a
conflicting existing declaration of the same table name is refused.

**Safety:** additive/metadata-only until `--force`, which REPLACES an
existing declaration — run a plain declare first to see the conflict.

```bash
duckbrain tables declare e2e-supagap widgets --column id=integer --column name=varchar --primary id
duckbrain tables declare notes events --column id=bigint --column at=timestamp --legacy
```

## `duckbrain status`

```
duckbrain status [--namespace=<name>]
```

Prints namespace health: active namespace, on-disk path, store status.

**Safety:** read-only.

```bash
duckbrain status --namespace=default
```

## Examples

### Store and recall a memory

```bash
# Store via --content flag
duckbrain remember /projects/myapp/architecture database --domain=concept --content="Using PostgreSQL 15"

# Store via stdin
echo "Redis for caching" | duckbrain remember /projects/myapp/architecture cache --domain=raw_note

# Recall with semantic search
duckbrain recall --query="what database are we using?"

# Recall by key prefix
duckbrain recall --prefix=/projects/myapp/architecture
```

### Browse and search

```bash
duckbrain list-keys --depth=3 --limit=20          # tree view
duckbrain search "PostgreSQL"                     # keyword search (offline)
duckbrain search "S3" --all-namespaces --limit=20 # cross-namespace
duckbrain recall --query="database choices"       # semantic search
```

### Namespace workflows

```bash
duckbrain namespace create my-project      # create + git-init
duckbrain namespace use my-project         # make it the default
duckbrain remember /context "Starting a new project" --domain=raw_note
duckbrain remote add my-project git@github.com:you/my-project-memory.git
duckbrain push my-project
```

### Configuration

```bash
duckbrain config show
duckbrain config get defaultNamespace
duckbrain config set defaultNamespace my-project
```

### Git identity hygiene

```bash
duckbrain git bare              # any namespace repos with local identity pins?
duckbrain git repair-identity   # remove them (idempotent)
```

### S3 sync

```bash
duckbrain s3 status                                  # config + per-ns state
duckbrain s3 sync all push                           # push everything
duckbrain s3 sync my-project pull                    # pull one ns
duckbrain s3 query "SELECT key, domain FROM 's3://duckbrain/my-project/**/*.jsonl' LIMIT 10"
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error (missing argument, unknown command, runtime failure) |
| 2 | Validation / caller error (e.g. TOKEN-NAME-001 bare `--name`, reserved token name) |

## Environment variables

| Variable | Description |
|----------|-------------|
| `DUCKBRAIN_NAMESPACE` | Selects the ACTIVE namespace at runtime (DF-0926-04); precedence: explicit param > env > config `defaultNamespace` > `"default"` |
| `DUCKBRAIN_NAMESPACES_PATH` | Directory containing namespace repositories (default `./namespaces`); env-only, never persisted (BUG-037) |
| `DUCKBRAIN_API_PORT` | HTTP API server port (default 3000) |
| `DUCKBRAIN_AUTH_FILE` | Auth store path override (used by `http --auth-file` and `token --auth-file`) |
| `DUCKBRAIN_API_KEY` | API key for `consolidate --write-digest` (X-API-Key header; its presence also triggers the digest write) |
| `DUCKBRAIN_API_URL` | API base URL for the digest write (default `http://127.0.0.1:3000`) |

The full variable list (embedding providers, data dir, allowed hosts, ...)
lives in [Configuration](configuration).

## See also

- [Getting Started](getting-started) - installation, first steps, and the multi-host git sync walkthrough
- [Configuration](configuration) - all config keys and environment variables
- [Native S3 Storage Tier](../s3-native.md) - S3 remotes, `git-remote-s3`, daemon auto-push
- [MCP Tools Reference](../api/mcp-tools) - the same operations over MCP
- [HTTP API](../api/http-api) - REST API endpoints
- [AI Agent Configuration](ai-configure) - set up DuckBrain for Claude, Cursor, etc.
- [Deployment](deployment) - production setup and the systemd service
