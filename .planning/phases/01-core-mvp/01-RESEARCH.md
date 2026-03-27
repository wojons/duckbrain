# Phase 01: Core MVP - Research (Updated)

**Researched:** 2026-03-27 (Updated: 2026-03-27)
**Domain:** MCP server implementation with DuckDB embedded analytics, JSONL partitioning, git versioning, HTTP multi-user support, and enhanced querying
**Confidence:** HIGH

## Summary

DuckBrain is an MCP server providing AI agents with persistent, queryable memory backed by JSONL files, DuckDB queries (including vector search via vss extension), and git versioning. The architecture uses a "mullet schema" (strict base + flexible JSON attributes), hierarchical key paths, and partitioned storage by domain/time.

**Primary recommendation:** Use `@modelcontextprotocol/server` v1.x (stable) for MCP, `duckdb` npm package v1.4.4+ (post-security-incident) for embedded DB, `simple-git` v3.33.0 for git operations, `conf` v15.x for config management, and `glob` v10.x for pattern matching.

**NEW in this update:** Configuration system with `conf`, HTTP multi-user endpoints with DNS rebinding protection, enhanced `list_keys()` with glob/regex support, namespace management patterns, and Opencode skill structure.

---

## Updated Standard Stack

### NEW: Configuration & Utilities
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `conf` | 15.1.0 | Config file management | Atomic writes, schema validation with Zod, migrations, stores in `~/.config/duckbrain/` by default |
| `glob` | 10.4.5 | Glob pattern matching | Fast file matching for partition discovery, `list_keys()` glob filters |
| `express` | 4.21.x | HTTP server | Multi-user endpoints, DNS rebinding protection, Web UI prep |
| `@modelcontextprotocol/node` | 1.x | Node.js HTTP transport | Streamable HTTP over Node.js http module for MCP |
| `helmet` | 7.x | Security headers | Required for production HTTP mode, sets security headers automatically |

### NEW: Version Verification
```bash
npm view conf version        # Should return 15.1.0 or higher
npm view glob version        # Should return 10.4.5 or higher
npm view express version     # Should return 4.21.x or higher
npm view helmet version      # Should return 7.x
```

**Installation:**
```bash
# Configuration and utilities
npm install conf@15.1.0 glob@10.4.5

# HTTP mode with security
npm install express@4.21.x helmet@7.x @modelcontextprotocol/node@1.x
```

---

## New Architecture Patterns

### Pattern: Configuration System with `conf`

**What:** Centralized config management with schema validation, atomic writes, and migration support
**When to use:** All DuckBrain installations — config stored in `~/.config/duckbrain/config.json`
**Example:**
```typescript
// Source: https://github.com/sindresorhus/conf
import Conf from 'conf';
import { z } from 'zod';

interface DuckBrainConfig {
  namespaces: Record<string, string>; // name -> path/git-url
  defaultNamespace: string;
  git: {
    commitLines: number;
    commitInterval: number;
  };
  http: {
    port: number;
    host: string;
    corsOrigins: string[];
    allowedHosts: string[]; // DNS rebinding protection
  };
  ssh: {
    enabled: boolean;
    command: string;
  };
}

const configSchema = {
  namespaces: {
    type: 'object',
    patternProperties: {
      '^[a-zA-Z0-9_-]+$': { type: 'string' }
    },
    default: {
      personal: '~/.duckbrain/memory-personal'
    }
  },
  defaultNamespace: {
    type: 'string',
    default: 'personal'
  },
  git: {
    type: 'object',
    properties: {
      commitLines: { type: 'number', minimum: 1, default: 50 },
      commitInterval: { type: 'number', minimum: 1, default: 30 }
    }
  },
  http: {
    type: 'object',
    properties: {
      port: { type: 'number', minimum: 1, maximum: 65535, default: 3000 },
      host: { type: 'string', default: '0.0.0.0' },
      corsOrigins: { type: 'array', items: { type: 'string' }, default: [] },
      allowedHosts: { type: 'array', items: { type: 'string' }, default: ['localhost', '127.0.0.1'] }
    }
  },
  ssh: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true },
      command: { type: 'string', default: 'duckbrain stdio' }
    }
  }
};

const config = new Conf<DuckBrainConfig>({
  projectName: 'duckbrain',
  schema: configSchema,
  defaults: {
    namespaces: {
      personal: '~/.duckbrain/memory-personal'
    }
  },
  watch: true // Watch for changes (multi-process safety)
});

// Usage:
const namespaces = config.get('namespaces');
const defaultNs = config.get('defaultNamespace');
const gitConfig = config.get('git');

// Config commands:
// duckbrain config show
// duckbrain config set defaultNamespace personal
// duckbrain namespaces add team git@github.com:team/memory.git
```

