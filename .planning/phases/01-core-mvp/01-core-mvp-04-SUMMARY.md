---
phase: 01-core-mvp
plan: 04
subsystem: cli
tags: mcp, cli, typescript, stdio, http, express

# Dependency graph
requires:
  - phase: 01-core-mvp
    provides: MCP server with stdio transport, tool implementations
provides:
  - Stdio MCP entry point for local Claude Desktop integration
  - HTTP MCP server with DNS rebinding protection
  - Human operator CLI commands (remember, recall, list-keys, forget, etc.)
  - CLI executable with command routing
  - Opencode skill documentation
  - package.json bin configuration
affects:
  - 02-core-mvp-01 (Git automation)
  - 02-core-mvp-02 (Embedding integration)
  - 03-multi-user-remote (SSH tunneling, HTTP enhancements)

# Tech tracking
tech-stack:
  added:
    - "tsx@^4.21.0"
  patterns:
    - TypeScript CLI with tsx runtime loader
    - Command routing pattern with switch/case dispatch
    - DNS rebinding protection middleware for HTTP server
    - Wrapper script pattern for TypeScript CLI executables

key-files:
  created:
    - src/cli/stdio.ts
    - src/cli/http.ts
    - src/cli/human.ts
    - bin/duckbrain.js
    - bin/duckbrain.ts
    - .opencode/agents/duckbrain-cli.md
  modified:
    - package.json

key-decisions:
  - Used tsx wrapper pattern for CLI executable to avoid compilation step
  - Moved tsx from devDependencies to dependencies for runtime TypeScript execution
  - Implemented DNS rebinding protection in HTTP middleware
  - Separated stdio (local) and HTTP (remote) modes for different deployment scenarios
  - Created comprehensive Opencode skill for CLI documentation

patterns-established:
  - "CLI Mode Pattern: stdio for local Claude, HTTP for remote, SSH for secure tunneling"
  - "Command Routing: Central dispatcher in bin/duckbrain.ts routes to mode handlers"
  - "Human CLI Pattern: runHumanCLI() abstracts tool calls with friendly formatting"

requirements-completed: [CLI-01, CLI-02]

# Metrics
duration: 15 min
completed: 2026-03-27
---

# Phase 01: Core MVP Plan 04 Summary

**CLI entry points for stdio MCP and human operators with command routing and documentation**

## Performance

- **Duration:** 15 min
- **Started:** 2026-03-27T16:14:00Z
- **Completed:** 2026-03-27T16:28:54Z
- **Tasks:** 6
- **Files modified:** 9

## Accomplishments

- Stdio MCP entry point working with local Claude Desktop integration
- HTTP MCP server with Streamable HTTP transport and DNS rebinding protection
- Human CLI commands (remember, recall, list-keys, forget, config, namespaces, status, ssh-test)
- CLI executable with command routing and help message
- Opencode skill published with comprehensive documentation
- package.json bin configured for global installation

## Task Commits

Each task was committed atomically:

1. **Task 1: Create stdio MCP entry point** - `28bc0b0` (feat)
   - src/cli/stdio.ts: startStdioMode() with graceful shutdown
   - src/cli/stdio.test.ts: Tests for exports and function signature

2. **Task 2: Create HTTP MCP server** - `9fde979` (feat)
   - src/cli/http.ts: startHttpMode() and createHttpServer()
   - DNS rebinding protection, admin endpoints, Streamable HTTP transport
   - src/cli/http.test.ts: Tests for exports

3. **Task 3: Create human CLI commands** - `2c9e6af` (feat)
   - src/cli/human.ts: runHumanCLI() with 10 command handlers
   - Argument parsing, human-readable output formatting
   - src/cli/human.test.ts: Tests for command handling

4. **Task 4: Create CLI executable** - `5957fe0` (feat)
   - bin/duckbrain: Main entry point with shebang
   - Command routing to stdio, http, and human CLI modes
   - src/cli/cli-executable.test.ts: Tests for file existence

5. **Task 5: Create Opencode skill** - `29e2701` (docs)
   - .opencode/agents/duckbrain-cli.md: 475 lines of documentation
   - Installation, connection modes, command reference, troubleshooting

