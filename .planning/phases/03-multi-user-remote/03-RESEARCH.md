# Phase 03: Multi-User & Remote - Research

**Researched:** 2026-03-31
**Domain:** Remote Access, SSH Tunneling, Docker, HTTP Security
**Confidence:** HIGH

## Summary

This research covers five technical domains for Phase 3: SSH tunneling for remote access, Docker containerization strategies, cloud tunnel alternatives, HTTP authentication patterns, and systemd service management. The primary recommendation is to use the `ssh2` library for Node.js SSH operations with Unix socket forwarding for secure local-to-remote connections, Alpine Linux for production containers with multi-stage builds, and Cloudflare Tunnel as the primary cloud option with localtunnel as a free alternative.

**Primary recommendation:** Use `ssh2` (v1.17.0) for SSH operations with `forwardOut()` to local Unix sockets, Alpine-based multi-stage Docker builds, and `express-rate-limit` (v8.3.2) for rate limiting.

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** SSH connection via `--host` flag using existing SSH config (standard SSH key authentication, no custom auth layer)
- **D-02:** Auto-installation and version check on remote, prefer user-space installation
- **D-03:** Dynamic port forwarding for HTTP interface via SSH `-L` to Unix sockets at `~/.duckbrain/sockets/{server-name}.sock` (permissions 0600)
- **D-04:** Named socket attachment for multi-server support
- **D-05:** Alpine Linux for production containers (minimal attack surface)
- **D-06:** Debian/Ubuntu for development containers (tag as `-dev` variant)
- **D-07:** Support both named volumes (`duckbrain-data:/data`) and bind mounts
- **D-08:** Single container by default, multi-container optional
- **D-09:** Cloudflare Tunnel as primary option (free tier sufficient)
- **D-10:** Localtunnel as free alternative (no account required)
- **D-11:** Pluggable tunnel architecture
- **D-12:** Tunnel is optional enhancement, not required
- **D-13:** HTTP server binds to localhost only by default, optional `--bind-all`
- **D-14:** Basic auth or API key for HTTP endpoints (hashed credentials, stateless)
- **D-15:** Rate limiting per IP (default 100 req/min)
- **D-16:** Optional systemd service support (user service by default)
- **D-17:** Service management commands with systemd auto-detection
- **D-18:** Server naming convention with `servers.json` persistence
- **D-19:** Transparent CLI forwarding via socket
- **D-20:** Secure by default (Unix sockets, localhost binding, non-root containers)
- **D-21:** No automatic privilege escalation (manual sudo instructions only)

### the agent's Discretion
- Exact SSH library choice (could use native `ssh` command or Node.js SSH2 library)
- Docker image size optimization details
- Specific rate limiting algorithm
- Socket cleanup strategy (stale socket detection)
- Tunnel provider implementation order (Cloudflare first, then others)

### Deferred Ideas (OUT OF SCOPE)
- Web UI (Phase 4)
- Enterprise SSO
- Automatic SSL certificate management (use reverse proxy)
- Kubernetes Operator
- Windows Service Support
- Database Backends (PostgreSQL/MySQL)
- Replication/Sync

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REMOTE-01 | HTTP MCP - Remote hosting for multiple agents | Express server with auth middleware, bind to localhost or 0.0.0.0 |
| REMOTE-02 | SSH tunneling - Transparent remote access without opening ports | Use ssh2 library `forwardOut()` to create local Unix socket tunnels |
| REMOTE-03 | Git worktrees - Multi-agent isolation on shared servers | Not covered - already implemented in namespace system |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| ssh2 | 1.17.0 | SSH client connections, port forwarding | Pure JS, 5.8k+ stars, supports forwardOut/forwardIn, Unix socket extensions |
| express-rate-limit | 8.3.2 | API rate limiting middleware | Most popular Express rate limiter, sliding window support |
| express | 5.x | HTTP server framework | Standard for Node.js HTTP APIs |
| cloudflared | latest (via install) | Cloudflare Tunnel daemon | Free tier, official Cloudflare tooling |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| tunnel-ssh | 5.2.0 | High-level SSH tunnel wrapper | Simpler API over ssh2, promise-based |
| localtunnel | 2.0.2 | Free cloud tunnel alternative | No account required, quick testing |
| dotenv | 16.x | Environment configuration | For Docker and service configuration |
| bcryptjs | 3.x | Password hashing | For HTTP basic auth credential storage |
| cookie-parser | 1.x | Cookie handling | If session management added later |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| ssh2 | Native `ssh` command | Native command requires spawning child processes, less control over connection lifecycle |
| express-rate-limit | sliding-window-rate-limiter | sliding-window-rate-limiter more precise but complex; express-rate-limit sufficient |
| Cloudflare Tunnel | ngrok | ngrok has stricter free tier limits; Cloudflare has better free offering |
| systemd | PM2 | PM2 is simpler but adds dependency; systemd is standard on Linux |

