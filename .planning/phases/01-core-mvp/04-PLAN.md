---
phase: 01-core-mvp
plan: 04
type: execute
wave: 3
depends_on: [02, 03]
files_modified: [src/cli/stdio.ts, src/cli/human.ts, bin/duckbrain, package.json]
autonomous: true
requirements: [CLI-01, CLI-02]

must_haves:
  truths:
    - "Stdio MCP mode works with local Claude"
    - "CLI commands accessible to human operators"
    - "Entry points properly configured in package.json"
  artifacts:
    - path: "src/cli/stdio.ts"
      provides: "Stdio MCP entry point"
      exports: ["startStdioMode"]
    - path: "src/cli/http.ts"
      provides: "HTTP MCP server with multi-user endpoints"
      exports: ["startHttpMode", "createHttpServer"]
    - path: "src/cli/human.ts"
      provides: "Human operator CLI commands"
      exports: ["runHumanCLI"]
    - path: "bin/duckbrain"
      provides: "CLI executable"
      contains: "#!/usr/bin/env node shebang"
    - path: "package.json"
      provides: "Bin configuration"
      contains: '"bin": {"duckbrain": "./bin/duckbrain"}'
  key_links:
    - from: "bin/duckbrain"
      to: "src/cli/stdio.ts"
      via: "Command dispatch"
      pattern: "startStdioMode\\("
    - from: "src/cli/stdio.ts"
      to: "src/mcp/server.ts"
      via: "Server import and start"
      pattern: "startServer\\("
---

<objective>
Create CLI entry points for stdio MCP (local Claude) and human operator commands.

Purpose: Make DuckBrain usable by both AI agents (via MCP) and humans (via CLI).
Output: Working stdio mode, CLI commands, proper bin configuration.
</objective>

<execution_context>
@/Users/lexykwaii/Code/duckbrain/.opencode/get-shit-done/workflows/execute-plan.md
@/Users/lexykwaii/Code/duckbrain/.opencode/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/REQUIREMENTS.md
@.planning/phases/01-core-mvp/01-CONTEXT.md
@.planning/phases/01-core-mvp/01-RESEARCH.md
@.planning/phases/01-core-mvp/01-PLAN.md
@.planning/phases/01-core-mvp/02-PLAN.md
@.planning/phases/01-core-mvp/03-PLAN.md

<interfaces>
<!-- Contracts from Wave 1-3 that this plan implements against -->

From 03-PLAN.md Wave 2:
```typescript
// From src/mcp/server.ts
export const server: McpServer;
export async function startServer(transport: StdioServerTransport): Promise<void>;
export async function stopServer(): Promise<void>;
```

