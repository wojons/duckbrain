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

The user service file is installed at `~/.config/systemd/user/duckbrain.service`:

```ini
[Unit]
Description=DuckBrain MCP Server
After=network.target

[Service]
Type=simple
User=%I
ExecStart=/path/to/duckbrain/bin/duckbrain.js http --port=3000
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
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