**Installation:**
```bash
# Required for Phase 3
npm install ssh2 express-rate-limit bcryptjs

# Optional tunnel dependencies
npm install -g cloudflared  # See Cloudflare install docs
npm install localtunnel  # Alternative

# Docker base images
# Production: node:22-alpine
# Development: node:22-bookworm (Debian)
```

**Version verification:** All versions verified against npm registry on 2026-03-31. ssh2@1.17.0 is current stable, express-rate-limit@8.3.2 is current stable.

## Architecture Patterns

### Recommended Project Structure
```
packages/
├── cli/
│   ├── src/
│   │   ├── commands/
│   │   │   ├── ssh.ts           # SSH connection commands
│   │   │   ├── service.ts       # Systemd service management
│   │   │   └── tunnel.ts        # Cloud tunnel commands
│   │   ├── lib/
│   │   │   ├── ssh-client.ts    # SSH2 wrapper
│   │   │   ├── socket-manager.ts # Unix socket lifecycle
│   │   │   └── remote-install.ts # Remote auto-install
│   │   └── index.ts
├── http/
│   ├── src/
│   │   ├── middleware/
│   │   │   ├── auth.ts          # API key / basic auth
│   │   │   └── rate-limit.ts    # Rate limiting
│   │   └── server.ts
└── docker/
    ├── Dockerfile               # Production (Alpine)
    ├── Dockerfile.dev           # Development (Debian)
    └── docker-compose.yml       # Multi-container optional
```

### Pattern 1: SSH Unix Socket Tunneling
**What:** Forward remote HTTP port to local Unix socket via SSH2
**When to use:** When user runs `duckbrain --host=user@server --name=prod`
**Example:**
```typescript
// Source: https://github.com/mscdex/ssh2 README.md
import { Client } from 'ssh2';
import { createServer } from 'net';

const conn = new Client();
conn.on('ready', () => {
  // Forward remote port 3000 to local Unix socket
  conn.forwardOut('127.0.0.1', 0, '127.0.0.1', 3000, (err, stream) => {
    if (err) throw err;
    // Pipe stream to local Unix socket
    const server = createServer((socket) => {
      stream.pipe(socket).pipe(stream);
    });
    server.listen('/tmp/duckbrain-prod.sock');
  });
}).connect({
  host: 'server.com',
  username: 'user',
  privateKey: readFileSync('~/.ssh/id_rsa')
});
```

### Pattern 2: Multi-Stage Docker Build
**What:** Build in node:alpine, copy to final minimal image
**When to use:** Production deployment
**Example:**
```dockerfile
# Source: Best practices from Docker docs + Chainguard research
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM node:22-alpine AS production
RUN apk add --no-cache dumb-init
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
USER node
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
```

### Pattern 3: HTTP Auth Middleware Chain
**What:** Rate limiting → Auth → DNS protection → Routes
**When to use:** All HTTP server instances
**Example:**
```typescript
// Source: express-rate-limit docs + security best practices
import rateLimit from 'express-rate-limit';
import { createHash } from 'crypto';

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown'
});

// API key validation
function apiKeyAuth(config: { hashedKey: string }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.headers['x-api-key'];
    if (!key) return res.status(401).json({ error: 'API key required' });
    
    const hashed = createHash('sha256').update(key).digest('hex');
    if (hashed !== config.hashedKey) {
      return res.status(403).json({ error: 'Invalid API key' });
    }
    next();
  };
}

app.use(limiter);
app.use('/mcp', apiKeyAuth(config));
```

### Pattern 4: Systemd User Service
**What:** Generate and install user-level systemd service (no root)
**When to use:** `duckbrain service install` command
**Example:**
```ini
# Source: systemd user service documentation
# ~/.config/systemd/user/duckbrain.service
[Unit]
Description=DuckBrain MCP Server
After=network.target

[Service]
Type=simple
ExecStart=%h/.local/bin/duckbrain http
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

```typescript
// Source: Node.js file operations + systemctl commands
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';