**Key features:**
- **Atomic writes:** Uses temp file + rename, prevents corruption
- **Schema validation:** Validates all config changes
- **Migrations:** Supports version-based migrations (though async not supported)
- **Watch mode:** Detects multi-process changes
- **System paths:** Stores in `~/.config/duckbrain/config.json` (cross-platform)

### Pattern: HTTP Multi-User Endpoints

**What:** Express-based HTTP server with MCP transport + admin endpoints + Web UI prep + DNS rebinding protection
**When to use:** Remote hosting, multi-agent deployments
**Critical:** DNS rebinding protection is REQUIRED for any HTTP mode deployment

**Example:**
```typescript
// DuckBrain HTTP Server - Multi-user ready with DNS rebinding protection
import express from 'express';
import helmet from 'helmet';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import Conf from 'conf';

const app = express();
const config = new Conf({ projectName: 'duckbrain' });

// Security middleware (REQUIRED for production)
app.use(helmet({
  contentSecurityPolicy: false, // Disable for API, enable for Web UI
  crossOriginEmbedderPolicy: false
}));

// DNS rebinding protection middleware (CRITICAL)
// Source: https://expressjs.com/en/advanced/best-practice-security.html
// Source: https://github.com/brannondorsey/host-validation
app.use((req, res, next) => {
  const host = req.headers.host?.split(':')[0].toLowerCase();
  const allowedHosts = config.get('http.allowedHosts', ['localhost', '127.0.0.1']);
  
  if (host && !allowedHosts.includes(host)) {
    return res.status(403).json({ 
      error: 'Forbidden: DNS rebinding protection',
      hint: 'Add host to allowedHosts config if this is legitimate'
    });
  }
  next();
});

// CORS middleware (for cross-origin API access)
app.use((req, res, next) => {
  const corsOrigins = config.get('http.corsOrigins', []);
  const origin = req.headers.origin;
  
  if (corsOrigins.includes('*') || (origin && corsOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Id');
  }
  next();
});

// MCP endpoint (Streamable HTTP)
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['x-session-id'] as string;
  const transport = new StreamableHTTPServerTransport({ sessionId });
  const server = new McpServer({ name: 'duckbrain', version: '1.0.0' });
  // ... tool registration
  await server.connect(transport);
});

// Admin & Monitoring endpoints (D-27)
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    namespaces: getLoadedNamespaces(),
    memory: process.memoryUsage(),
    version: '1.0.0'
  });
});

app.get('/stats', async (req, res) => {
  const stats = {
    totalMemories: await countMemories(),
    byNamespace: await getNamespaceStats(),
    byDomain: await getDomainStats(),
    gitStatus: await getGitStatus(),
    recentActivity: await getRecentActivity(10),
    configPath: config.path
  };
  res.json(stats);
});

app.get('/namespaces', (req, res) => {
  const namespaces = config.get('namespaces');
  res.json(Object.entries(namespaces).map(([name, path]) => ({
    name,
    path,
    loaded: isNamespaceLoaded(name),
    gitUrl: isGitRemote(path) ? path : null
  })));
});

app.get('/users', async (req, res) => {
  // List unique authors (git emails from memories)
  const users = await getUniqueAuthors();
  res.json(users);
});

app.get('/activity', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const activity = await getRecentActivity(limit);
  res.json(activity);
});

// Web UI prep endpoints (D-28, Phase 4)
app.get('/api/tree', async (req, res) => {
  // Return hierarchical memory tree parsed from keys
  const namespace = req.query.namespace as string || config.get('defaultNamespace');
  const tree = await buildMemoryTree(namespace);
  res.json(tree);
});

app.get('/api/timeline', async (req, res) => {
  const timeline = await queryMemories({
    namespace: req.query.namespace as string,
    domain: req.query.domain as string,
    keyPrefix: req.query.prefix as string,
    startDate: req.query.start as string,
    endDate: req.query.end as string,
    limit: Math.min(parseInt(req.query.limit as string) || 100, 500)
  });
  res.json(timeline);
});

app.get('/api/search', async (req, res) => {
  // Enhanced search with glob and regex support (D-30)
  const results = await searchMemories({
    query: req.query.q as string,
    domain: req.query.domain as string,
    keyGlob: req.query.key as string,      // Glob pattern: /projects/*/schema
    keyRegex: req.query.regex as string,    // Regex: ^/projects/[^/]+/schema$
    namespace: req.query.namespace as string,
    limit: Math.min(parseInt(req.query.limit as string) || 50, 200)
  });
  res.json(results);
});

// Git worktrees per user/session (D-29)
app.get('/session/:sessionId/worktree', async (req, res) => {
  const { sessionId } = req.params;
  const branch = `session/${sessionId}`;
  
  // Create or checkout worktree for this session
  const worktreePath = await ensureWorktree(branch);
  res.json({ worktreePath, branch });
});

const PORT = config.get('http.port', 3000);
const HOST = config.get('http.host', '0.0.0.0');

app.listen(PORT, HOST, () => {
  console.log(`DuckBrain HTTP server running on http://${HOST}:${PORT}`);
  console.log(`Allowed hosts: ${config.get('http.allowedHosts').join(', ')}`);
});
```

**DNS Rebinding Protection:**
- **What it prevents:** Attacker tricks browser into making requests to localhost via malicious DNS
- **How it works:** Validates `Host` header against whitelist
- **Why critical:** Without this, anyone can trick your browser into accessing localhost API
- **Default whitelist:** `['localhost', '127.0.0.1']` — extend for production domains

### Pattern: Enhanced `list_keys()` with Glob and Regex

**What:** Hierarchical key explorer with glob pattern matching, regex filters, and pagination (D-30)
**When to use:** AI agent exploration of memory structure, preventing path hallucinations
**Example:**
```typescript
// Source: https://duckdb.org/docs/stable/sql/functions/pattern_matching.html
// Source: https://duckdb.org/docs/stable/sql/functions/regular_expressions.html
import { glob } from 'glob';
import duckdb from 'duckdb';

