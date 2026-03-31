---
phase: 03-multi-user-remote
plan: 01
subsystem: ssh
tags: [ssh, tunnel, unix-socket, remote-access, cli]

# Dependency graph
requires:
  - phase: 01-core-mvp
    provides: CLI infrastructure, parseArgs pattern, command routing
provides:
  - SSH client module with config parsing, connection, and remote install
  - SSH tunnel module with Unix socket forwarding and lifecycle management
  - CLI commands for ssh-connect, socket forwarding, and server management
affects: [03-multi-user-remote, cli]

# Tech tracking
tech-stack:
  added: []
  patterns: [ssh-tunnel, unix-socket, pid-sidecar, servers-json-config]

key-files:
  created:
    - src/ssh/client.ts
    - src/ssh/client.test.ts
    - src/ssh/tunnel.ts
    - src/ssh/tunnel.test.ts
  modified:
    - src/cli/human.ts
    - bin/duckbrain.ts

key-decisions:
  - "Used native ssh command via child_process instead of Node.js SSH2 library for maximum compatibility"
  - "Socket files stored at ~/.duckbrain/sockets/{name}.sock with 0600 permissions"
  - "PID stored in sidecar .pid files for tunnel lifecycle management"
  - "No auto-sudo escalation — prints sudo command for user (D-21)"
  - "servers.json for named connection persistence"

patterns-established:
  - "SSH tunnel pattern: spawn ssh -L socket:localhost:port host -N"
  - "Sidecar file pattern: .pid and .host files alongside .sock for metadata"
  - "User-space install preference: ~/.local/bin over system-wide"

requirements-completed: [REMOTE-02, REMOTE-03]

# Metrics
duration: 17min
completed: 2026-03-31
---

# Phase 3 Plan 1: SSH Tunneling Summary

**SSH tunneling with Unix socket forwarding, remote install checking, and multi-server named connections**

## Performance

- **Duration:** 17 min
- **Started:** 2026-03-31T10:22:46Z
- **Completed:** 2026-03-31T10:40:10Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments
- SSH client module with config parsing from ~/.ssh/config, remote version checking, and user-space installation
- SSH tunnel module creating Unix socket forwarding with 0600 permissions and PID sidecar management
- CLI integration with ssh-connect, socket forwarding, and servers commands

## Task Commits

Each task was committed atomically:

1. **Task 1: Create SSH client module** - `fd293d7` (test), `0808a83` (feat)
2. **Task 2: Create SSH tunnel module** - `b7d2576` (test), `7bf26eb` (feat)
3. **Task 3: Wire SSH commands to CLI** - `36cfdd8` (feat)

_Note: TDD tasks have multiple commits (test → feat)_

## Files Created/Modified
- `src/ssh/client.ts` - SSH connection, config parsing, remote install checking (exports: connectToRemote, checkRemoteInstall, installRemote, parseSSHConfig)
- `src/ssh/client.test.ts` - 11 tests for SSH client module
- `src/ssh/tunnel.ts` - SSH tunnel with Unix socket forwarding (exports: createTunnel, closeTunnel, listTunnels)
- `src/ssh/tunnel.test.ts` - 8 tests for SSH tunnel module
- `src/cli/human.ts` - Added ssh-connect, socket-connect, servers commands
- `bin/duckbrain.ts` - Added ssh-connect and servers to command router

## Decisions Made
- Used native `ssh` command via `child_process` instead of Node.js SSH2 library for maximum compatibility and zero dependencies
- Socket files at `~/.duckbrain/sockets/{name}.sock` with 0600 permissions for security (D-20)
- PID stored in sidecar `.pid` files alongside `.host` metadata files for tunnel lifecycle management
- `servers.json` at `~/.duckbrain/servers.json` for named connection persistence (D-18)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed stdout type mismatch in checkRemoteInstall**
- **Found during:** Task 1 (GREEN phase)
- **Issue:** `spawnSync` with `encoding: 'utf-8'` returns string `stdout`, but mock returns Buffer, causing `.trim()` to fail
- **Fix:** Wrapped `versionResult.stdout` in `String()` to handle both Buffer and string return types
- **Files modified:** src/ssh/client.ts
- **Verification:** All 11 client tests pass
- **Committed in:** 0808a83 (Task 1 GREEN commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Minimal — defensive type handling for test compatibility.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- SSH tunneling infrastructure complete, ready for Plan 02 (HTTP server enhancements, auth middleware)
- CLI supports full ssh-connect workflow: connect → check/install → tunnel → socket forwarding
- Servers command enables persistent named connections

---
*Phase: 03-multi-user-remote*
*Completed: 2026-03-31*

## Self-Check: PASSED

- [x] src/ssh/client.ts exists
- [x] src/ssh/client.test.ts exists
- [x] src/ssh/tunnel.ts exists
- [x] src/ssh/tunnel.test.ts exists
- [x] 4 commits found with grep "03-01": fd293d7, 0808a83, b7d2576, 7bf26eb, 36cfdd8