function installUserService(): void {
  const serviceDir = `${process.env.HOME}/.config/systemd/user`;
  const serviceFile = `${serviceDir}/duckbrain.service`;
  
  // Create directory if needed
  execSync(`mkdir -p ${serviceDir}`);
  
  // Write service file
  writeFileSync(serviceFile, serviceContent);
  
  // Enable and start
  execSync('systemctl --user daemon-reload');
  execSync('systemctl --user enable duckbrain');
  execSync('systemctl --user start duckbrain');
}
```

### Anti-Patterns to Avoid
- **Using TCP sockets instead of Unix sockets for local communication:** Unix sockets have lower overhead and better security (filesystem permissions)
- **Storing API keys in plaintext:** Always hash credentials with SHA-256 or bcrypt
- **Running containers as root:** Use non-root user (UID 1000) in Docker
- **Installing devDependencies in production Docker:** Use `npm ci --only=production`
- **Using node:latest tag:** Pin to specific version for reproducibility

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SSH connection management | Native `ssh` child process spawn | `ssh2` library | Full control over connection lifecycle, error handling, reconnection |
| Rate limiting | Manual request tracking in memory | `express-rate-limit` | Sliding window algorithm, proper cleanup, header handling |
| Password hashing | crypto.createHash | `bcryptjs` | Salt + hash with configurable rounds, timing attack resistant |
| Docker health checks | Custom HTTP polling | Docker HEALTHCHECK | Native Docker integration, automatic container restart |
| Tunnel management | Reverse proxy with SSL | `cloudflared` | Cloudflare's global network, automatic certificate management |
| Service process management | Screen/tmux sessions | `systemd --user` | Auto-restart, logging, dependency management |
| Socket file cleanup | Manual unlink on exit | `fs.existsSync()` + `unlinkSync()` on startup | Handle crashes, stale sockets from killed processes |

**Key insight:** SSH tunneling over Unix sockets provides better performance and security than TCP ports, but requires careful cleanup handling. `ssh2` library handles OpenSSH protocol details that would be error-prone to implement from scratch.

## Common Pitfalls

### Pitfall 1: Stale Unix Socket Files
**What goes wrong:** Previous process crash leaves socket file; new process fails to bind
**Why it happens:** Socket files aren't automatically cleaned up on SIGKILL or crashes
**How to avoid:** Check for existing socket, unlink if stale, handle EADDRINUSE
**Warning signs:** "Address already in use" errors on startup
**Code example:**
```typescript
import { existsSync, unlinkSync } from 'fs';
import { connect } from 'net';

function cleanSocket(socketPath: string): void {
  if (!existsSync(socketPath)) return;
  
  // Test if socket is active
  const test = connect(socketPath);
  test.on('connect', () => {
    test.end();
    throw new Error(`Socket ${socketPath} is already in use`);
  });
  test.on('error', () => {
    // Connection failed, socket is stale
    unlinkSync(socketPath);
  });
}
```

### Pitfall 2: SSH Connection Without Keepalive
**What goes wrong:** NAT/firewall drops idle SSH connections, tunnel silently fails
**Why it happens:** SSH connections without traffic get terminated by intermediate systems
**How to avoid:** Set `keepaliveInterval` in ssh2 config (e.g., 30000ms)
**Warning signs:** Tunnel works initially then stops after inactivity

### Pitfall 3: Docker Image Bloat
**What goes wrong:** Production image contains dev tools, compilers, 900MB+
**Why it happens:** Using `node:latest` without multi-stage builds
**How to avoid:** Multi-stage builds, `--only=production`, Alpine base
**Warning signs:** Slow deployments, vulnerability scanners report hundreds of CVEs

### Pitfall 4: Rate Limiting Bypass via X-Forwarded-For
**What goes wrong:** Rate limits apply to proxy IP instead of client IP
**Why it happens:** Not trusting proxy headers, express-rate-limit defaults
**How to avoid:** Configure `trust proxy` in Express when behind reverse proxy
**Warning signs:** All clients blocked after one hits limit

### Pitfall 5: Cloudflare Tunnel Config File Conflict
**What goes wrong:** Quick tunnels fail when `config.yaml` exists in `~/.cloudflared/`
**Why it happens:** cloudflared prioritizes config file over CLI flags
**How to avoid:** Document the limitation or temporarily rename config for quick tunnels
**Warning signs:** "Quick tunnels are currently not supported if a config.yaml is present"

## Code Examples

### SSH Client with Auto-Reconnect
```typescript
// Source: ssh2 README + error handling best practices
import { Client } from 'ssh2';