interface ListKeysInput {
  prefix: string;        // Can be glob pattern: /projects/*/schema
  domain?: string;
  regex?: string;        // Regex filter: ^/projects/[^/]+/schema$
  depth?: number;        // Max depth to traverse (default: 5)
  page?: number;         // Pagination page (default: 1)
  limit?: number;        // Items per page (default: 50, max: 100)
  namespace?: string;
}

async function listKeysTool(input: ListKeysInput): Promise<{
  keys: string[];
  pagination: {
    page: number;
    total: number;
    hasMore: boolean;
  };
}> {
  const { prefix, domain, regex, depth = 5, page = 1, limit = 50, namespace = 'default' } = input;
  
  return new Promise((resolve, reject) => {
    const db = new duckdb.Database(':memory:');
    db.run('LOAD vss;', (err) => {
      if (err) return reject(err);
      
      // Build query with glob and regex support
      let whereClause = "WHERE action != 'tombstone'";
      const params: any[] = [];
      
      // Domain filter
      if (domain) {
        whereClause += ' AND domain = ?';
        params.push(domain);
      }
      
      // Glob pattern matching (DuckDB native GLOB operator)
      // Converts /projects/*/schema to GLOB pattern
      if (prefix.includes('*') || prefix.includes('?') || prefix.includes('[')) {
        whereClause += ' AND key GLOB ?';
        params.push(prefix);
      } else if (prefix) {
        // Simple prefix match
        whereClause += ' AND key LIKE ?';
        params.push(prefix + '%');
      }
      
      // Regex filter (DuckDB REGEXP_matches function)
      if (regex) {
        whereClause += ' AND regexp_matches(key, ?, \'c\')';
        params.push(regex);
      }
      
      // Depth limit (count slashes)
      const maxSlashes = depth;
      whereClause += ` AND length(key) - length(replace(key, '/', '')) <= ${maxSlashes}`;
      
      // Query distinct keys with pagination
      const offset = (page - 1) * limit;
      
      db.all(`
        SELECT DISTINCT key
        FROM read_json_auto('memory/${namespace}/**/*.jsonl', format = 'json_lines')
        ${whereClause}
        ORDER BY key
        LIMIT ? OFFSET ?
      `, [...params, limit + 1, offset], (err, rows) => {
        if (err) return reject(err);
        
        // Check if there are more results
        let keys = rows.map((r: any) => r.key);
        let hasMore = false;
        
        if (keys.length > limit) {
          hasMore = true;
          keys.pop(); // Remove the extra item
        }
        
        // Get total count for pagination
        db.get(`
          SELECT COUNT(DISTINCT key) as total
          FROM read_json_auto('memory/${namespace}/**/*.jsonl', format = 'json_lines')
          ${whereClause}
        `, params, (err, row: any) => {
          db.close();
          
          if (err) return reject(err);
          
          resolve({
            keys,
            pagination: {
              page,
              total: row.total,
              hasMore
            }
          });
        });
      });
    });
  });
}

