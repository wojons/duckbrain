# AI Agent Configuration Guide for DuckBrain 🧠🦆

> **Copy-paste ready configuration blocks** for popular AI coding agents to automatically set up DuckBrain MCP, create git repositories, and get your project running.

---

## Quick Setup (Copy-Paste This First)

Give this block to your AI agent. It will:
1. Clone and install DuckBrain
2. Create a local git repository
3. Configure MCP server
4. Set up your workspace

```markdown
## DuckBrain Complete Setup

Please set up DuckBrain MCP memory system for this project:

1. Clone and install DuckBrain:
   ```bash
   cd ~
   git clone https://github.com/wojons/duckbrain.git
   cd duckbrain
   pnpm install --frozen-lockfile
   ```

2. Create a local git repository for this project if it doesn't exist:
   ```bash
   cd [PROJECT_PATH]
   if [ ! -d .git ]; then
     git init
     git add .
     git commit -m "Initial commit"
   fi
   ```

3. Configure MCP server for [AGENT_NAME]:
   - Set namespace to: "[PROJECT_NAME]"
   - Enable persistent memory
   - Configure stdio transport

4. Create initial project structure in DuckBrain:
   - Project context
   - Key decision log
   - TODO list
   - Architecture notes

5. Initialize DuckBrain with first memory:
   ```json
   {
     "key": "/projects/[PROJECT_NAME]/setup",
     "domain": "project",
     "content": "Initial project setup completed"
   }
   ```
```

---

## Agent-Specific Configurations

### 🤖 Claude (Claude Desktop / Claude Code)

**MCP Configuration File:**

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%/Claude/claude_desktop_config.json`  
**Linux:** `~/.config/Claude/claude_desktop_config.json`

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
        "DUCKBRAIN_NAMESPACE": "[PROJECT_NAME]"
      }
    }
  }
}
```

**Copy-paste setup command for Claude:**

```markdown
Set up DuckBrain MCP for Claude:

1. Find Claude config location:
   - macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
   - Windows: %APPDATA%/Claude/claude_desktop_config.json
   - Linux: ~/.config/Claude/claude_desktop_config.json

2. Add this MCP server configuration:
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
        "DUCKBRAIN_NAMESPACE": "[PROJECT_NAME]",
        "DUCKBRAIN_NAMESPACES_PATH": "[PROJECT_PATH]/memory"
      }
    }
  }
}
```

3. Available MCP Tools:
   - `remember` - Store memories with key, domain, content
   - `recall` - Query memories by key, domain, or similarity
   - `list_keys` - List available memory keys
   - `forget` - Mark memories as deleted
   - `squash` - Compact git history
   - `get_compaction_stats` - View storage statistics

4. Best Practices:
   - Use keys like: `/projects/[PROJECT_NAME]/[component]/[topic]`
   - Domains: "code", "architecture", "decisions", "todos", "context"
   - Store architectural decisions with reasoning
   - Keep TODO lists updated
   - Remember context across sessions
```

---

### 🎯 Cursor

**MCP Configuration File:**

**macOS:** `~/.cursor/mcp.json`  
**Windows:** `%USERPROFILE%/.cursor/mcp.json`  
**Linux:** `~/.cursor/mcp.json`

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
        "DUCKBRAIN_NAMESPACE": "[PROJECT_NAME]",
        "DUCKBRAIN_NAMESPACES_PATH": "[PROJECT_PATH]/memory"
      }
    }
  }
}
```

**Copy-paste setup command for Cursor:**

```markdown
Set up DuckBrain MCP for Cursor:

1. Find Cursor MCP config:
   - macOS: ~/.cursor/mcp.json
   - Windows: %USERPROFILE%/.cursor/mcp.json
   - Linux: ~/.cursor/mcp.json

2. Add DuckBrain MCP server:
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
        "DUCKBRAIN_NAMESPACE": "[PROJECT_NAME]",
        "DUCKBRAIN_NAMESPACES_PATH": "[PROJECT_PATH]/memory"
      }
    }
  }
}
```

3. Restart Cursor to load MCP server.

