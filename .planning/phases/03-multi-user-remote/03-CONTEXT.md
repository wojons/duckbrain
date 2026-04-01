# Phase 03: Multi-User & Remote - Context

**Gathered:** 2026-03-31
**Status:** Ready for planning

<domain>
## Phase Boundary

Enable remote access to DuckBrain instances via SSH tunneling, containerized deployment, and optional cloud tunnels. Support multiple simultaneous server connections via named Unix sockets. Provide secure-by-default configurations while allowing flexible deployment options (single/multi-container, bind mounts, named volumes).

This phase does NOT include: Web UI (Phase 4), enterprise SSO (future), automatic SSL certificate management (use reverse proxy).
</domain>

<decisions>
## Implementation Decisions

### SSH Access Method
- **D-01:** SSH connection via `--host` flag using existing SSH config
  - CLI syntax: `duckbrain --host=user@server` reads from `~/.ssh/config`
  - Falls back to command-line host specification if not in config
  - Uses standard SSH key authentication (no custom auth layer)
- **D-02:** Auto-installation and version check on remote
  - SSH in, check if DuckBrain installed and up-to-date
  - Auto-install via package manager or standalone binary if missing/outdated
  - Prefer user-space installation (`~/.local/bin`) over system-wide
- **D-03:** Dynamic port forwarding for HTTP interface
  - Use SSH `-L` (local forward) to tunnel remote HTTP port to local Unix socket
  - Unix socket path: `~/.duckbrain/sockets/{server-name}.sock`
  - Socket permissions: user-only (0600) for security
- **D-04:** Named socket attachment for multi-server support
  - Running `duckbrain --socket={name}` connects to existing Unix socket
  - Multiple concurrent connections to different servers via different socket names
  - Socket discovery: list available sockets in `~/.duckbrain/sockets/`

### Docker Deployment
- **D-05:** Alpine Linux for production containers
  - Secure-by-default, minimal attack surface
  - Multi-stage builds: build in node:alpine, copy to final alpine image
- **D-06:** Debian/Ubuntu for development containers
  - Easy package installation for debugging and extensions
  - Tag as `-dev` variant
- **D-07:** Support both named volumes and bind mounts
  - Named volumes (preferred): `duckbrain-data:/data` — Docker managed
  - Bind mounts (dev): `./local-data:/data` — host directory
  - Volume permissions: run as non-root user (UID 1000)
- **D-08:** Single container by default, multi-container optional
  - Default: DuckBrain + DuckDB in one container (simplest)
  - Optional: Separate DuckDB container for resource isolation
  - Compose file for multi-container setup

### Cloud Tunnels
- **D-09:** Provide Cloudflare Tunnel as primary option
  - Free tier sufficient for most use cases
  - Command: `duckbrain tunnel --provider=cloudflare`
  - Auto-generate tunnel config, print `cloudflared` command to run
- **D-10:** Support localtunnel as free alternative
  - No account required, quick testing
  - Command: `duckbrain tunnel --provider=localtunnel`
- **D-11:** Pluggable tunnel architecture
  - Interface for adding new providers (ngrok, tailscale, etc.)
  - Users can bring their own tunnel (just need public URL)
- **D-12:** Tunnel is optional enhancement, not required
  - SSH tunneling works without any cloud service
  - Tunnels only needed for internet-facing without SSH

### HTTP Server & Auth
- **D-13:** HTTP server enhancements for remote use
  - Bind to localhost only by default (127.0.0.1) — tunneled access only
  - Optional: bind to 0.0.0.0 with `--bind-all` (user assumes risk)
- **D-14:** Basic auth or API key for HTTP endpoints
  - Configurable via `duckbrain config set auth.type=basic|apikey`
  - Store hashed credentials in config (not plaintext)
  - No session management — stateless auth only
- **D-15:** Rate limiting per IP
  - Default: 100 requests/minute per IP
  - Configurable via `--rate-limit` flag

### Systemd Service
- **D-16:** Optional systemd service support
  - Generate service file: `duckbrain service install`
  - Install to `~/.config/systemd/user/` (user service, no root)
  - Optional system-wide with `--system` flag (requires root)
- **D-17:** Service management commands
  - `duckbrain service start|stop|restart|status`
  - Auto-detect if systemd available, fallback to background process

### Multi-Server Workflow
- **D-18:** Server naming convention
  - Each remote server gets a name: `duckbrain --host=user@server --name=production`
  - Name used for socket file: `~/.duckbrain/sockets/{name}.sock`
  - Config persistence: `~/.duckbrain/servers.json` maps names to hosts
- **D-19:** Transparent CLI forwarding
  - Local CLI commands forwarded to remote via socket
  - Same CLI interface regardless of local vs remote
  - Batch operations supported (queue commands, execute over SSH)

### Security Defaults
- **D-20:** Secure by default, flexible if needed
  - Unix sockets over TCP when possible
  - Localhost binding only unless explicitly overridden
  - Non-root container execution
  - Minimal production image (Alpine)
- **D-21:** No automatic privilege escalation
  - If remote install needs sudo, print command for user to run manually
  - Never store sudo passwords