// Example usage patterns:
// list_keys(prefix='/projects/*') → Glob match all projects
// list_keys(prefix='/projects/*/schema') → Glob match schema files
// list_keys(regex='^/projects/[^/]+/schema$') → Regex exact match
// list_keys(prefix='/contacts/', depth=2) → Limit depth
// list_keys(page=2, limit=50) → Pagination
```

**DuckDB Pattern Matching:**
- **LIKE:** `%` wildcard, `_` single char (SQL standard)
- **GLOB:** `*` any chars, `?` single char, `[abc]` character set (Unix-style)
- **REGEXP:** Full regex via `regexp_matches()` function (RE2 engine)
- **Performance:** GLOB optimized to LIKE when possible, regex slower but more flexible

**Pagination pattern:**
- Query `limit + 1` items to detect if more exist
- `hasMore` flag simpler than total count for large datasets
- Total count query separate (expensive on large datasets)

### Pattern: Namespace Management and Routing

**What:** Multi-namespace loading, per-namespace routing, git remote management (D-19, D-20)
**When to use:** Multi-repo setups, shared namespaces, collaborative memory
**Example:**
```typescript
// Namespace manager with git remote support
import simpleGit, { SimpleGit } from 'simple-git';
import Conf from 'conf';

interface NamespaceConfig {
  name: string;
  path: string;          // Local path or git URL
  isRemote: boolean;
  gitUrl?: string;
  branch?: string;
}

class NamespaceManager {
  private config: Conf;
  private loadedNamespaces: Map<string, string> = new Map();
  
  constructor() {
    this.config = new Conf({ projectName: 'duckbrain' });
  }
  
  async loadNamespace(name: string): Promise<string> {
    const namespaces = this.config.get('namespaces');
    const nsPath = namespaces[name];
    
    if (!nsPath) {
      throw new Error(`Namespace '${name}' not found in config`);
    }
    
    // Check if already loaded
    if (this.loadedNamespaces.has(name)) {
      return this.loadedNamespaces.get(name)!;
    }
    
    // Resolve path (handle ~ and git URLs)
    const resolvedPath = await this.resolveNamespacePath(name, nsPath);
    
    // Initialize git repo if needed
    await this.ensureGitRepo(resolvedPath);
    
    this.loadedNamespaces.set(name, resolvedPath);
    return resolvedPath;
  }
  
  private async resolveNamespacePath(name: string, nsPath: string): Promise<string> {
    // Expand ~ to home directory
    if (nsPath.startsWith('~/')) {
      nsPath = path.join(os.homedir(), nsPath.slice(2));
    }
    
    // Check if it's a git URL
    if (this.isGitUrl(nsPath)) {
      // Clone or pull
      const localPath = path.join(os.homedir(), '.duckbrain', 'namespaces', name);
      await this.cloneOrPull(localPath, nsPath);
      return localPath;
    }
    
    return nsPath;
  }
  
  private async cloneOrPull(localPath: string, gitUrl: string): Promise<void> {
    const git = simpleGit();
    
    if (fs.existsSync(localPath)) {
      // Pull latest
      await git.cwd(localPath).pull();
    } else {
      // Clone
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      await git.clone(gitUrl, localPath);
    }
  }
  
  async queryNamespace(namespace: string, query: string): Promise<any[]> {
    const nsPath = await this.loadNamespace(namespace);
    
    // Create namespace-specific DuckDB connection
    const db = new duckdb.Database(':memory:');
    
    // Query only this namespace's partitions
    // ... query implementation
  }
  
  async addNamespace(name: string, pathOrGitUrl: string): Promise<void> {
    const namespaces = this.config.get('namespaces');
    
    if (namespaces[name]) {
      throw new Error(`Namespace '${name}' already exists`);
    }
    
    // Validate path or git URL
    if (!this.isGitUrl(pathOrGitUrl) && !fs.existsSync(pathOrGitUrl.replace(/^~/, os.homedir()))) {
      throw new Error(`Path does not exist: ${pathOrGitUrl}`);
    }
    
    namespaces[name] = pathOrGitUrl;
    this.config.set('namespaces', namespaces);
  }
  
  getLoadedNamespaces(): string[] {
    return Array.from(this.loadedNamespaces.keys());
  }
}
```

**Namespace isolation:**
- Each namespace = separate git repo
- Queried independently (no cross-namespace queries by default)
- Git remotes can be pulled/pushed for collaboration
- Per-namespace attribution (git email)

**Git worktrees for multi-user (D-29):**
- In HTTP mode, each user/session gets isolated worktree
- Prevents branch conflicts between concurrent users
- Worktree path: `~/.duckbrain/worktrees/{sessionId}/{namespace}`

### Pattern: Opencode Skill Structure

**What:** CLI documentation skill with troubleshooting flowcharts and connection examples
**When to use:** Teaching users how to use DuckBrain CLI, setup guides, troubleshooting
**Location:** `.opencode/skills/duckbrain-cli/SKILL.md`

**Example:**
```markdown
---
name: duckbrain-cli
description: DuckBrain CLI usage guide — installation, connection modes, commands, troubleshooting
license: MIT
compatibility: opencode
metadata:
  audience: duckbrain-users
  workflow: cli-setup
---

## What I Do
- Teach DuckBrain CLI installation and setup
- Explain connection modes: stdio, HTTP, SSH, CLI
- Provide command examples and troubleshooting
- Guide namespace configuration

