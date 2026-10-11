# DuckBrain CLI Reference

Complete command-line interface reference for DuckBrain. Run `duckbrain --help` (or `node bin/duckbrain.js --help` from the repo) to see this list live.

## Top-level commands

| Command | Description |
|---------|-------------|
| `duckbrain stdio` | Start MCP server (stdio transport for Claude/Cursor) |
| `duckbrain http` | Start HTTP API server |
| `duckbrain service` | Manage systemd service (install/start/stop/restart/status) |
| `duckbrain remember <key>` | Store a memory (body via `--content=`, `--text=`, or stdin) |
| `duckbrain recall` | Query memories (supports `--query=` for semantic search) |
| `duckbrain search <query>` | Keyword full-text search (offline; index refreshes automatically) |
| `duckbrain search-index` | Manage the keyword search index (`rebuild` / `status` / `install-hooks`) |
| `duckbrain list-keys` | Browse memory structure (renders a plain-text tree) |
| `duckbrain forget <id>` | Delete a memory by UUID |
| `duckbrain config` | Show or set configuration (`show` / `set` / `get`) |
| `duckbrain namespace` (alias `namespaces`) | Manage namespaces (`create` / `list` / `delete-disk` / `clear-s3` / `use` / `set-remote`) |
| `duckbrain pull` | Pull changes from a namespace's remote |
| `duckbrain push` | Push changes to a namespace's remote |
| `duckbrain remote` | Configure a namespace's git remote (`add` / `remove`) |
| `duckbrain status` | Show system status |
| `duckbrain token` | Generate API token for HTTP authentication |
| `duckbrain ssh-test` | Test SSH tunnel setup |
| `duckbrain ssh-connect` | Connect to remote DuckBrain via SSH tunnel |
| `duckbrain servers` | Manage server connections (`list` / `add` / `remove`) |
| `duckbrain squash` | Compact old partitions |
| `duckbrain query` | Read-only SQL over a namespace (`SELECT ...` or `--template`) |
| `duckbrain embeddings` | Manage embedding cache (`rebuild` / `status` / `install-hooks` / `providers`) |
| `duckbrain s3` | Native S3 sync/query (`status` / `sync` / `query` / `config` / `clear` / `ghosts`) |
| `duckbrain git` | Git identity tools (`repair-identity` / `bare`) |
| `duckbrain tables` | Declare tables for the table->REST layer (`declare` / `--help`) |
| `duckbrain help` | Show top-level help |

## Common global options

| Option | Description |
|--------|-------------|
| `--namespace=NAME` | Select namespace (default: config `defaultNamespace`) |
| `--socket=NAME` | Use remote connection via Unix socket |
| `--version`, `-v` | Print the CLI version and exit |
| `--help` | Show help for the command |

## HTTP server options

| Option | Description |
|--------|-------------|
| `--port=PORT` | HTTP server port (default: 3000) |
| `--bind-all` | Bind to all interfaces (0.0.0.0) instead of localhost |
| `--auth=TYPE` | Authentication type: `none`, `basic`, `apikey` (default: `apikey`; use `none` only for explicit local mode) |
| `--auth-file=PATH` | Read auth users/apiKeys from PATH instead of `~/.duckbrain/auth.json` (env: `DUCKBRAIN_AUTH_FILE`); the file must exist |
| `--rate-limit=N` | Requests per minute per IP (default: 100) |
| `--unix-socket=PATH` | Also listen on a Unix domain socket at PATH |
| `--unix-socket-mode=OCTAL` | Socket file permissions (default: 0660) |
| `--unix-socket-group=NAME` | Chown socket to group NAME or numeric GID |

## Service commands

```
duckbrain service install [--system]  # Install as systemd service (--system = system-wide)
duckbrain service start               # Start the service
duckbrain service stop                # Stop the service
duckbrain service restart             # Restart the service
duckbrain service status              # Show service status
```

## `duckbrain config`

```
duckbrain config show                # Print the full effective config as JSON
duckbrain config get <key>           # Read a single key (e.g. defaultNamespace)
duckbrain config set <key> <value>   # Write a single key
```

**Safety:** `config set` writes to `duckbrain.config.json` in the repo root. The `namespacesPath` key is honored at runtime but env var `DUCKBRAIN_NAMESPACES_PATH` overrides it without persisting (GAP-007 precedent).

## `duckbrain namespace`

```
duckbrain namespace create <name>              # Create a new namespace (git-inits it)
duckbrain namespace list                       # List all namespaces
duckbrain namespace use <name>                 # Set the active namespace for this session
duckbrain namespace set-remote <name> <url>    # Attach a git remote to a namespace
duckbrain namespace delete-disk <name>         # Remove LOCAL copy + stop pushes (S3 version kept retrievable)
duckbrain namespace clear-s3 <name>            # DESTROY the remote S3 objects (disk untouched; dry-run default)
```

## `duckbrain git`

```
duckbrain git repair-identity   # Remove synthetic local user.name/user.email pins from all namespace repos
duckbrain git bare              # Identity health check (prints global identity + any namespace repos with local pins)
```

## `duckbrain s3`