From 02-PLAN.md Wave 2:
```typescript
// From src/mcp/tools/remember.ts
export async function rememberTool(input: RememberInput): Promise<RememberResponse>;

// From src/mcp/tools/recall.ts
export async function recallTool(input: RecallInput): Promise<RecallResponse>;

// From src/mcp/tools/list_keys.ts
export async function listKeysTool(input: ListKeysInput): Promise<ListKeysResponse>;

// From src/mcp/tools/forget.ts
export async function forgetTool(input: ForgetInput): Promise<ForgetResponse>;
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Create stdio MCP entry point</name>
  <files>src/cli/stdio.ts</files>
  <action>
    Create stdio mode entry point per CLI-01 and D-23 (dual interface: stdio MCP for local Claude):
    
    Function startStdioMode():
    1. Import StdioServerTransport from @modelcontextprotocol/server/stdio.js
    2. Import server from src/mcp/server.ts
    3. Create transport: new StdioServerTransport()
    4. Connect server: await server.connect(transport)
    5. Log startup message to stderr (NOT stdout - stdout reserved for MCP protocol):
       console.error('[duckbrain] MCP server started in stdio mode')
    6. Handle graceful shutdown on SIGINT/SIGTERM:
       - Call stopServer()
       - Process.exit(0)
    
    Error handling:
    - Wrap in try/catch
    - On error: log to stderr, exit with code 1
    
    Export startStdioMode() for use by bin/duckbrain.
    
    Reference: RESEARCH.md "Pattern 1: MCP Server with Stdio Transport".
    
    Testing note: Stdio mode expects stdin/stdout piping - test with:
    ```bash
    echo '{"jsonrpc":"2.0","method":"initialize"}' | node src/cli/stdio.ts
    ```
  </action>
  <verify>
    <automated>node -e "const s = require('./src/cli/stdio'); console.log('Stdio exports:', Object.keys(s))"</automated>
  </verify>
  <done>Stdio mode starts MCP server, handles stdin/stdout for MCP protocol</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Create HTTP MCP server with multi-user endpoints</name>
  <files>src/cli/http.ts</files>
  <action>
    Create HTTP server per D-27 (admin endpoints), D-28 (Web UI prep), D-29 (git worktrees):
    
    Functions:
    - startHttpMode(options: { port?: number, host?: string }): Promise<void>
      Starts Express server with MCP transport + admin endpoints
    
    - createHttpServer(namespaces: Namespace[]): Express
      Creates Express app with all routes
    
    Endpoints to implement:
    1. MCP transport: POST /mcp, GET /mcp (Streamable HTTP)
    2. Health: GET /health - status, uptime, loaded namespaces, memory usage
    3. Stats: GET /stats - memory counts, namespace sizes, git status
    4. Namespaces: GET /namespaces - list loaded namespaces
    5. Users: GET /users - list unique authors (git emails from memories)
    6. Activity: GET /activity?limit=50 - recent writes/commits
    7. Web UI prep:
       - GET /api/tree - hierarchical memory tree from keys
       - GET /api/timeline - chronological feed with filters
       - GET /api/search - search with domain/key/regex filters
    
    Include DNS rebinding protection middleware (required for remote hosting).
    Support git worktrees for multi-agent isolation (per-branch checkout).
    
    Reference: RESEARCH.md "Pattern 4: HTTP Server with Multi-User Support"
  </action>
  <verify>
    <automated>curl http://localhost:3000/health | jq '.status'</automated>
    <automated>curl http://localhost:3000/stats | jq 'keys'</automated>
  </verify>
  <done>HTTP server running with all endpoints, health check returns "healthy"</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Create human CLI commands</name>
  <files>src/cli/human.ts</files>
  <action>
    Create human-readable CLI per CLI-02 (CLI commands for human operators), D-24 (config system), D-25 (namespace flag), D-30 (list_keys with glob/regex):
    
    Commands to implement:
    
    1. `duckbrain remember <key> --domain=<domain> --attr=<json> [--namespace=<name>]`
       - Parses key, domain, attributes from CLI args
       - Calls rememberTool() internally
       - Outputs human-readable result: "✓ Remembered {key} (ID: {id})"
    
    2. `duckbrain recall [options]`
       - Options: --key=, --prefix=, --domain=, --query=, --limit=, --namespace=
       - Calls recallTool() internally
       - Outputs formatted memories (pretty-printed JSON or table)
    
    3. `duckbrain list-keys [options]`
       - Options: --prefix=, --regex=, --depth=, --limit=, --page=, --namespace=
       - Calls listKeysTool() internally with glob/regex support
       - Outputs key tree structure with pagination info
    
    4. `duckbrain forget <id> [--reason=<reason>] [--namespace=<name>]`
       - Calls forgetTool() internally
       - Outputs: "✓ Forgotten {id}"
    
    5. `duckbrain config show`
       - Shows full config from ~/.duckbrain/config.json
    
    6. `duckbrain config set <key> <value>`
       - Updates config value
    
    7. `duckbrain namespaces list`
       - Lists configured namespaces from config
    
    8. `duckbrain namespaces add <name> <path-or-git-url>`
       - Adds new namespace to config
    
    9. `duckbrain status [--namespace=<name>]`
       - Shows: namespace path, manifest stats, git status, memory count
    
    10. `duckbrain ssh-test --host=<user@server>`
        - Tests SSH tunnel setup, shows command to run
    
    Implementation:
    - Use commander.js or minimal arg parsing
    - Each command: parse args → call tool function → format output
    - Support --namespace flag on all memory commands for multi-namespace operation
    - Namespace selection: --namespace flag (default: 'default')
    - Error messages: human-friendly, not stack traces
    
    Export runHumanCLI(command: string, args: string[]): Promise<void> for bin/duckbrain dispatch.
    
    Reference: D-23 dual interface pattern - this is the "CLI (human operators)" mode.
  </action>
  <verify>
    <automated>node -e "const h = require('./src/cli/human'); console.log('Human CLI exports:', Object.keys(h))"</automated>
  </verify>
  <done>Human CLI commands (remember, recall, list-keys, forget, status) parse args and call tools</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Create CLI executable with command routing</name>
  <files>bin/duckbrain</files>
  <action>
    Create CLI entry point that routes to different modes:
    
    Shebang: #!/usr/bin/env node
    
    Command structure:
    ```bash
    duckbrain <mode> [options]
    
    Modes:
      stdio       Start MCP server in stdio mode (for local Claude)
      remember    Remember a memory (human operator)
      recall      Query memories (human operator)
      list-keys   List memory keys (human operator)
      forget      Forget a memory (human operator)
      status      Show system status
      help        Show help message
    ```
    
    Implementation:
    1. Parse process.argv[2] as mode
    2. Route to appropriate handler:
       - 'stdio' → import and call startStdioMode()
       - 'remember'/'recall'/'list-keys'/'forget'/'status' → import runHumanCLI() from human.ts
       - 'help' or unknown → print help message
    
    Help message format:
    ```
    DuckBrain v1.0.0 - AI Memory System
    
    Usage: duckbrain <command> [options]
    
    Commands:
      stdio              Start MCP server for local Claude
      remember <key>     Remember a memory
      recall             Query memories
      list-keys          Browse memory structure
      forget <id>        Delete a memory
      status             Show system status
    
    Options:
      --namespace=NAME   Select namespace (default: default)
      --help             Show this help
    
    Examples:
      duckbrain stdio
      duckbrain remember /contacts/alice --domain=person --attr='{"name":"Alice"}'
      duckbrain recall --prefix=/projects/
    ```
    
    Exit codes:
    - 0: Success
    - 1: Error (log to stderr)
    
    Make executable: chmod +x bin/duckbrain
  </action>
  <verify>
    <automated>node bin/duckbrain help 2>&1 | grep -q "DuckBrain" && echo "✓ Help works"</automated>
  </verify>
  <done>CLI executable routes commands, help message displays, exit codes correct</done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: Create Opencode skill for CLI usage</name>
  <files>.opencode/agents/duckbrain-cli.md</files>
  <action>
    Create Opencode skill per D-26 (Opencode skill provided — teaches CLI usage):
    
    Skill should include:
    1. Installation instructions (npm install -g duckbrain)
    2. Initial setup (duckbrain config init, first namespace)
    3. Connection modes:
       - stdio: Claude Desktop config snippet
       - HTTP: curl examples, browser access
       - SSH: ssh tunnel command, Claude Desktop config
       - CLI: direct terminal usage
    4. Command examples:
       - duckbrain remember /projects/myproj "Memory text" --domain=concept
       - duckbrain recall --query "MCP protocol" --limit=5
       - duckbrain list-keys --prefix="/projects/*" --regex="^/projects/[^/]+/schema$"
       - duckbrain namespaces add team git@github.com:team/memory.git
    5. Troubleshooting:
       - Connection refused (HTTP/SSH)
       - Namespace not found
       - Git auth errors
    6. Config file location and format
    
    Format: Markdown with clear sections, code examples, troubleshooting flowchart.
  </action>
  <verify>
    <manual>Review skill for completeness</manual>
  </verify>
  <done>Opencode skill published, users can learn CLI usage</done>
</task>

<task type="auto" tdd="true">
  <name>Task 5: Configure package.json bin entry</name>
  <files>package.json</files>
  <action>
    Add bin configuration to package.json:
    
    ```json
    {
      "bin": {
        "duckbrain": "./bin/duckbrain"
      }
    }
    ```
    
    Make bin/duckbrain executable: chmod +x bin/duckbrain
    
    Test: npm link && duckbrain --help
  </action>
  <verify>
    <automated>npm link && duckbrain --help</automated>
  </verify>
  <done>Global duckbrain command works</done>
</task>

</tasks>

<verification>
Phase verification (Wave 3):
1. Stdio mode starts and accepts MCP protocol messages
2. Human CLI commands work for all 4 tools plus status
3. CLI executable routes commands correctly
4. Help message displays all available commands
5. Exit codes correct (0=success, 1=error)
</verification>

<success_criteria>
- [ ] CLI-01: Stdio MCP works with local Claude ✓
- [ ] CLI-02: CLI commands for human operators ✓
- [ ] D-23: Dual interface (stdio + CLI) implemented ✓
- [ ] package.json bin configured correctly ✓
- [ ] All commands (remember, recall, list-keys, forget, status) accessible ✓
</success_criteria>

<output>
After completion, create `.planning/phases/01-core-mvp/04-SUMMARY.md` with:
- Stdio mode test results
- CLI command examples and outputs
- Help message screenshot/text
- Installation instructions
- Known limitations (e.g., HTTP mode in Phase 2)
</output>