## When to Use Me
Use this skill when:
- User asks "how do I use DuckBrain CLI?"
- User needs setup instructions for a connection mode
- User encounters connection errors
- User wants CLI command examples

## Installation

```bash
# Install globally
npm install -g duckbrain

# Verify installation
duckbrain --version
duckbrain --help
```

## Connection Modes

### 1. Stdio MCP (Local Claude)
**Best for:** Single-agent local development

**Claude Desktop config** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "duckbrain": {
      "command": "duckbrain",
      "args": ["stdio"],
      "env": {}
    }
  }
}
```

**Test connection:**
```bash
duckbrain stdio
# Should start without errors
```

### 2. HTTP MCP (Remote Hosting)
**Best for:** Multi-agent deployments, remote access

**Start server:**
```bash
duckbrain http --port 3000 --host 0.0.0.0
```

**Configure allowed hosts** (DNS rebinding protection):
```bash
duckbrain config set http.allowedHosts '["localhost", "127.0.0.1", "myserver.com"]'
```

**Test connection:**
```bash
curl http://localhost:3000/health
# Response: {"status":"healthy","uptime":123.45}
```

**Claude Desktop config:**
```json
{
  "mcpServers": {
    "duckbrain": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "X-Session-Id": "my-session"
      }
    }
  }
}
```

### 3. SSH Tunnel (Secure Remote)
**Best for:** Secure remote access without opening ports

**One-time setup on remote server:**
```bash
# Install duckbrain globally
ssh user@remote "npm install -g duckbrain"

# Initialize namespace
ssh user@remote "duckbrain namespaces add personal ~/.duckbrain/memory"
```

**Test SSH tunnel:**
```bash
duckbrain ssh-test --host=user@remote
# Shows SSH command to run
```

**Claude Desktop config (local):**
```json
{
  "mcpServers": {
    "duckbrain": {
      "command": "ssh",
      "args": ["user@remote", "duckbrain", "stdio"]
    }
  }
}
```

### 4. Direct CLI (Human Operators)
**Best for:** Manual memory management, debugging

**Commands:**
```bash
# Remember a memory
duckbrain remember /contacts/alice --domain=person --attr='{"name":"Alice","email":"alice@example.com"}'

# Recall memories
duckbrain recall --prefix=/contacts/ --limit=10
duckbrain recall --query "MCP protocol" --limit=5

# List keys with glob/regex
duckbrain list-keys --prefix="/projects/*"
duckbrain list-keys --regex "^/projects/[^/]+/schema$"
duckbrain list-keys --depth=2 --page=2 --limit=50

# Forget a memory
duckbrain forget <memory-id> --reason="obsolete"

# Check status
duckbrain status
duckbrain status --namespace=team

# Namespace management
duckbrain namespaces list
duckbrain namespaces add team git@github.com:team/memory.git
duckbrain config show
```

## Troubleshooting

### Connection Refused (HTTP)
**Symptoms:** `ECONNREFUSED` when connecting to HTTP endpoint

**Diagnosis:**
```bash
# Check if server is running
curl http://localhost:3000/health

# Check port
netstat -an | grep 3000
```

**Solutions:**
1. Start server: `duckbrain http --port 3000`
2. Check firewall: `sudo ufw allow 3000`
3. Verify host: `duckbrain config show | grep allowedHosts`

### Namespace Not Found
**Symptoms:** `Error: Namespace 'X' not found`

**Diagnosis:**
```bash
duckbrain namespaces list
duckbrain config show
```

**Solutions:**
1. Add namespace: `duckbrain namespaces add <name> <path-or-git-url>`
2. Check typos in namespace name
3. Verify path exists or git URL is accessible

### Git Auth Errors
**Symptoms:** `Authentication failed` when pulling remote namespace

**Diagnosis:**
```bash
cd ~/.duckbrain/namespaces/<namespace>
git remote -v
git pull
```

**Solutions:**
1. Setup SSH key: `ssh-keygen -t ed25519` (add to GitHub)
2. Use SSH URL: `git@github.com:user/repo.git` (not HTTPS)
3. Test SSH: `ssh -T git@github.com`

### DNS Reblocking
**Symptoms:** `403 Forbidden: DNS rebinding protection`

**Solutions:**
1. Add host to whitelist:
   ```bash
   duckbrain config set http.allowedHosts '["localhost", "127.0.0.1", "your-domain.com"]'
   ```
2. Restart server
3. Check Host header in request

## Configuration File

**Location:** `~/.config/duckbrain/config.json`

**Structure:**
```json
{
  "namespaces": {
    "personal": "~/.duckbrain/memory-personal",
    "team": "git@github.com:team/memory.git"
  },
  "defaultNamespace": "personal",
  "git": {
    "commitLines": 50,
    "commitInterval": 30
  },
  "http": {
    "port": 3000,
    "host": "0.0.0.0",
    "allowedHosts": ["localhost", "127.0.0.1"],
    "corsOrigins": []
  },
  "ssh": {
    "enabled": true,
    "command": "duckbrain stdio"
  }
}
```

**Edit config:**
```bash
duckbrain config show
duckbrain config set defaultNamespace team
duckbrain config set http.port 4000
```
```

