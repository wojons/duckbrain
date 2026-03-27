# DuckBrain CLI Skill

Teaches the DuckBrain CLI usage for AI agents and human operators.

## Installation

### Prerequisites

- Node.js 18+ or Bun 1.x
- Git (for version control)

### Install DuckBrain

```bash
# Using npm
npm install -g duckbrain

# Using bun
bun install -g duckbrain

# Or link from source
cd /path/to/duckbrain
bun link
```

Verify installation:
```bash
duckbrain help
```

## Initial Setup

### 1. Create First Namespace

```bash
# Create default namespace directory
mkdir -p ~/memory/default

# Or initialize with git (recommended for collaboration)
cd ~/memory
git init default
cd default
git commit --allow-empty -m "Initialize DuckBrain memory namespace"
```

### 2. Configure DuckBrain

```bash
# Show current configuration
duckbrain config show

# Set default namespace path (if not using ~/memory/default)
duckbrain config set namespaces.default ~/memory/default
```

Configuration file location: `~/.duckbrain/config.json`

## Connection Modes

### Mode 1: Stdio (Local Claude Desktop)

Best for: Single-user local development

**Claude Desktop Config** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "duckbrain": {
      "command": "duckbrain",
      "args": ["stdio"]
    }
  }
}
```

**Usage:**
```bash
# Start stdio mode (Claude Desktop handles this automatically)
duckbrain stdio
```

**Expected output:**
```
[duckbrain] MCP server started in stdio mode
```

### Mode 2: HTTP (Remote Hosting)

Best for: Multi-agent setups, team collaboration

**Start HTTP server:**
```bash
# Default port 3000
duckbrain http

