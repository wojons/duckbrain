# Deployment Guide

DuckBrain can be deployed in several ways depending on your needs — from a simple local process for a single user to a production service with Docker and systemd.

---

## Docker Deployment

### Building the Image

```bash
# Build from source
docker build -t duckbrain .

# Or use Docker Compose for development
docker-compose -f docker-compose.dev.yml up
```

### Running the Container

```bash
# Basic run with default settings (port 3000)
docker run -p 3000:3000 -v duckbrain-data:/data duckbrain

# Custom port and bind all interfaces
docker run -p 8080:3000 -v duckbrain-data:/data \
  duckbrain http --port=3000 --bind-all
```

The Docker image uses a two-stage build:

1. **Builder stage** — `node:20-slim`, installs dependencies with `npm ci`, copies source
2. **Production stage** — `node:20-slim` with git installed, runs as non-root `node` user

**Key Dockerfile details:**

- Base: `node:20-slim` (Debian-based, provides glibc for DuckDB native bindings)
- Volume: `/data` — persists memory data
- Port: `3000` (exposed)
- User: `node` (non-root, UID 1000)
- Entrypoint: Initializes git repo in `/data`, then runs DuckBrain
- Health check: Every 30s, checks `localhost:3000/`

### Docker Entrypoint

The entrypoint script (`scripts/docker-entrypoint.sh`) automatically:

1. Creates `/data` directory if missing
2. Initializes a git repository in `/data` (if none exists)
3. Configures git user as `DuckBrain Container`
4. Runs the DuckBrain command

### Volumes

| Volume | Container Path | Description |
|--------|---------------|-------------|
| `duckbrain-data` | `/data` | Persistent memory data and git repositories |

### Using Docker Compose

```yaml
services:
  duckbrain:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - duckbrain-data:/data
    environment:
      - DUCKBRAIN_NAMESPACE=default
      - NODE_ENV=production

volumes:
  duckbrain-data:
```

---

## Production Setup with systemd

### User Service (Recommended)

```bash
# Install as user service
node bin/duckbrain.js service install

# Start the service
systemctl --user start duckbrain

# Enable auto-start on login
systemctl --user enable duckbrain

# Check status
systemctl --user status duckbrain
```

### System-Wide Service

```bash
# Install system-wide (requires root)
sudo node bin/duckbrain.js service install --system

# Start and enable
sudo systemctl daemon-reload
sudo systemctl start duckbrain
sudo systemctl enable duckbrain
```

### Hardened Lifecycle Assets (OPS-001): Restart=always + dark-port watchdog

The `service install` template predates the 2026-09-11 incident in which a
graceful SIGTERM exited status 0 and, under `Restart=on-failure`, left
`:3000` dark for ~7 minutes. For production daemons, install the
repo-owned hardened assets from `ops/systemd/` instead — no prose to copy,
just files:

```bash
# From the repo root. Installs as USER units (recommended for dev hosts).
mkdir -p ~/.config/systemd/user
cp ops/systemd/duckbrain-http.service \
   ops/systemd/duckbrain-http-health.service \
   ops/systemd/duckbrain-http-health.timer \
   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now duckbrain-http.service
systemctl --user enable --now duckbrain-http-health.timer
```

What each asset guarantees:

- `duckbrain-http.service` — `Restart=always` (a graceful stop is still
  restarted), `RestartSec=3`, `StartLimitIntervalSec=300` +
  `StartLimitBurst=10` (crash-loop rate limit), `KillSignal=SIGTERM` +
  `TimeoutStopSec=30` (bounded graceful window before SIGKILL). Edit
  `ExecStart` only to change the port or add flags; keep everything else.