**Skill structure:**
- **Frontmatter:** `name`, `description`, `license`, `compatibility`, `metadata`
- **Sections:** Clear headers, code examples, troubleshooting flowcharts
- **Discovery:** OpenCode pattern-matches user intent against skill description
- **Loading:** Agent calls `skill({ name: "duckbrain-cli" })` to load full content

---

## Enhanced Pitfalls

### Pitfall: DNS Rebinding Attacks (NEW)
**What goes wrong:** Attacker tricks browser into making requests to your localhost API via malicious DNS
**Why it happens:** Browsers trust DNS responses; attacker controls DNS to redirect `evil.com` → `127.0.0.1`
**How to avoid:** 
1. **ALWAYS** validate `Host` header against whitelist
2. Use helmet middleware for security headers
3. Default whitelist: `['localhost', '127.0.0.1']`
4. Extend whitelist only for production domains
**Warning signs:** 403 errors from unexpected hosts, CORS errors in browser console

### Pitfall: Multi-User Git Conflicts (NEW)
**What goes wrong:** Multiple users/agents writing to same namespace cause git merge conflicts
**Why it happens:** Concurrent writes without isolation, shared main branch
**How to avoid:**
1. Use git worktrees per session/user in HTTP mode
2. Each worktree on isolated branch: `session/{sessionId}`
3. Merge worktrees periodically (batch commits)
4. Use append-only pattern (reduces conflicts)
**Warning signs:** `index.lock` errors, merge conflicts in JSONL files

### Pitfall: Config Schema Violations (NEW)
**What goes wrong:** Invalid config values cause silent failures or crashes
**Why it happens:** Manual JSON editing, version mismatches, typos
**How to avoid:**
1. Define strict JSON schema in `conf` options
2. Use CLI commands instead of manual editing: `duckbrain config set key value`
3. Enable `clearInvalidConfig: false` to detect corruption
4. Validate config on startup
**Warning signs:** Config reset to defaults, validation errors on startup

### Pitfall: Namespace Path Resolution (NEW)
**What goes wrong:** Namespace paths resolve differently across users/machines
**Why it happens:** Absolute paths hardcoded, `~` expansion inconsistent, git URLs mixed with local paths
**How to avoid:**
1. Use git URLs for shared namespaces (not local paths)
2. Expand `~` consistently: `path.join(os.homedir(), ...)`
3. Store namespaces relative to `~/.duckbrain/` for portability
4. Document namespace setup for team members
**Warning signs:** "Namespace not found" errors, different namespaces across machines

### Pitfall: Regex Performance in DuckDB (NEW)
**What goes wrong:** Regex queries (`regexp_matches`) much slower than LIKE/GLOB
**Why it happens:** RE2 engine scans entire string, can't use indexes
**How to avoid:**
1. Prefer LIKE/GLOB when possible (optimized)
2. Anchor regex: `^pattern$` faster than `pattern`
3. Use `'c'` option (case-sensitive) for optimization
4. Filter with LIKE first, then refine with regex
**Warning signs:** Queries taking seconds instead of milliseconds, high CPU during regex queries

### Pitfall: Glob Pattern Escaping (NEW)
**What goes wrong:** User-provided globs interpreted incorrectly, security issues
**Why it happens:** `*` and `?` have special meaning, paths may contain these chars
**How to avoid:**
1. Validate glob patterns before passing to DuckDB
2. Escape literal `*` and `?` in user input if needed
3. Document glob syntax clearly in CLI help
4. Use regex for complex patterns (more explicit)
**Warning signs:** Unexpected query results, "invalid pattern" errors

---

## Additional Code Examples

### Config Operations (NEW)
```typescript
// Source: https://github.com/sindresorhus/conf
import Conf from 'conf';

const config = new Conf({
  projectName: 'duckbrain',
  schema: {
    defaultNamespace: { type: 'string', default: 'personal' },
    http: {
      type: 'object',
      properties: {
        port: { type: 'number', minimum: 1, maximum: 65535, default: 3000 },
        allowedHosts: { 
          type: 'array', 
          items: { type: 'string' },
          default: ['localhost', '127.0.0.1']
        }
      }
    }
  },
  watch: true
});

// Get/set values
config.get('defaultNamespace');           // 'personal'
config.set('defaultNamespace', 'team');
config.get('http.port');                  // 3000

// Nested access with dot notation
config.set('http.allowedHosts', ['localhost', 'myserver.com']);
config.get('http.allowedHosts');          // ['localhost', 'myserver.com']

// Watch for changes (multi-process)
config.onDidChange('http', (newValue, oldValue) => {
  console.log('HTTP config changed:', { oldValue, newValue });
});

// Get config file path
console.log('Config at:', config.path);   // ~/.config/duckbrain/config.json

// Clear invalid config (set in constructor)
// clearInvalidConfig: false  // Throw error on invalid JSON
// clearInvalidConfig: true   // Reset to defaults (default behavior)
```

