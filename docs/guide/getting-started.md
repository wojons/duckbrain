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

- **Node.js** 20+ ([Download](https://nodejs.org/))
- **Git** ([Download](https://git-scm.com/))
- **An AI agent** that supports MCP (Claude Desktop, Cursor, etc.)

## Installation

### Step 1: Clone and Install

```bash
# Clone the repository
git clone https://github.com/wojons/duckbrain.git
cd duckbrain

# Install dependencies
npm install
```

### Step 2: Verify Installation

```bash
# Test the CLI
npm start -- help
```

You should see the DuckBrain help output with available commands.

## Quick Start

### Option A: MCP Server Mode (Recommended for AI Agents)

Start DuckBrain as an MCP server for your AI agent:

```bash
# Start MCP server (stdio mode for Claude/Cursor)
npm start -- stdio
```

### Option B: HTTP Server Mode (For Web UI or Remote Access)

```bash
# Start HTTP API server
npm start -- http --port 8490

# Or use the unified launcher
./launch.sh api
```

### Option C: Development Mode (API + Web UI)

```bash
# Start both API and Web UI
./launch.sh dev

# Access:
# - API: http://localhost:8490
# - Web UI: http://localhost:8989
```

## Configuration

### Environment Variables

Create a `.env` file in your project root:

```bash
# Required
DUCKBRAIN_NAMESPACE=my-project

# Optional
DUCKBRAIN_DATA_DIR=./memory
DUCKBRAIN_API_PORT=8490
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

**Important:** Replace `/ABSOLUTE/PATH/TO/` with the actual path to your duckbrain installation.

### For Cursor

Create `~/.cursor/mcp.json`:

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

### For Other Agents

See [AI Agent Configuration](ai-configure) for detailed setup instructions.

## Your First Memory

Once configured, ask your AI to remember something:

**You:** "Remember that we're using PostgreSQL for the database."

**AI will:**
1. Call the `remember` MCP tool
2. Store: `{key: "/projects/my-project/database", domain: "architecture", content: "Using PostgreSQL..."}`
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
# Start with UI
./launch.sh dev

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
node --version  # Should be 20+
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