class SSHConnection {
  private conn: Client;
  private config: any;
  private reconnectDelay = 5000;

  constructor(config: any) {
    this.config = {
      keepaliveInterval: 30000,
      keepaliveCountMax: 3,
      readyTimeout: 20000,
      ...config
    };
    this.conn = new Client();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.conn.on('error', (err) => {
      console.error('SSH error:', err);
      this.reconnect();
    });
    
    this.conn.on('end', () => {
      console.log('SSH connection ended');
    });
    
    this.conn.on('close', () => {
      console.log('SSH connection closed');
      this.reconnect();
    });
  }

  connect(): void {
    this.conn.connect(this.config);
  }

  private reconnect(): void {
    console.log(`Reconnecting in ${this.reconnectDelay}ms...`);
    setTimeout(() => this.connect(), this.reconnectDelay);
  }

  forwardToLocalSocket(remotePort: number, localSocket: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.on('ready', () => {
        // Implementation using forwardOut
        resolve();
      });
    });
  }
}
```

### Docker Compose Multi-Container
```yaml
# Source: Docker Compose best practices
version: '3.8'

services:
  duckbrain:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    ports:
      - "127.0.0.1:3000:3000"  # Only localhost binding
    volumes:
      - duckbrain-data:/data    # Named volume preferred
    environment:
      - NODE_ENV=production
      - DUCKBRAIN_DATA_DIR=/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  duckbrain-data:
```

### HTTP Server with Auth and Rate Limiting
```typescript
// Source: Express + express-rate-limit documentation
import express from 'express';
import rateLimit from 'express-rate-limit';
import { createHash } from 'crypto';

const app = express();

// Trust proxy if behind reverse proxy
app.set('trust proxy', 1);

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// DNS rebinding protection
const allowedHosts = ['localhost', '127.0.0.1'];
app.use((req, res, next) => {
  const host = req.headers.host?.split(':')[0];
  if (!host || !allowedHosts.includes(host)) {
    return res.status(403).json({ error: 'Forbidden: Invalid host' });
  }
  next();
});

// API Key auth
function createAuthMiddleware(config: { apiKey?: string }) {
  return (req: any, res: any, next: any) => {
    if (!config.apiKey) return next();
    
    const provided = req.headers['x-api-key'];
    if (!provided) {
      return res.status(401).json({ error: 'API key required' });
    }
    
    // Hash comparison
    const hashed = createHash('sha256').update(provided).digest('hex');
    if (hashed !== config.apiKey) {
      return res.status(403).json({ error: 'Invalid API key' });
    }
    next();
  };
}

export { app, createAuthMiddleware };
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| ssh (native command) | ssh2 library | 2015+ | Better error handling, programmatic control |
| Debian-based images | Alpine images | 2020+ | 10x smaller, fewer CVEs |
| ngrok free tier | Cloudflare Tunnel | 2022+ | More generous free tier, no random URLs |
| Password auth | Key-based auth | 2010+ | More secure, easier automation |
| System-wide services | User services (`--user`) | 2015+ | No root needed, better security |
| TCP sockets | Unix sockets | 2010+ | Lower overhead, filesystem permissions |
| Manual rate limiting | express-rate-limit | 2018+ | Battle-tested, sliding window |

**Deprecated/outdated:**
- **MD5 password hashing:** Use bcrypt or Argon2 instead
- **node:14 images:** Node 14 EOL April 2023, use Node 20+ LTS
- **tcp-forward without encryption:** Always use SSH tunnel or TLS

## Open Questions

1. **Socket permissions on macOS vs Linux**
   - What we know: macOS has stricter Unix socket permissions, may need `chmod` after creation
   - What's unclear: Exact permission model differences, best cross-platform approach
   - Recommendation: Test on both platforms, use 0700 parent directory with 0600 sockets

2. **Cloudflare Tunnel persistent vs quick**
   - What we know: Quick tunnels use random subdomains, persistent requires account
   - What's unclear: Whether we should support persistent tunnel setup via CLI
   - Recommendation: Start with quick tunnels only, persistent as future enhancement