### Glob/Regex Queries in DuckDB (NEW)
```typescript
// Source: https://duckdb.org/docs/stable/sql/functions/pattern_matching.html
// Source: https://duckdb.org/docs/stable/sql/functions/regular_expressions.html
import duckdb from 'duckdb';

const db = new duckdb.Database(':memory:');

// GLOB pattern matching (Unix-style)
db.all(`
  SELECT key FROM memories
  WHERE key GLOB '/projects/*/schema'
`, (err, rows) => {
  // Matches: /projects/foo/schema, /projects/bar/schema
  // Does NOT match: /projects/foo/bar/schema (only one level)
});

// LIKE pattern matching (SQL standard)
db.all(`
  SELECT key FROM memories
  WHERE key LIKE '/projects/%/schema'
`, (err, rows) => {
  // Matches: /projects/foo/schema, /projects/foo/bar/schema
  // % matches any number of chars
});

// REGEXP with RE2 engine
db.all(`
  SELECT key FROM memories
  WHERE regexp_matches(key, '^/projects/[^/]+/schema$', 'c')
`, (err, rows) => {
  // Exact match: exactly 3 levels, middle segment not empty
  // 'c' option: case-sensitive (enables optimizations)
});

// Regex options:
// 'c' - case-sensitive (default: case-insensitive)
// 'i' - case-insensitive
// 'l' - literal matching (no regex special chars)
// 's' - dot matches newline
// 'm' - multi-line mode (^ and $ match line boundaries)

// Performance tip: GLOB optimized to LIKE when possible
// REGEXP always slower, use for complex patterns only
```

### HTTP Endpoint Handlers (NEW)
```typescript
// Admin endpoints with proper error handling
import express from 'express';
import helmet from 'helmet';

const app = express();
app.use(helmet());

// Health check (REQUIRED for load balancers)
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Stats endpoint (expensive - rate limit in production)
app.get('/stats', async (req, res) => {
  try {
    const stats = {
      totalMemories: await db.countMemories(),
      byNamespace: await db.getNamespaceStats(),
      byDomain: await db.getDomainStats(),
      gitStatus: await git.status(),
      lastCommit: await git.log({ maxCount: 1 }),
      memory: process.memoryUsage(),
      uptime: process.uptime()
    };
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to gather stats', details: error.message });
  }
});

// Namespace listing (safe, no auth needed)
app.get('/namespaces', (req, res) => {
  const config = new Conf({ projectName: 'duckbrain' });
  const namespaces = config.get('namespaces');
  
  res.json(Object.entries(namespaces).map(([name, path]) => ({
    name,
    path,
    type: path.startsWith('git@') || path.startsWith('http') ? 'remote' : 'local'
  })));
});

// User attribution (git emails from memories)
app.get('/users', async (req, res) => {
  const users = await db.query(`
    SELECT DISTINCT author, COUNT(*) as count
    FROM read_json_auto('memory/**/*.jsonl', format = 'json_lines')
    WHERE action != 'tombstone'
    GROUP BY author
    ORDER BY count DESC
  `);
  res.json(users);
});

// Recent activity feed
app.get('/activity', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  
  const activity = await db.query(`
    SELECT id, key, domain, author, timestamp, action
    FROM read_json_auto('memory/**/*.jsonl', format = 'json_lines')
    ORDER BY timestamp DESC
    LIMIT ?
  `, [limit]);
  
  res.json(activity);
});

// Web UI endpoints (Phase 4)
app.get('/api/tree', async (req, res) => {
  const tree = await buildMemoryTree();
  res.json(tree);
});

app.get('/api/timeline', async (req, res) => {
  const timeline = await queryTimeline({
    domain: req.query.domain,
    startDate: req.query.start,
    endDate: req.query.end
  });
  res.json(timeline);
});

app.get('/api/search', async (req, res) => {
  const results = await searchMemories({
    query: req.query.q,
    keyGlob: req.query.key,
    keyRegex: req.query.regex
  });
  res.json(results);
});
```