# Custom port
duckbrain http --port=8080
```

**Endpoints:**
- `POST /mcp` - MCP Streamable HTTP transport
- `GET /mcp` - MCP GET endpoint
- `GET /health` - Health check
- `GET /stats` - System statistics
- `GET /namespaces` - List loaded namespaces
- `GET /api/tree` - Memory tree structure
- `GET /api/timeline` - Chronological feed
- `GET /api/search` - Search with filters

**Claude Desktop Config for HTTP:**
```json
{
  "mcpServers": {
    "duckbrain": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

### Mode 3: SSH Tunneling

Best for: Secure remote access without opening ports

**SSH Tunnel Command:**
```bash
# One-shot invocation
ssh user@remote-host "duckbrain stdio"
```

**Claude Desktop Config for SSH:**
```json
{
  "mcpServers": {
    "duckbrain": {
      "command": "ssh",
      "args": ["user@remote-host", "duckbrain", "stdio"]
    }
  }
}
```

**Test SSH setup:**
```bash
duckbrain ssh-test --host=user@remote-host
```

### Mode 4: Direct CLI (Human Operators)

Best for: Manual memory management, debugging

```bash
# Remember a memory
duckbrain remember /contacts/alice --domain=person --attr='{"name":"Alice","email":"alice@example.com"}'

# Recall memories
duckbrain recall --prefix=/contacts/
duckbrain recall --domain=person --limit=10

# List memory keys
duckbrain list-keys --depth=2 --limit=50
duckbrain list-keys --prefix="/projects/*" --regex="^/projects/[^/]+/schema$"

# Forget a memory
duckbrain forget <memory-id> --reason="obsolete"

# Show status
duckbrain status --namespace=default
```

## Command Reference

### `duckbrain stdio`

Start MCP server in stdio mode for local Claude Desktop integration.

```bash
duckbrain stdio
```

**Output:** Logs to stderr, MCP protocol on stdout/stdin

### `duckbrain http [options]`

Start MCP server with HTTP transport.

```bash
duckbrain http --port=3000
```

**Options:**
- `--port=<number>` - Port to listen on (default: 3000)

### `duckbrain remember <key> [options]`

Store a new memory.

```bash
duckbrain remember /projects/mcp/schema --domain=concept --attr='{"description":"MCP protocol"}'
```

**Options:**
- `--domain=<domain>` - Memory domain (default: general)
- `--attr=<json>` - Attributes as JSON
- `--namespace=<name>` - Namespace to use (default: default)

**Output:**
```
✓ Remembered /projects/mcp/schema (ID: uuid-here)
```

### `duckbrain recall [options]`

Query memories with various modes.

```bash
# Exact key lookup
duckbrain recall --key=/projects/mcp/schema

# Prefix glob
duckbrain recall --prefix=/projects/*/schema

# Domain filter
duckbrain recall --domain=person --limit=20

# Semantic search (Phase 2)
duckbrain recall --query="MCP protocol" --limit=5
```

**Options:**
- `--key=<key>` - Exact key lookup
- `--prefix=<pattern>` - Prefix glob pattern
- `--domain=<domain>` - Filter by domain
- `--query=<text>` - Semantic search query
- `--limit=<number>` - Max results (default: 10)
- `--namespace=<name>` - Namespace to query

### `duckbrain list-keys [options]`

Browse memory key structure hierarchically.

```bash
# Show top-level structure
duckbrain list-keys --depth=2

# Explore specific prefix
duckbrain list-keys --prefix=/projects/ --depth=3

# Paginated results
duckbrain list-keys --limit=100 --offset=0

# Regex filtering
duckbrain list-keys --regex="^/projects/[^/]+/schema$"
```

**Options:**
- `--prefix=<pattern>` - Filter keys by prefix
- `--regex=<pattern>` - Filter keys by regex
- `--depth=<number>` - Tree depth (default: 2)
- `--limit=<number>` - Max keys (default: 50)
- `--offset=<number>` - Pagination offset
- `--namespace=<name>` - Namespace to list

### `duckbrain forget <id> [options]`

Soft-delete a memory by appending tombstone.

```bash
duckbrain forget abc-123-def --reason="outdated information"
```

**Options:**
- `--reason=<text>` - Reason for deletion (default: User requested)

**Output:**
```
✓ Forgotten abc-123-def
```

### `duckbrain config <command>`

Manage configuration.

```bash
# Show current config
duckbrain config show

# Set a value
duckbrain config set namespaces.default ~/memory/default
```

### `duckbrain namespaces <command>`

Manage namespaces.

```bash
# List configured namespaces
duckbrain namespaces list

# Add new namespace
duckbrain namespaces add team git@github.com:team/memory.git
```

### `duckbrain status [options]`

Show system status.

```bash
duckbrain status --namespace=default
```

**Shows:**
- Namespace path
- Git status
- Memory count
- Configuration

### `duckbrain ssh-test [options]`

Test SSH tunnel setup.

```bash
duckbrain ssh-test --host=user@remote-host
```

**Output:** SSH connection command and Claude Desktop config snippet

## Troubleshooting

### "Namespace 'default' does not exist"

**Cause:** Namespace directory not created or not configured.

**Solution:**
```bash
# Create namespace directory
mkdir -p ~/memory/default

# Or configure existing path
duckbrain config set namespaces.default /path/to/memory
```

### "Connection refused" (HTTP mode)

**Cause:** HTTP server not running or wrong port.

**Solution:**
```bash
# Start HTTP server
duckbrain http --port=3000

# Verify it's running
curl http://localhost:3000/health
```

### "Git auth errors" (remote namespaces)

**Cause:** SSH key not configured or Git authentication failed.

**Solution:**
```bash
# Test SSH key
ssh -T git@github.com

# Add SSH key to agent
ssh-add ~/.ssh/id_rsa

# Or use HTTPS with token
git clone https://<token>@github.com/user/repo.git
```

### "Command not found: duckbrain"

**Cause:** Global installation failed or PATH not updated.

**Solution:**
```bash
# Reinstall globally
npm install -g duckbrain

# Or use bun
bun install -g duckbrain

# Verify installation
which duckbrain
```

### Stdio mode outputs garbled text

**Cause:** stdout/stderr mixed - stdio mode reserves stdout for MCP protocol.

**Solution:**
- Logs appear on stderr (normal)
- Don't read stdout directly - let Claude Desktop handle MCP protocol
- Use `duckbrain status` for human-readable output instead

## Configuration File

Location: `~/.duckbrain/config.json`

**Format:**
```json
{
  "namespaces": {
    "default": "./memory/default",
    "team": "git@github.com:team/memory.git"
  },
  "defaultNamespace": "default",
  "gitBatchLines": 100,
  "gitBatchIntervalMs": 5000
}
```

**Fields:**
- `namespaces` - Map of namespace names to paths or Git URLs
- `defaultNamespace` - Default namespace for CLI commands
- `gitBatchLines` - Lines to buffer before git commit (default: 100)
- `gitBatchIntervalMs` - Time to buffer before git commit (default: 5000ms)

## Examples

### Personal Knowledge Base

```bash
# Remember concepts
duckbrain remember /concepts/mcp --domain=concept --attr='{
  "name": "Model Context Protocol",
  "description": "Protocol for AI tool integration",
  "learned": "2024-01-15"
}'

# Query by domain
duckbrain recall --domain=concept --limit=10

# Browse hierarchy
duckbrain list-keys --prefix=/concepts/ --depth=3
```

### Project Memory

```bash
# Remember project structure
duckbrain remember /projects/duckbrain/architecture --domain=project --attr='{
  "components": ["schema", "storage", "mcp", "cli"],
  "stack": ["TypeScript", "DuckDB", "Git"]
}'

# Track decisions
duckbrain remember /projects/duckbrain/decisions/001 --domain=event --attr='{
  "decision": "Use append-only JSONL",
  "rationale": "Clean git merges, full history",
  "date": "2024-01-15"
}'
```

### Collaborative Team Memory

```bash
# Add team namespace
duckbrain namespaces add team git@github.com:team/project-memory.git

# Use team namespace
duckbrain remember /team/onboarding/checklist --namespace=team --attr='{
  "steps": ["Setup dev env", "Read docs", "First PR"]
}'

# Query team memory
duckbrain recall --namespace=team --prefix=/team/onboarding/
```

---

*Skill Version: 1.0.0*
*DuckBrain Version: 1.0.0*