4. Test with: "Remember that we're using React 18 with TypeScript"
```

---

### 🚀 OpenCode (This Tool!)

**Configuration via `.opencode/config.yaml`:**

Create `.opencode/config.yaml` in your project root:

```yaml
mcp_servers:
  - name: duckbrain
    command: node
    args:
      - /ABSOLUTE/PATH/TO/duckbrain/bin/duckbrain.js
      - stdio
    env:
      DUCKBRAIN_NAMESPACE: "[PROJECT_NAME]"
      DUCKBRAIN_NAMESPACES_PATH: "[PROJECT_PATH]/memory"

# Optional: Set DuckBrain as default memory system
memory:
  provider: duckbrain
  namespace: "[PROJECT_NAME]"
```

**Copy-paste setup command for OpenCode:**

```markdown
Set up DuckBrain MCP for OpenCode:

1. Create `.opencode/config.yaml` in project root:
```yaml
mcp_servers:
  - name: duckbrain
    command: node
    args:
      - /ABSOLUTE/PATH/TO/duckbrain/bin/duckbrain.js
      - stdio
    env:
      DUCKBRAIN_NAMESPACE: "[PROJECT_NAME]"
      DUCKBRAIN_NAMESPACES_PATH: "[PROJECT_PATH]/memory"
```

2. OpenCode will auto-discover MCP tools.

3. Use natural language:
   - "Remember we decided to use PostgreSQL"
   - "What was our architecture decision about caching?"
   - "List all TODO items"
```

---

### 🤖 GitHub Copilot (with MCP support)

**VS Code Settings:**

Add to VS Code settings.json:

```json
{
  "github.copilot.chat.codeGeneration.useInstructionFiles": true,
  "mcp": {
    "servers": {
      "duckbrain": {
        "command": "node",
        "args": [
          "/ABSOLUTE/PATH/TO/duckbrain/bin/duckbrain.js",
          "stdio"
        ],
        "env": {
          "DUCKBRAIN_NAMESPACE": "[PROJECT_NAME]",
          "DUCKBRAIN_NAMESPACES_PATH": "[PROJECT_PATH]/memory"
        }
      }
    }
  }
}
```

**Copy-paste setup command for Copilot:**

```markdown
Set up DuckBrain MCP for GitHub Copilot in VS Code:

1. Open VS Code settings (Cmd/Ctrl + Shift + P → "Preferences: Open Settings JSON")

2. Add MCP configuration:
```json
{
  "mcp": {
    "servers": {
      "duckbrain": {
        "command": "node",
        "args": [
          "/ABSOLUTE/PATH/TO/duckbrain/bin/duckbrain.js",
          "stdio"
        ],
        "env": {
          "DUCKBRAIN_NAMESPACE": "[PROJECT_NAME]",
          "DUCKBRAIN_NAMESPACES_PATH": "[PROJECT_PATH]/memory"
        }
      }
    }
  }
}
```

3. Copilot will now use DuckBrain for persistent memory across sessions.
```

---

### 💻 Windsurf

**Configuration:**

Windsurf uses the same MCP config format as Cursor:

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
        "DUCKBRAIN_NAMESPACE": "[PROJECT_NAME]",
        "DUCKBRAIN_NAMESPACES_PATH": "[PROJECT_PATH]/memory"
      }
    }
  }
}
```

Save to: `~/.windsurf/mcp.json`

---

### 🔧 Aider

**Configuration via `.aider.conf.yml`:**

```yaml
# MCP server configuration
mcp_servers:
  - name: duckbrain
    command: node
    args:
      - /ABSOLUTE/PATH/TO/duckbrain/bin/duckbrain.js
      - stdio
    env:
      DUCKBRAIN_NAMESPACE: "[PROJECT_NAME]"
      DUCKBRAIN_NAMESPACES_PATH: "[PROJECT_PATH]/memory"

# Enable MCP tools
use_mcp: true
```

---

## 🏗️ Git Repository Setup

### Option 1: Local Repository Only