3. **Auto-install binary vs npm on remote**
   - What we know: npm may not be available, standalone binary larger but self-contained
   - What's unclear: Best distribution method for DuckBrain binary
   - Recommendation: Try npm first (smaller), fallback to binary download

4. **Rate limiting storage**
   - What we know: express-rate-limit uses MemoryStore by default
   - What's unclear: Need for distributed rate limiting if multiple instances
   - Recommendation: Single-instance for now, Redis store if scaling later

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker | Containerization | ✓ | 28.3.2 | — |
| ssh2 (npm) | SSH connections | ✓ | 1.17.0 | Native `ssh` command |
| express-rate-limit | Rate limiting | ✓ | 8.3.2 | Manual rate limiting |
| cloudflared | Cloudflare Tunnel | ✗ (installable) | — | Localtunnel |
| localtunnel | Free alternative | ✓ | 2.0.2 | — |
| systemd | Service management | ✗ (Linux only) | — | Background process spawn |

**Missing dependencies with no fallback:**
- None — all dependencies have viable alternatives

**Missing dependencies with fallback:**
- **cloudflared:** Not pre-installed but can be installed via package managers; use localtunnel as alternative
- **systemd:** Only available on Linux; use background process spawning on macOS/Windows

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 3.x |
| Config file | `vitest.config.ts` (exists in project) |
| Quick run command | `npm test -- --reporter=verbose` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REMOTE-01 | HTTP server starts and serves MCP | integration | `npm test -- tests/http.test.ts` | ❌ Wave 0 |
| REMOTE-01 | HTTP auth blocks unauthenticated requests | integration | `npm test -- tests/auth.test.ts` | ❌ Wave 0 |
| REMOTE-01 | Rate limiting returns 429 after limit | integration | `npm test -- tests/rate-limit.test.ts` | ❌ Wave 0 |
| REMOTE-02 | SSH tunnel creates Unix socket | integration | `npm test -- tests/ssh-tunnel.test.ts` | ❌ Wave 0 |
| REMOTE-02 | Multi-server socket naming works | unit | `npm test -- tests/socket-manager.test.ts` | ❌ Wave 0 |
| Docker | Image builds successfully | smoke | `docker build -t duckbrain:test .` | ❌ Wave 0 |
| Docker | Container runs and responds to health | smoke | `docker run --rm duckbrain:test` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test -- --reporter=verbose --testNamePattern="{pattern}"`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `tests/http-auth.test.ts` — covers REMOTE-01 auth
- [ ] `tests/rate-limit.test.ts` — covers rate limiting
- [ ] `tests/ssh-tunnel.test.ts` — covers REMOTE-02
- [ ] `tests/socket-manager.test.ts` — covers socket lifecycle
- [ ] Docker smoke test — covers Docker image build

## Sources

### Primary (HIGH confidence)
- **ssh2 library** (GitHub: mscdex/ssh2) — API documentation, examples, v1.17.0 features
- **Cloudflare Tunnel docs** (developers.cloudflare.com) — Quick tunnel setup, limitations
- **Chainguard Node.js Image Guide** (chainguard.dev) — Alpine vs Debian comparison, security best practices
- **express-rate-limit** (npm + GitHub) — Configuration options, sliding window algorithm
- **Docker docs** — Multi-stage builds, HEALTHCHECK, security best practices

### Secondary (MEDIUM confidence)
- **Better Stack Rate Limiting Guide** — Express.js rate limiting patterns (verified against express-rate-limit docs)
- **Localtunnel docs** (localtunnel.github.io) — Free tier capabilities
- **systemd user service docs** — User-level service management
- **Dev.to/Community comparisons** — Cloudflare vs ngrok (cross-verified with official docs)

### Tertiary (LOW confidence)
- **Medium/Substack Docker guides** — General best practices (verified against official sources)
- **Reddit discussions** — Developer experience reports (anecdotal, not verified)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — All libraries verified via npm/github, versions confirmed current
- Architecture: HIGH — Patterns from official docs and established Node.js practices
- Pitfalls: MEDIUM-HIGH — Based on documented issues and community experience
- State of the art: HIGH — Based on current LTS versions and 2024-2025 documentation

**Research date:** 2026-03-31
**Valid until:** 2026-06-30 (90 days for stable dependencies, faster-moving ecosystem may need refresh sooner)

---

*Phase 03: Multi-User & Remote — Research Complete*