```
duckbrain s3 status [ns]                              # Effective config + per-ns sync state
duckbrain s3 sync [ns|all] [push|pull]                # Sync namespace(s) to/from S3
duckbrain s3 query "SELECT ..."                       # SQL over s3:// via DuckDB httpfs
duckbrain s3 config                                   # Print effective config (no secrets)
duckbrain s3 clear <ns> --dry-run | --yes ...         # DESTROY the namespace's remote S3 objects
duckbrain s3 ghosts [--sweep --yes --requested-by=X]  # List (or prune) sync state that outlives its namespace dir
```

## `duckbrain embeddings`

```
duckbrain embeddings status          # Show cache stats (size, hit rate, provider)
duckbrain embeddings rebuild         # Re-embed all memories (expensive; use after model change)
duckbrain embeddings install-hooks   # Install git hooks to auto-rebuild on commit
duckbrain embeddings providers       # List available embedding providers and their health
```

## `duckbrain query`

```
duckbrain query "SELECT key, domain FROM memories WHERE domain = 'concept' LIMIT 10"
duckbrain query --template=concepts
```

Runs read-only SQL over a namespace's DuckDB view. The query sees the `memories` table (columns: `key`, `domain`, `content`, `embedding_text`, `attributes`, `created_at`, `updated_at`).

## `duckbrain tables`

```
duckbrain tables declare <name> --schema='<json-schema>'   # Declare a table
duckbrain tables --help                                     # Show table commands
```

## `duckbrain servers`

```
duckbrain servers list
duckbrain servers add --name=<name> --host=<user@server>
duckbrain servers remove <name>
```

Stores named `user@server` entries in `~/.duckbrain/servers.json`.

## `duckbrain remote`

```
duckbrain remote add <namespace> <url>     # Set the remote as 'origin' for that namespace
duckbrain remote remove <namespace>        # Delete the 'origin' remote
```

## `duckbrain pull` / `duckbrain push`

```
duckbrain pull [namespace]     # git pull --no-commit in the namespace's repo
duckbrain push [namespace]     # git push in the namespace's repo
```

Both default to the `default` namespace. `pull` uses `--no-commit` so merges are left uncommitted for you. `push` pushes whatever the auto-commit machinery has already committed.

## `duckbrain squash`

```
duckbrain squash               # Compact old JSONL partitions
```

## `duckbrain token`

```
duckbrain token                # Generate an API token for HTTP authentication
```

Creates a token and writes it to `~/.duckbrain/auth.json`.

## `duckbrain ssh-test` / `duckbrain ssh-connect`

```
duckbrain ssh-test             # Test SSH tunnel setup (dry run)
duckbrain ssh-connect          # Connect to remote DuckBrain via SSH tunnel
```

## Examples

### Store and recall a memory

```bash
# Store via --content flag
duckbrain remember /projects/myapp/architecture database --content="Using PostgreSQL 15"

# Store via stdin
echo "Redis for caching" | duckbrain remember /projects/myapp/architecture cache

# Recall with semantic search
duckbrain recall --query="what database are we using?"

# Recall by key prefix
duckbrain recall --prefix=/projects/myapp/architecture
```

### Browse and search

```bash
# List all keys in the default namespace
duckbrain list-keys

# List keys in a specific namespace
duckbrain list-keys --namespace=coding-hermes

# Keyword search (offline, fast)
duckbrain search "PostgreSQL"

# Semantic search (requires embedding provider)
duckbrain recall --query="database choices"
```

### Namespace workflows

```bash
# Create a new namespace for a project
duckbrain namespace create my-project

# Switch to it
duckbrain namespace use my-project

# Store a memory (goes into my-project)
duckbrain remember /context "Starting a new project"

# Attach a git remote for multi-host sync
duckbrain remote add my-project git@github.com:you/my-project-memory.git

# Push to the remote
duckbrain push my-project
```

### Configuration

```bash
# See the full config
duckbrain config show

# Read a single key
duckbrain config get defaultNamespace

# Change the default namespace
duckbrain config set defaultNamespace my-project

# Adjust git batching (how many lines before auto-commit)
duckbrain config set git.batchLines 100
```

### Git identity hygiene

```bash
# Check if any namespace repos have local identity pins
duckbrain git bare

# Fix them (remove local pins so global identity takes over)
duckbrain git repair-identity
```

### S3 sync

```bash
# Check S3 sync status
duckbrain s3 status

# Push all namespaces to S3
duckbrain s3 sync all push

# Pull a specific namespace from S3
duckbrain s3 sync my-project pull

# Query S3 directly via SQL
duckbrain s3 query "SELECT key, domain FROM 's3://duckbrain/my-project/**/*.jsonl' LIMIT 10"
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error (missing argument, unknown command, runtime failure) |
| 2 | Validation error (invalid namespace, bad config key, etc.) |

## Environment variables

| Variable | Description |
|----------|-------------|
| `DUCKBRAIN_NAMESPACE` | Override the default namespace |
| `DUCKBRAIN_NAMESPACES_PATH` | Override where namespace repos live |
| `DUCKBRAIN_API_PORT` | Override the HTTP API port |
| `DUCKBRAIN_AUTH_FILE` | Override the auth file path |

## See also

- [Getting Started](getting-started) - installation and first steps
- [Configuration](configuration) - all config knobs
- [MCP Tools Reference](../api/mcp-tools) - MCP tool documentation
- [HTTP API](../api/http-api) - REST API endpoints
- [AI Agent Configuration](ai-configure) - set up DuckBrain for Claude, Cursor, etc.

</content>