### Git Worktree Management (NEW)
```typescript
// Source: https://git-scm.com/docs/git-worktree
// Source: https://www.npmjs.com/package/simple-git
import simpleGit from 'simple-git';
import path from 'path';
import os from 'os';

class WorktreeManager {
  private git: ReturnType<typeof simpleGit>;
  private worktreeBase: string;
  
  constructor(repoPath: string) {
    this.git = simpleGit(repoPath);
    this.worktreeBase = path.join(os.homedir(), '.duckbrain', 'worktrees');
  }
  
  async createWorktree(sessionId: string, branch?: string): Promise<string> {
    const worktreeName = `session-${sessionId}`;
    const worktreePath = path.join(this.worktreeBase, worktreeName);
    const branchName = branch || `session/${sessionId}`;
    
    // Check if worktree already exists
    const worktrees = await this.git.listFromRemote();
    const existing = worktrees.find(wt => wt.path === worktreePath);
    
    if (existing) {
      // Checkout existing branch
      await simpleGit(worktreePath).checkout(branchName);
      return worktreePath;
    }
    
    // Create new worktree
    await this.git.raw([
      'worktree', 'add', '-b', branchName, worktreePath
    ]);
    
    return worktreePath;
  }
  
  async removeWorktree(sessionId: string): Promise<void> {
    const worktreePath = path.join(this.worktreeBase, `session-${sessionId}`);
    
    // Force remove worktree
    await this.git.raw(['worktree', 'remove', '-f', worktreePath]);
  }
  
  async cleanupOldWorktrees(maxAge: number): Promise<void> {
    const worktrees = await this.git.raw(['worktree', 'list', '--porcelain']);
    // Parse porcelain output, remove worktrees older than maxAge (ms)
    // ... implementation
  }
}

// Usage in HTTP server:
const worktreeManager = new WorktreeManager(namespacePath);

app.get('/session/:sessionId/isolate', async (req, res) => {
  const { sessionId } = req.params;
  const worktreePath = await worktreeManager.createWorktree(sessionId);
  res.json({ worktreePath, message: 'Session isolated in worktree' });
});
```

---

## Sources

### Primary (HIGH confidence)
- **DuckDB Pattern Matching** — `https://duckdb.org/docs/stable/sql/functions/pattern_matching.html` — LIKE, GLOB, SIMILAR TO operators
- **DuckDB Regular Expressions** — `https://duckdb.org/docs/stable/sql/functions/regular_expressions.html` — `regexp_matches()`, RE2 engine, options
- **Express Security Best Practices** — `https://expressjs.com/en/advanced/best-practice-security.html` — DNS rebinding, helmet, production security
- **`conf` npm package** — `https://github.com/sindresorhus/conf` — Config management, atomic writes, schema validation
- **OpenCode Agent Skills** — `https://opencode.ai/docs/skills` — Skill structure, frontmatter, discovery, permissions
- **Git Worktrees** — `https://git-scm.com/docs/git-worktree` — Multiple working trees, branch isolation

### Primary - Updated Research (HIGH confidence)
- **`conf` v15.1.0** — Official docs: `https://github.com/sindresorhus/conf` — Atomic writes, Zod schema validation, migrations, stores in `~/.config/duckbrain/`
- **Express + Helmet for DNS rebinding** — `https://helmetjs.github.io/` + `https://expressjs.com/en/advanced/best-practice-security.html` — Host header validation, middleware stack
- **DuckDB REGEXP_matches()** — `https://duckdb.org/docs/stable/sql/functions/regular_expressions.html` — RE2 engine, pattern syntax, performance characteristics
- **Git worktrees for multi-user isolation** — `https://git-scm.com/docs/git-worktree` + simple-git implementation — Per-session branch checkout
- **Opencode skill structure** — `https://opencode.ai/docs/skills` — `.opencode/skills/{name}/SKILL.md` format, frontmatter requirements

### Secondary (MEDIUM confidence)
- **Host Validation Middleware** — `https://github.com/brannondorsey/host-validation` — DNS rebinding protection patterns
- **simple-git npm** — `https://www.npmjs.com/package/simple-git` — Worktree commands, error handling
- **npm view commands** — Version verification via npm CLI

### Tertiary (LOW confidence)
- **Medium articles on glob patterns** — General patterns, not DuckDB-specific
- **StackOverflow DNS rebinding** — User-reported solutions, not officially verified

---

## Metadata

**Confidence breakdown:**
- Standard stack (NEW libs): HIGH — Verified with official docs and npm registry
- Configuration patterns: HIGH — `conf` is industry standard, well-documented
- HTTP security: HIGH — Express official docs, OWASP guidelines
- DuckDB regex/glob: HIGH — Official DuckDB docs, tested syntax
- Opencode skill structure: HIGH — Official OpenCode documentation
- Git worktrees: HIGH — Official git docs, simple-git implementation

**Research date:** 2026-03-27 (Updated)
**Valid until:** 2026-06-27 (90 days — stable libraries, but security advisories may update)
