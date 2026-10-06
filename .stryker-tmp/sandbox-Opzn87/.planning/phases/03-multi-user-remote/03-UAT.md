---
status: complete
phase: 03-multi-user-remote
source: [03-01-SUMMARY.md, 03-02-SUMMARY.md, 03-03-SUMMARY.md, 03-04-SUMMARY.md]
started: 2026-04-01T06:56:00Z
updated: 2026-04-01T07:10:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: Kill any running DuckBrain HTTP server process. Clear temp state. Start server fresh with `npx tsx bin/duckbrain.ts http --port=9876`. Server boots without errors, prints startup message, and curl /health returns 200 with valid JSON.
result: pass

### 2. Docker Image Build
expected: `docker build -t duckbrain:test .` completes successfully without errors.
result: pass

### 3. Docker Container Run + Health Check
expected: Container starts, runs as non-root (uid=1000), PID file written to /tmp, curl /health returns 200.
result: pass

### 4. Docker Compose Up
expected: `docker compose up -d` starts the DuckBrain service. Named volume created. Binds to localhost only (127.0.0.1:3000). curl /health returns 200. Health check passes.
result: pass

### 5. HTTP Basic Auth
expected: Server with --auth=basic. Unauthenticated → 401. Correct credentials → 200. Wrong credentials → 401.
result: pass

### 6. API Key Auth
expected: Server with --auth=apikey. No header → 401. Correct key → 200. Wrong key → 401.
result: pass

### 7. Rate Limiting
expected: Server with --rate-limit=5. 5 requests succeed. 6th returns 429 with Retry-After header.
result: pass

### 8. SSH Connect Command
expected: SSH connection to remote host works. DuckBrain installation check succeeds. Clear error on unreachable host.
result: pass

### 9. SSH Tunnel + Unix Socket + Remote CLI
expected: SSH tunnel creates Unix socket at ~/.duckbrain/sockets/{name}.sock with 0600 permissions. `duckbrain --socket=name <command>` works through tunnel.
result: issue
reported: "--socket flag was not parsed at top level in bin/duckbrain.ts — caused 'Unknown command' error. Also the /cli endpoint was missing from HTTP server. Both fixed during testing."
severity: major

### 10. Servers Command (Named Connections)
expected: servers add/list/remove all work correctly, persisting to ~/.duckbrain/servers.json.
result: pass

### 11. Bind-All Flag
expected: Server with --bind-all binds to 0.0.0.0. Without it, binds to 127.0.0.1 only.
result: pass

### 12. Docker Dev Image
expected: `docker build -f Dockerfile.dev` succeeds. Dev image includes curl, vim, htop, git. Container starts with tsx --watch, curl /health returns 200.
result: pass

## Summary

total: 12
passed: 11
issues: 1
pending: 0
skipped: 0
blocked: 0

## Gaps

- truth: "duckbrain --socket=<name> <command> executes CLI commands on remote DuckBrain via Unix socket tunnel"
  status: fixed_during_test
  reason: "Two bugs found: (1) --socket flag not parsed at top level in bin/duckbrain.ts, caused 'Unknown command' error. (2) HTTP server missing /cli endpoint for remote command execution."
  severity: major
  test: 9
  root_cause: "--socket flag only handled inside runHumanCLI() after command routing, not before. And createHttpServer() had no POST /cli route."
  artifacts:
    - path: "bin/duckbrain.ts"
      issue: "Added --socket flag extraction before command routing, added runRemoteCLI() function"
    - path: "src/cli/http.ts"
      issue: "Added POST /cli endpoint that executes duckbrain commands via execFile"
    - path: "Dockerfile.dev"
      issue: "Fixed CMD from --bind=0.0.0.0 to --bind-all"
    - path: "docker-compose.yml"
      issue: "Fixed health check URL from / to /health"
  missing: []
  fix_applied: true