```bash
# Initialize git repository locally
git init
git add .
git commit -m "Initial commit: Project setup with DuckBrain"

# Configure DuckBrain to use this repo
duckbrain init [PROJECT_NAME] --path .
```

### Option 2: Connect to GitHub

```bash
# Create repo on GitHub first, then:
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/[USERNAME]/[REPO_NAME].git
git branch -M main
git push -u origin main

# Configure DuckBrain namespace
duckbrain init [PROJECT_NAME] --git-remote origin
```

### Automated Setup Script

Copy-paste this complete setup:

```bash
#!/bin/bash
# DuckBrain Project Setup Script

PROJECT_NAME="[YOUR_PROJECT_NAME]"
PROJECT_PATH="$(pwd)"
DUCKBRAIN_PATH="$HOME/duckbrain"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}Setting up DuckBrain for $PROJECT_NAME...${NC}"

# 1. Clone DuckBrain if not exists
if [ ! -d "$DUCKBRAIN_PATH" ]; then
    echo "Cloning DuckBrain..."
    git clone https://github.com/wojons/duckbrain.git "$DUCKBRAIN_PATH"
    cd "$DUCKBRAIN_PATH"
    pnpm install --frozen-lockfile
fi

# 2. Initialize git repo if needed
cd "$PROJECT_PATH"
if [ ! -d .git ]; then
    echo -e "${BLUE}Initializing git repository...${NC}"
    git init
    git add .
    git commit -m "Initial commit"
fi

# 3. Create DuckBrain namespace
mkdir -p "$PROJECT_PATH/memory"
cd "$DUCKBRAIN_PATH"
node bin/duckbrain.js namespace create "$PROJECT_NAME" --data-dir "$PROJECT_PATH/memory"

echo -e "${GREEN}✓ DuckBrain setup complete!${NC}"
echo ""
echo "Next steps:"
echo "1. Configure your AI agent with the MCP settings above"
echo "2. Start using: 'Remember that...' or 'What did we decide about...'"
echo ""
echo "DuckBrain installed at: $DUCKBRAIN_PATH"
echo "Namespace: $PROJECT_NAME"
echo "Data directory: $PROJECT_PATH/memory"
```

---

## 📝 Memory Key Patterns

Use consistent hierarchical keys for better organization:

```
/projects/[PROJECT_NAME]/
  ├── architecture/          # High-level design decisions
  │   ├── database-choice
  │   ├── auth-strategy
  │   └── caching-approach
  ├── code/                  # Implementation details
  │   ├── [filename]/
  │   │   ├── structure
  │   │   └── known-issues
  │   └── dependencies/
  ├── decisions/             # Why we chose X over Y
  │   ├── 2024-01-15-framework
  │   └── 2024-01-20-deployment
  ├── todos/                 # Task lists
  │   ├── current-sprint
  │   └── backlog
  ├── context/               # Session context
  │   ├── current-focus
  │   └── last-session
  └── errors/                # Debugging knowledge
      ├── [error-hash]/
      └── solutions/
```

---

## 🎯 Example Workflows

### Starting a New Session

```markdown
AI, please recall what we were working on last time and what our current priorities are.
```

The AI will:
1. Call `recall` with key `/projects/[PROJECT]/context/last-session`
2. Call `recall` with key `/projects/[PROJECT]/todos/current-sprint`
3. Summarize where we left off

### Making an Architectural Decision

```markdown
AI, remember that we decided to use PostgreSQL over MongoDB because we need ACID transactions for financial data. Store this in the architecture domain.
```

The AI will:
1. Call `remember` with:
   - key: `/projects/[PROJECT]/decisions/2024-01-20-database`
   - domain: `architecture`
   - content: Full reasoning and trade-offs

### Debugging an Error

```markdown
AI, we encountered this error: [paste error]. Check if we've seen this before and store the solution once we fix it.
```

The AI will:
1. Call `recall` with domain `errors` to find similar issues
2. Help debug
3. Call `remember` to store solution for future reference

---

## 🔧 Troubleshooting

### MCP Server Not Starting