- `duckbrain-http-health.service` + `.timer` — probes `/health` every
  minute via `scripts/health-check.js`. **Alive = HTTP 200 or 503** (503
  "degraded" is the intentional embedding-health contract — the daemon
  still serves traffic; GAP-030) → exit 0. **Dark = connection failure or
  any other status** (e.g. a 404 squatter on the port) → exit 1. **Hung =
  the port accepted the connection but `/health` did not answer within
  `--timeout-ms`** → exit 3: the handler is stuck, which is NOT the same as
  a dead daemon (it may still be serving `/api/*` and MCP traffic), so a
  restart-on-dark escalation built on exit 1 must never treat exit 3 as
  dark. `/health` is auth-exempt: the check needs and accepts no API keys.
  Wire the on-failure action into your alerting:

```bash
# Verify the watchdog wiring without touching the daemon:
systemctl --user list-timers duckbrain-http-health.timer
systemctl --user start duckbrain-http-health.service && echo "port alive (200/503)"
journalctl --user -u duckbrain-http-health.service -n 5
```

```bash
# Graceful-SIGTERM restart verification (OPS-001 acceptance probe):
systemctl --user restart duckbrain-http.service
sleep 5
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/health   # expect 200 or 503
systemctl --user show duckbrain-http.service -p NRestarts               # restart counter moved up
```

### Stopping daemons: scoped stop only (OPS-001)

`pnpm stop` no longer pattern-kills. It runs
`scripts/scoped-stop.js`, which SIGTERMs ONLY the single daemon proven by
the port's pidfile (`duckbrain-http-<port>.pid`) to be a live
`duckbrain … http` command for that port. Missing pidfile = safe no-op
(exit 0); stale, malformed, pid-reuse, wrong-command, wrong-port, or
unreadable-argv cases refuse to signal anything and exit nonzero.

```bash
pnpm stop                 # scoped stop of the :3000 instance (SIGTERM only)
pnpm stop --port=4777     # scoped stop of a scratch instance on :4777
pnpm stop --socket=/tmp/duckbrain.sock   # socket-named pidfile (--unix-socket instances)
pnpm stop --json          # machine-readable outcome
pnpm ops:check            # guard: no pkill/killall/pattern kills in package scripts
```

Never stop the Vite/UI dev server with this command — it is scoped to the
HTTP daemon only; stop UI processes from their own terminal.

### Scratch / judge servers: isolation and cleanup contract (OPS-001)

Production uses the systemd unit above. Every scratch or judge daemon MUST:

```bash
# 1. Unique port (never 3000)
node bin/duckbrain.js http --port=4777 &   # e.g. — keep the child PID
SCRATCH_PID=$!

# 2. Isolated auth + config + namespace paths (never the prod store)
export DUCKBRAIN_AUTH_FILE=/tmp/scratch-auth.json      # or --auth-file=…
export DUCKBRAIN_CONFIG_PATH=/tmp/scratch-config.json
export DUCKBRAIN_NAMESPACES_PATH=/tmp/scratch-namespaces

# 3. Terminate ONLY that PID / process group — never broad cleanup
kill $SCRATCH_PID          # SIGTERM to the exact child you spawned
wait $SCRATCH_PID
```

