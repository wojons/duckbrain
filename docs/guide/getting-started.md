# Getting Started with DuckBrain

This guide will help you install DuckBrain, configure it for your AI agent, and start using persistent memory.

## What You'll Build

By the end of this guide, you'll have:

- ✅ DuckBrain installed and running
- ✅ MCP server configured for your AI agent (Claude, Cursor, etc.)
- ✅ Your first memory stored and recalled
- ✅ Git repository tracking your memories

## Prerequisites

Before you begin, you'll need:

- **Node.js** 22+ (required by `package.json` `engines`: `>=22`). Easiest on a fresh box via [nvm](https://github.com/nvm-sh/nvm) (~11s), or install from [nodejs.org](https://nodejs.org/) / your distro's packages:

  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh | bash
  . ~/.nvm/nvm.sh   # or open a new shell
  nvm install 22 && nvm use 22
  ```

- **pnpm** 12.4.2 — the exact version is pinned in `package.json` and is the only pnpm major exercised by the clean-install CI smoke. Activate it via Corepack (bundled with Node 22); for non-root installs use `corepack enable pnpm --install-directory ~/.local/bin` and add that directory to `PATH`; fallback: `npm i -g pnpm@12.4.2`:

  ```bash
  mkdir -p ~/.local/bin
  corepack enable pnpm --install-directory ~/.local/bin
  export PATH="$HOME/.local/bin:$PATH"
  corepack prepare pnpm@12.4.2 --activate
  ```

  Do not use a different pnpm major to refresh this repository's lockfile.

- **Git** ([Download](https://git-scm.com/))
- **An AI agent** that supports MCP (Claude Desktop, Cursor, etc.)

`duckbrain.config.json` is instance-local and untracked — `duckbrain.config.example.json` is the template; the defaults work out of the box.

## Installation

### Step 1: Clone and Install

```bash
# Clone the repository
git clone https://github.com/wojons/duckbrain.git
cd duckbrain

# Install exactly what the committed pnpm lockfile specifies
pnpm install --frozen-lockfile
```

### Step 2: Verify Installation

```bash
# Test the CLI and its runtime dependency links
node bin/duckbrain.js help
```

You should see the DuckBrain help output with available commands.

Or verify the full HTTP path end to end — paste in order; the last command must print the memory you stored:

```bash
# 1. start the HTTP daemon in the background
pnpm start http --port=3000 &

# 2. wait for health (200, or 503 "degraded" while the embedding probe is unmet — that is not an install failure)
curl -s http://127.0.0.1:3000/health

# 3. create a scratch namespace
curl -s -X POST http://127.0.0.1:3000/api/namespaces \
  -H 'Content-Type: application/json' -d '{"name":"quickstart"}'

# 4. write a memory
curl -s -X POST 'http://127.0.0.1:3000/api/memories?namespace=quickstart' \
  -H 'Content-Type: application/json' \
  -d '{"key":"/quickstart/hello","domain":"concept","content":"first memory from the quickstart"}'

# 5. read it back — expect the stored content in the response
curl -s 'http://127.0.0.1:3000/api/memories/key/quickstart/hello?namespace=quickstart'
```

Success looks like: the final read returns a JSON memory object with `"key": "/quickstart/hello"` and `"content": "first memory from the quickstart"`. Connection refused on step 2 means the daemon didn't start — check the background job's output. A fresh daemon has no auth (auth is opt-in via `--auth=apikey`), so these commands need no key. Stop the background daemon with `kill %1` when done.

## Quick Start

### Option A: MCP Server Mode (Recommended for AI Agents)

Start DuckBrain as an MCP server for your AI agent:

```bash
# Start MCP server (stdio mode for Claude/Cursor)
pnpm start stdio
```

### Option B: HTTP Server Mode (For Web UI or Remote Access)

```bash
# Start HTTP API server
pnpm start http --port 3000
```

### Option C: Development Mode (API + Web UI)

```bash
# Start both API and Web UI
pnpm run dev

# Access:
# - API: http://localhost:3000
# - Web UI: http://localhost:8989
```

## Optional extras (fresh hosts)

These were needed to stand the repo up on a bare Debian 13 host (fresh-host leg, 2026-09-17) — a normal `pnpm install` + `pnpm start` does not require them.

### Global git identity (required by the git-backed memory store)

Each namespace is its own git repo and DuckBrain auto-commits after every write; the mainline test fixtures assume a global git identity exists:

```bash
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
```

### S3 storage tier (only if you enable `s3.enabled`)

The [Native S3 Storage Tier](../s3-native.md) pushes to S3-compatible remotes via `git-remote-s3`; it and the AWS CLI are Python packages — install them in a venv:

```bash
python3 -m venv ~/.venvs/duckbrain-s3
~/.venvs/duckbrain-s3/bin/pip install git-remote-s3 awscli
export PATH="$HOME/.venvs/duckbrain-s3/bin:$PATH"   # so git can find git-remote-s3
```

### Running the test suites

```bash
pnpm test:run            # unit suites
pnpm test:integration    # integration suites — needs sshpass
```

`sshpass` is the only extra the integration suite needs beyond the dev dependencies (`apt install sshpass` on Debian/Ubuntu).

## Configuration

### Environment Variables

Create a `.env` file in your project root:

```bash
# Required
DUCKBRAIN_NAMESPACE=my-project

# Optional
DUCKBRAIN_DATA_DIR=./memory
DUCKBRAIN_API_PORT=3000
DUCKBRAIN_UI_PORT=8989
DUCKBRAIN_LOG_LEVEL=info
```

See [Configuration Reference](configuration) for all options.

## Configure Your AI Agent

### For Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or equivalent:

```json
{
  "mcpServers": {
    "duckbrain": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/duckbrain/bin/duckbrain.js", "stdio"],
      "env": {
        "DUCKBRAIN_NAMESPACE": "my-project"
      }
    }
  }
}
```

**Important:** Replace `/ABSOLUTE/PATH/TO/` with the actual path to your duckbrain installation.

### For Cursor

Create `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "duckbrain": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/duckbrain/bin/duckbrain.js", "stdio"],
      "env": {
        "DUCKBRAIN_NAMESPACE": "my-project"
      }
    }
  }
}
```

### For Other Agents

See [AI Agent Configuration](ai-configure) for detailed setup instructions.

## Your First Memory

Once configured, ask your AI to remember something:

**You:** "Remember that we're using PostgreSQL for the database."

**AI will:**

1. Call the `remember` MCP tool
2. Store: `{key: "/projects/my-project/database", domain: "concept", content: "Using PostgreSQL..."}`
3. Confirm the memory was saved

**Later, you can:**

- "What database are we using?" → AI recalls the memory
- "List all architecture decisions" → AI queries by domain
- "Show me everything about databases" → AI searches memories

## Working with Namespaces

Namespaces isolate different projects:

```bash
# Create a new namespace
duckbrain init my-new-project