### the agent's Discretion
- Exact SSH library choice (could use native `ssh` command or Node.js SSH2 library)
- Docker image size optimization details
- Specific rate limiting algorithm
- Socket cleanup strategy (stale socket detection)
- Tunnel provider implementation order (Cloudflare first, then others)
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### SSH & Tunneling
- `src/cli/human.ts` lines 588-610 — Existing `ssh-test` command implementation
- `.planning/phases/01-core-mvp/01-CONTEXT.md` lines 49-54 — Prior SSH tunneling decision (D-22)
- `.planning/phases/01-core-mvp/01-RESEARCH.md` lines 663-678 — SSH tunnel pattern research

### HTTP Server
- `src/cli/http.ts` — Existing HTTP server implementation (DNS rebinding protection, health endpoints)
- `.planning/phases/01-core-mvp/01-CONTEXT.md` lines 58-62 — Prior HTTP multi-user decisions (D-23-D-24)

### Docker
- `.planning/phases/02-git-automation/02-CONTEXT.md` lines 112-121 — Git worktrees and Phase 3 context

### Requirements
- `.planning/REQUIREMENTS.md` lines 46-49 — Remote Access requirements (REMOTE-01, REMOTE-02)
- `.planning/REQUIREMENTS.md` lines 90-92 — CLI and remote requirements status

### Prior Research
- `.planning/phases/01-core-mvp/01-RESEARCH.md` lines 630-678 — HTTP MCP and SSH tunnel patterns
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/cli/human.ts:sshTestCommand()` — Base SSH testing logic to extend
- `src/cli/http.ts:createHttpServer()` — HTTP server factory (add auth middleware)
- `src/git/remote.ts` — Existing remote operations (git remote add/remove)
- `duckbrain-http.pid` file creation in `src/cli/http.ts` — Pattern for socket file management

### Established Patterns
- **CLI Pattern:** Commands in `src/cli/human.ts` with flag parsing via `parseArgs()`
- **Config Pattern:** JSON config in `.duckbrain/config.json` with get/set CLI commands
- **Namespace Pattern:** Git-backed namespaces in `namespaces/` directory
- **Error Handling:** Friendly error messages with usage examples (established in Phase 2)

### Integration Points
- **SSH Integration:** Extend existing `ssh-test` command to full `ssh-connect` with socket forwarding
- **HTTP Integration:** Add auth middleware to existing Express server (pre-auth endpoints: /health only)
- **Config Integration:** Add `servers` and `tunnels` sections to existing config schema
- **CLI Integration:** New flags `--host`, `--socket`, `--tunnel` in existing CLI router (bin/duckbrain.ts)
</code_context>

<specifics>
## Specific Ideas

### SSH Workflow
1. User runs: `duckbrain --host=user@myserver.com --name=prod`
2. DuckBrain SSHs to server, checks/installs itself, starts HTTP server
3. Creates SSH tunnel forwarding remote port to local Unix socket: `~/.duckbrain/sockets/prod.sock`
4. User then runs: `duckbrain --socket=prod` to connect via socket
5. All CLI commands transparently forwarded to remote instance

### Docker Usage
```bash
# Single container, named volume
docker run -v duckbrain-data:/data -p 127.0.0.1:3000:3000 duckbrain

# Development with bind mount
docker run -v $(pwd)/data:/data -p 127.0.0.1:3000:3000 duckbrain:dev
```

### Multi-Server Example
```bash
# Connect to two servers simultaneously
duckbrain --host=dev@server1 --name=dev &
duckbrain --host=prod@server2 --name=prod &

# Use specific server
duckbrain --socket=dev recall --domain=concept
duckbrain --socket=prod remember --key=/test --domain=raw_note
```

### Cloudflare Tunnel
```bash
# Quick tunnel setup
duckbrain tunnel --provider=cloudflare
# Output: Run: cloudflared tunnel --url http://localhost:3000
# Or: Generated config at ~/.cloudflared/config.yml
```

</specifics>

<deferred>
## Deferred Ideas

### Out of Scope for Phase 3
- **Web UI** — Phase 4 (full React/Next.js interface)
- **Enterprise SSO** — Future phase (Google/GitHub OAuth integration)
- **Automatic SSL** — Use reverse proxy (nginx, traefik, caddy)
- **Kubernetes Operator** — Future if demand exists (complex orchestration)
- **Windows Service Support** — Focus on Unix/Linux first (systemd)
- **Database Backends** — DuckDB only for now (no PostgreSQL/MySQL support)
- **Replication/Sync** — Multi-master sync between servers (complex distributed systems)

### Reviewed from Prior Phases
- Git worktrees for HTTP mode — deferred to Phase 3.1 if needed (Phase 2 CONTEXT line 121)
- Multi-user attribution enhancements — Phase 3.1 (Phase 2 CONTEXT line 120)

### Future Tunnel Providers
- ngrok (paid features)
- Tailscale (mesh networking)
- Zrok (open source alternative)
- Rathole (Rust tunnel, high performance)
- localhost.run (simplest, no install)

</deferred>

---

*Phase: 03-multi-user-remote*
*Context gathered: 2026-03-31*