```bash
# Test MCP server directly
node /path/to/duckbrain/bin/duckbrain.js stdio

# Check for errors in stderr
```

### Permission Denied

```bash
# Make sure duckbrain.js is executable
chmod +x /path/to/duckbrain/bin/duckbrain.js

# Or use node explicitly
node /path/to/duckbrain/bin/duckbrain.js stdio
```

### Namespace Not Found

```bash
# Create namespace
duckbrain init [PROJECT_NAME]

# Or specify data directory
duckbrain init [PROJECT_NAME] --data-dir ./memory
```

---

## 📚 Environment Variables Reference

| Variable | Description | Default |
|----------|-------------|---------|
| `DUCKBRAIN_NAMESPACE` | Active namespace for this agent — overrides the config file's `defaultNamespace` (see below) | `default` |
| `DUCKBRAIN_NAMESPACES_PATH` | Directory holding the namespace repositories — the "where is memory stored" knob | `./namespaces` |
| `DUCKBRAIN_DATA_DIR` | Runtime directory for the HTTP server's PID file (`duckbrain-http-<port>.pid`) — **not** the memory store | system temp dir |
| `DUCKBRAIN_API_PORT` | HTTP API port | `3000` |
| `DUCKBRAIN_UI_PORT` | Web UI port | `8989` |
| `DUCKBRAIN_GIT_REMOTE` | Git remote for syncing | (none) |
| `DUCKBRAIN_LOG_LEVEL` | Logging verbosity | `info` |

> **Not implemented yet:** `DUCKBRAIN_UI_PORT`, `DUCKBRAIN_GIT_REMOTE` and
> `DUCKBRAIN_LOG_LEVEL` have no readers in the current code — setting them has
> no effect. The HTTP port is the `duckbrain http --port=…` flag, and a
> namespace's git remote is configured with `duckbrain remote`.

### 🎯 Namespace Resolution Order

The namespace an operation writes to (or reads from) is resolved in exactly
this order — the first one that is set wins:

1. **Explicit parameter** — `remember`'s `namespace` argument, the CLI's
   `--namespace=<name>`, or the HTTP API's `?namespace=<name>` / `"namespace"`
   body field.
2. **`DUCKBRAIN_NAMESPACE`** — the environment variable, set per agent.
3. **`defaultNamespace`** in `duckbrain.config.json`.
4. **`default`** — the last resort.

```bash
# One shared DuckBrain, one namespace per agent: set the env var in the
# agent's MCP `env` block (see the per-agent configs above)…
"env": { "DUCKBRAIN_NAMESPACE": "[PROJECT_NAME]" }

# …and every remember/recall/list_keys that does not name a namespace lands in
# "[PROJECT_NAME]" instead of the shared `default`.
```

`DUCKBRAIN_NAMESPACE` is a **runtime** override: it is never written back to
`duckbrain.config.json`, so an agent started with it cannot rewrite the shared
config. Two other ways to pin the active namespace persistently:

- `switch_namespace` (MCP tool) persists `defaultNamespace` into
  `duckbrain.config.json` — sticky across processes. **If `DUCKBRAIN_NAMESPACE`
  is set it still wins**, so a persisted switch cannot move an env-pinned
  agent (unset the variable to let the switch take effect).
- `duckbrain config set defaultNamespace <name>` (CLI).

**Where memory actually lives:** all namespaces are directories under
`DUCKBRAIN_NAMESPACES_PATH` (default `./namespaces`, i.e. `<duckbrain
root>/namespaces`). Use it when you want an agent's whole store somewhere else
(a separate project directory, a mount); use `DUCKBRAIN_NAMESPACE` when agents
should share one store but stay isolated inside it.

---

## 🚀 Advanced: HTTP Mode

For remote access or multi-agent setups:

```bash
# Start HTTP server
duckbrain http --port=3000

# Configure MCP to use HTTP transport
```

Then configure MCP with HTTP endpoint instead of stdio.

---

**Questions or issues?** Open an issue at https://github.com/wojons/duckbrain/issues

**Ready to use?** Copy the "Quick Setup" section at the top and give it to your AI agent!