**Forbidden as scratch cleanup: `pnpm stop` and every pkill/killall/pattern
kill.** `pnpm stop` is scoped to ONE pidfile-proven instance — it is not a
bulk tool — and pattern kills match unrelated processes (agents, editors,
other ports' daemons). A scratch daemon on port 4777 is stopped with
`pnpm stop --port=4777` or by killing its own recorded PID.

### Non-systemd Fallback

On systems without systemd, DuckBrain falls back to background process management:

```bash
# Start as background process
node bin/duckbrain.js service start

# Check status
node bin/duckbrain.js service status

# Stop
node bin/duckbrain.js service stop
```

The process PID is stored at `~/.duckbrain/duckbrain.pid` and logs go to `~/.duckbrain/duckbrain.log`.

---

## SSH Tunnel Setup

DuckBrain supports SSH tunnels for securely connecting to remote DuckBrain instances. The tunnel forwards a remote HTTP server port to a local Unix socket.

### Creating a Tunnel

```bash
# Connect to remote DuckBrain via SSH
node bin/duckbrain.js ssh-connect --host=user@server --name=prod
```

This spawns: `ssh -L /path/to/socket:localhost:<port> user@server -N`

Socket files are stored at `~/.duckbrain/sockets/{name}.sock` with permissions `0600` (user-only). A sidecar PID file (`{name}.pid`) allows lifecycle management.

### Using a Tunnel

```bash
# Run CLI commands through the tunnel
node bin/duckbrain.js --socket=prod status

# List active tunnels
node bin/duckbrain.js servers list

# Close a connection
node bin/duckbrain.js ssh-connect --close --name=prod
```

### Tunnel Configuration Details

| Feature | Detail |
|---------|--------|
| Socket path | `~/.duckbrain/sockets/{name}.sock` |
| Permissions | `0600` (user-only) |
| SSH flags | `-N` (no remote command), `ConnectTimeout=10`, `ExitOnForwardFailure=yes`, `StrictHostKeyChecking=accept-new` |
| PID sidecar | `~/.duckbrain/sockets/{name}.pid` |
| Host info sidecar | `~/.duckbrain/sockets/{name}.host` |

### Remote CLI Execution

Once a tunnel is active, the CLI can execute commands by sending JSON-RPC to the local socket:

```bash
# This sends a POST /cli request to the local socket
node bin/duckbrain.js --socket=prod status
```

---

## Reverse Proxy Setup

### Nginx

```nginx
server {
    listen 443 ssl;
    server_name duckbrain.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Caddy

```
duckbrain.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

---

## Environment Variables for Production

| Variable | Production Value | Notes |
|----------|-----------------|-------|
| `NODE_ENV` | `production` | Enables production optimizations |
| `DUCKBRAIN_API_PORT` | `3000` | Port for HTTP API (can be changed) |
| `DUCKBRAIN_NAMESPACE` | set per-project | Active namespace |
| `AUTH_TYPE` | `apikey` or `basic` | Required for public-facing servers |
| `AUTH_TOKEN` | generated token | API key or password |

---

## Security Considerations

### Authentication

For any public-facing or network-accessible deployment, configure authentication:

```bash
node bin/duckbrain.js http --auth=apikey
```

Store API keys in `~/.duckbrain/auth.json` (see [Configuration Reference](configuration)).

### Rate Limiting

Protect against abuse with rate limiting:

```bash
# Allow 60 requests per minute per IP
node bin/duckbrain.js http --rate-limit=60
```

Default: 100 requests/min/IP. Rate limiting is applied before authentication to prevent credential stuffing.

### DNS Rebinding Protection

By default, DuckBrain only accepts connections with `Host` headers matching `localhost` or `127.0.0.1`. To expose the server to other hosts, use `--bind-all`:

```bash
# Expose on all interfaces (use with caution)
node bin/duckbrain.js http --bind-all --port=8080 --auth=apikey
```

### Running as Non-Root

The Docker container runs as the `node` user (UID 1000, non-root). For native deployments, create a dedicated user:

```bash
sudo useradd --system --no-create-home duckbrain
sudo -u duckbrain node bin/duckbrain.js http --port=3000
```

### Firewall

If binding to all interfaces, restrict access at the network level:

```bash
# Allow only specific IPs (example with iptables)
iptables -A INPUT -p tcp --dport 3000 -s 10.0.0.0/8 -j ACCEPT
iptables -A INPUT -p tcp --dport 3000 -j DROP
```

---

## Memory and Storage

### Data Directory

Memories are stored per-namespace:

```
namespaces/
  └── <namespace>/
      ├── .git/
      ├── manifest.json
      └── <domain>/
          └── <YYYY-MM>/
              └── *.jsonl
```

### Backup

Since each namespace is a git repository, backup is straightforward:

```bash
# Backup a namespace
cp -r namespaces/my-project /backup/

# Or use git remote
cd namespaces/my-project
git remote add backup /backup/my-project.git
git push backup --all
```