6. **Task 6: Configure package.json bin** - `60bb8d1` (chore)
   - package.json: Added bin field, moved tsx to dependencies
   - bin/duckbrain.js: Wrapper script for tsx runtime
   - bin/duckbrain.ts: TypeScript CLI implementation

**Plan metadata:** Pending final commit

## Files Created/Modified

### Created
- `src/cli/stdio.ts` - Stdio MCP entry point with StdioServerTransport
- `src/cli/http.ts` - HTTP server with StreamableHTTPServerTransport and admin endpoints
- `src/cli/human.ts` - Human operator CLI with 10 command handlers
- `src/cli/stdio.test.ts` - Tests for stdio mode
- `src/cli/http.test.ts` - Tests for HTTP server
- `src/cli/human.test.ts` - Tests for human CLI
- `src/cli/cli-executable.test.ts` - Tests for CLI executable
- `bin/duckbrain.js` - JavaScript wrapper for tsx runtime
- `bin/duckbrain.ts` - TypeScript CLI implementation
- `.opencode/agents/duckbrain-cli.md` - Comprehensive CLI documentation

### Modified
- `package.json` - Added bin field, moved tsx to dependencies, updated description

## Decisions Made

- **tsx wrapper pattern**: Instead of compiling TypeScript, use tsx/cjs runtime loader in wrapper script
- **DNS rebinding protection**: Added middleware to HTTP server to validate Host header
- **Separate stdio/HTTP modes**: Different transports for local vs remote deployment scenarios
- **Comprehensive Opencode skill**: 475 lines covering all connection modes and troubleshooting

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed import paths in bin/duckbrain.ts**
- **Found during:** Task 4 (CLI executable creation)
- **Issue:** Import paths './cli/stdio.js' failed from bin/ directory
- **Fix:** Changed to '../src/cli/stdio.js' for correct relative path
- **Files modified:** bin/duckbrain.ts
- **Verification:** CLI help command works
- **Committed in:** 5957fe0

**2. [Rule 3 - Blocking] Fixed tsx runtime dependency**
- **Found during:** Task 6 (Global CLI testing)
- **Issue:** tsx was in devDependencies, not available at runtime for global installs
- **Fix:** Moved tsx from devDependencies to dependencies in package.json
- **Files modified:** package.json
- **Verification:** duckbrain help works via npm link
- **Committed in:** 60bb8d1

**3. [Rule 3 - Blocking] Created JS wrapper for TypeScript CLI**
- **Found during:** Task 6 (Global CLI execution)
- **Issue:** Node.js cannot directly execute TypeScript files in global installs
- **Fix:** Created bin/duckbrain.js wrapper that registers tsx/cjs and loads duckbrain.ts
- **Files modified:** bin/duckbrain.js (new), bin/duckbrain.ts (renamed from duckbrain)
- **Verification:** Global duckbrain command works
- **Committed in:** 60bb8d1

---

**Total deviations:** 3 auto-fixed (all blocking issues preventing CLI execution)
**Impact on plan:** All fixes necessary for CLI to work. No scope creep, all functionality as planned.

## Issues Encountered

- **ESM/CJS module confusion**: TypeScript files use ESM imports, but package.json had "type": "commonjs" - resolved by using tsx/cjs loader in wrapper
- **Path resolution in wrapper**: Initial wrapper used relative paths that failed - fixed with path.join(__dirname, ...)
- **File extension consistency**: Renamed duckbrain to duckbrain.ts for clarity and consistent imports

## User Setup Required

None - no external service configuration required. CLI is ready to use after npm install/link.

## Next Phase Readiness

- Stdio mode ready for local Claude Desktop integration
- HTTP mode ready for remote hosting (DNS protection included)
- Human CLI fully functional for manual memory management
- Opencode skill provides comprehensive documentation for users
- package.json bin configured for easy installation
- Ready for Phase 2: Git automation and embedding integration

## Self-Check: PASSED

All files verified to exist on disk. All commits confirmed in git history.

---

*Phase: 01-core-mvp*
*Completed: 2026-03-27*
