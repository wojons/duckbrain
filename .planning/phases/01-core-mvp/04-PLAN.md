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
  <name>Task 2: Create human operator CLI commands</name>
  <files>src/cli/human.ts</files>
  <action>
    Create human-readable CLI per CLI-02 (CLI commands for human operators):
    
    Commands to implement:
    
    1. `duckbrain remember <key> --domain=<domain> --attr=<json>`
       - Parses key, domain, attributes from CLI args
       - Calls rememberTool() internally
       - Outputs human-readable result: "✓ Remembered {key} (ID: {id})"
    
    2. `duckbrain recall [options]`
       - Options: --key=, --prefix=, --domain=, --query=, --limit=
       - Calls recallTool() internally
       - Outputs formatted memories (pretty-printed JSON or table)
    
    3. `duckbrain list-keys [options]`
       - Options: --prefix=, --depth=, --limit=
       - Calls listKeysTool() internally
       - Outputs key tree structure
    
    4. `duckbrain forget <id> [--reason=<reason>]`
       - Calls forgetTool() internally
       - Outputs: "✓ Forgotten {id}"
    
    5. `duckbrain status`
       - Shows: namespace path, manifest stats (partition count), git status
    
    Implementation:
    - Use commander.js or minimal arg parsing (no external dependency needed for simple parsing)
    - Each command: parse args → call tool function → format output
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
  <name>Task 4: Configure package.json bin entry</name>
  <files>package.json</files>
  <action>
    Add bin configuration to package.json:
    
    ```json
    {
      "bin": {
        "duckbrain": "./bin/duckbrain"
      },
      "files": [
        "bin/",
        "src/"
      ]
    }
    ```
    
    After bun install, this creates symlink: node_modules/.bin/duckbrain → bin/duckbrain
    
    Test installation:
    ```bash
    bun link
    duckbrain help
    ```
    
    Or run directly:
    ```bash
    ./bin/duckbrain help
    ```
    
    Verify:
    - bin/duckbrain has shebang (#!/usr/bin/env node)
    - bin/duckbrain is executable (chmod +x)
    - package.json bin field points to correct path
  </action>
  <verify>
    <automated>test -x bin/duckbrain && echo "✓ Executable" || echo "✗ Not executable"</automated>
  </verify>
  <done>package.json bin configured, CLI accessible via ./bin/duckbrain or bun link</done>
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