# List namespaces
duckbrain namespace list

# Switch namespace
duckbrain namespace use my-new-project
```

## Git Integration

DuckBrain automatically versions your memories with Git:

```bash
# Memories are stored per-namespace:
./namespaces/[namespace]/**/*.jsonl

# Each namespace has its own git repo — DuckBrain auto-commits
# immediately after every write (remember/forget).
# The gitBatching config controls the CLI worker; MCP tools
# commit synchronously on each operation.

# View git log for a namespace
cd namespaces/my-project && git log
```

## Web UI

Access the web interface to browse memories visually:

```bash
# Start API + Web UI together
pnpm run dev

# Open browser to http://localhost:8989
```

Features:

- **Tree View** - Browse hierarchical memory keys
- **Timeline** - See memories chronologically
- **Search** - Find memories by content
- **Inspector** - View full memory details

## Memory Key Patterns

Use consistent keys for organization:

```
/projects/[NAME]/
  ├── architecture/     # Design decisions
  ├── code/            # Implementation details
  ├── decisions/       # Why we chose X
  ├── todos/          # Task lists
  └── context/        # Session context
```

Examples:

- `/projects/myapp/architecture/database-choice`
- `/projects/myapp/code/auth-flow`
- `/projects/myapp/todos/current-sprint`

## Next Steps

- 📚 [AI Agent Configuration](ai-configure) - Detailed setup for Claude, Cursor, and others
- 🔧 [Configuration Reference](configuration) - All environment variables and options
- 🚀 [Deployment Guide](docker) - Production deployment with Docker
- 📖 [MCP Tools Reference](../api/mcp-tools) - Complete API documentation

## Troubleshooting

### "MCP server not starting"

```bash
# Test directly
node /path/to/duckbrain/bin/duckbrain.js stdio

# Check Node version
node --version  # Should be 22+
```

### "Permission denied"

```bash
# Make executable
chmod +x /path/to/duckbrain/bin/duckbrain.js
```

### "Namespace not found"

```bash
# Create it first
duckbrain init my-project
```

See [Troubleshooting](troubleshooting) for more solutions.

## Getting Help

- 💬 [GitHub Discussions](https://github.com/wojons/duckbrain/discussions)
- 🐛 [Report Issues](https://github.com/wojons/duckbrain/issues)
- 📖 Full documentation at [docs site](https://wojons.github.io/duckbrain)

---

**You're now ready to use DuckBrain!** 🎉

Your AI agent will now remember everything across conversations, with full version history and search capabilities.
