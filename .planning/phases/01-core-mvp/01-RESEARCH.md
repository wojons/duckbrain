# Phase 01: Core MVP - Research

**Researched:** 2026-03-27
**Domain:** MCP server implementation with DuckDB embedded analytics, JSONL partitioning, and git versioning
**Confidence:** HIGH

## Summary

DuckBrain is an MCP server providing AI agents with persistent, queryable memory backed by JSONL files, DuckDB queries (including vector search via vss extension), and git versioning. The architecture uses a "mullet schema" (strict base + flexible JSON attributes), hierarchical key paths, and partitioned storage by domain/time.

**Primary recommendation:** Use `@modelcontextprotocol/server` v1.x (stable) for MCP, `duckdb` npm package v1.4.4+ (post-security-incident) for embedded DB, `simple-git` v3.33.0 for git operations, and implement JSONL partitioning with manifest-based DuckDB glob queries.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Three-level hierarchy: `namespace/domain/partition/` — enables clean separation for multi-repo and domain-based organization
- **D-02:** Support both time-based AND key-based partitioning — time-based by default (e.g., `2026-03/`, `2026-W14/`), key-based for categorical grouping (e.g., `projects/`, `contacts/`)
- **D-03:** Files chunked within partition folders — prevents massive files that are hard to parse, size-based splits when files exceed threshold
- **D-04:** Manifest file (`manifest.json`) tracks active partition paths — lightweight index for efficient DuckDB glob queries
- **D-05:** Hybrid response format — success responses include `{success, id, key, partition}` for debugging, full record available on request
- **D-06:** Hierarchical key field uses filesystem-style paths (e.g., `/projects/mcp/schema`, `/contacts/alice`) — enables glob queries and intuitive organization
- **D-07:** `list_keys()` supports prefix filtering, depth limits, and pagination — guardrail tool prevents AI path hallucinations
- **D-08:** Strict base fields: `id` (UUID), `key` (hierarchical path), `domain` (enum), `timestamp` (ISO-8601), `author` (git email), `action` (add/update/tombstone), `embedding_text` (for vectorization)
- **D-09:** Flexible `attributes` JSON field — AI has freedom for domain-specific data, DuckDB queries JSON on the fly
- **D-10:** Domains partition storage: `person/`, `event/`, `concept/`, `message/`, `config/`, `raw_note/` — maps to folder structure
- **D-11:** Tombstone-based deletion — `forget()` appends tombstone record, never deletes (preserves git history, clean merges)
- **D-12:** Support multiple connection modes based on deployment: per-query (simple), connection pool (concurrent HTTP), singleton per namespace (lightweight)
- **D-13:** Use embedded DuckDB (duckdb-node) — no server, opens files directly, loads vss extension for vector search
- **D-14:** DuckDB queries target specific partitions via manifest — doesn't scan entire database, uses glob patterns on partition folders
- **D-15:** Configurable thresholds for commits — user sets line count (N) and time interval (T seconds) based on their needs
- **D-16:** Write to disk synchronously, commit to git asynchronously — prevents data loss on crash, avoids blocking agent
- **D-17:** Single-threaded write queue — avoids `index.lock` collisions, serializes git operations
- **D-18:** Author attribution from git email — not security, just attribution for multi-user/shared namespaces
- **D-19:** Each namespace is a separate git repo — queried independently, enables sharing with friends via GitHub
- **D-20:** Multiple namespaces can be loaded simultaneously — agent can pull from shared repos, push to different origins
- **D-21:** Git worktrees for HTTP mode — isolates branches per agent when hosting remotely
- **D-22:** SSH tunneling support — transparent remote access without opening ports (`ssh user@host "duckbrain stdio"` pipes local stdin/stdout)
- **D-23:** Dual interface: stdio MCP (local Claude) + HTTP MCP (remote hosting) + CLI (human operators)

### the agent's Discretion
- Exact chunk size thresholds within partitions
- Specific default values for configurable thresholds (line count, time interval)
- DuckDB connection mode selection logic (when to use which mode)
- Manifest file format details (JSON structure)
- Partition chunking strategy (size-based vs count-based)

### Deferred Ideas (OUT OF SCOPE)
- Git automation (async commits, squash process, merge handling) — Phase 2
- Multi-user attribution enhancements — Phase 3
- SSH tunneling polish and formalization — Phase 3
- Web UI (file-explorer interface) — Phase 4
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CORE-01 | `remember()` — Appends memory to JSONL, batches git commits by lines/time | MCP tool registration with `@modelcontextprotocol/server`, JSONL append patterns, simple-git async queue |
| CORE-02 | `recall()` — DuckDB queries with semantic search (vss), path globs, exact key lookup | DuckDB vss extension, glob queries on partitioned JSONL, HNSW index for vectors |
| CORE-03 | `list_keys()` — Hierarchical key explorer with pagination and depth limits | Key extraction via DuckDB, prefix filtering, pagination patterns |
| CORE-04 | `forget()` — Appends tombstone records (never deletes) | Tombstone pattern implementation, action field enum |
| SCHEMA-01 | Hybrid schema — Strict base + flexible attributes JSON | Mullet schema pattern, DuckDB JSON querying |
| SCHEMA-02 | Hierarchical key field — Filesystem-style paths for glob queries | Key path structure, partition mapping |
| SCHEMA-03 | Zod validation — Enforce schemas on all MCP tool inputs | Zod v4 integration with MCP SDK |
| STORAGE-01 | Partitioned storage — Domains map to folders | Three-level hierarchy implementation |
| STORAGE-02 | Manifest file — Lightweight index tracking active partition paths | JSON manifest structure, DuckDB glob integration |
| STORAGE-03 | DuckDB initialization — Load vss extension, configure for JSONL/Parquet queries | Extension loading, connection management |
| CLI-01 | Stdio MCP — Local Claude integration | StdioServerTransport, spawn patterns |
| CLI-02 | CLI commands — Human operators, SSH support | CLI argument parsing, SSH stdio piping |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@modelcontextprotocol/server` | 1.28.0 | MCP server framework | Official MCP TypeScript SDK, stdio + HTTP transports, Zod integration |
| `duckdb` | 1.4.4 | Embedded SQL analytics | In-process DB, JSONL/Parquet queries, vss extension for vectors |
| `simple-git` | 3.33.0 | Git operations | Promise-based, concurrent-safe, extensive API |
| `zod` | 4.1.8 | Schema validation | Required peer dependency for MCP SDK, runtime type checking |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `uuid` | 9.x | UUID generation | Memory ID creation |
| `node-fetch` | 3.x | HTTP client | HTTP MCP transport (if not using Express) |
| `express` | 4.x | HTTP server | HTTP MCP mode with DNS rebinding protection |
| `@modelcontextprotocol/node` | 1.x | Node.js HTTP transport | Streamable HTTP over Node.js http module |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `duckdb` | `@duckdb/node-api` (neo) | Neo is newer API but less mature; stick with stable v1.4.4+ |
| `simple-git` | `isomorphic-git` | Pure JS but slower; simple-git has better perf for local ops |
| `express` | `hono` | Hono is lighter but less ecosystem; Express has DNS rebinding middleware |

**CRITICAL SECURITY WARNING:** DuckDB npm packages were compromised on September 8, 2025 (CVE-2025-59037). Malicious versions: `duckdb@1.3.3`, `@duckdb/node-api@1.3.3`, `@duckdb/node-bindings@1.3.3`. **DO NOT USE VERSION 1.3.3**. Safe versions: `duckdb@1.3.4+` or `duckdb@1.4.4` (current latest).

**Installation:**
```bash
# Core dependencies
npm install @modelcontextprotocol/server@1.28.0 duckdb@1.4.4 simple-git@3.33.0 zod@4.1.8 uuid

# Optional for HTTP mode
npm install express @modelcontextprotocol/node
```

**Version verification:**
```bash
npm view duckdb version  # Should return 1.4.4 or higher
npm view @modelcontextprotocol/server version  # Should return 1.28.0
npm view simple-git version  # Should return 3.33.0
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── cli/                   # CLI entry points
│   ├── stdio.js          # Stdio MCP for local Claude
│   ├── http.js           # HTTP MCP for remote hosting
│   └── human.js          # Human operator CLI commands
├── mcp/
│   ├── server.js         # MCP server setup
│   ├── tools/            # Tool implementations
│   │   ├── remember.js
│   │   ├── recall.js
│   │   ├── list_keys.js
│   │   └── forget.js
│   └── schemas.js        # Zod schemas for tools
├── storage/
│   ├── partition.js      # Partition management
│   ├── manifest.js       # Manifest file operations
│   └── jsonl.js          # JSONL read/write utilities
├── duckdb/
│   ├── connection.js     # DuckDB connection management
│   ├── queries.js        # Predefined query patterns
│   └── vss.js           # Vector search setup
├── git/
│   ├── writer.js         # Async git write queue
│   └── config.js         # Git configuration
└── schema/
    └── memory.js         # Mullet schema definition
```

### Pattern 1: MCP Server with Stdio Transport
**What:** MCP server using stdio transport for local Claude integration
**When to use:** Local development, single-agent setups
**Example:**
```typescript
// Source: https://ts.sdk.modelcontextprotocol.io/documents/server.html
import { McpServer } from '@modelcontextprotocol/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'duckbrain',
  version: '1.0.0'
});

// Register tool with Zod schema
server.registerTool(
  'remember',
  {
    title: 'Remember Memory',
    description: 'Append a memory to JSONL storage',
    inputSchema: {
      key: z.string().describe('Hierarchical key path'),
      domain: z.enum(['person', 'event', 'concept', 'message', 'config', 'raw_note']),
      attributes: z.record(z.unknown()).describe('Flexible attributes')
    },
    outputSchema: {
      success: z.boolean(),
      id: z.string(),
      key: z.string(),
      partition: z.string()
    }
  },
  async ({ key, domain, attributes }) => {
    // Tool implementation
    return { success: true, id: 'uuid', key, partition: '2026-03' };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Pattern 2: DuckDB with VSS Extension
**What:** Embedded DuckDB with vector similarity search extension
**When to use:** Semantic search, vector queries
**Example:**
```typescript
// Source: https://duckdb.org/docs/stable/core_extensions/vss.html
import duckdb from 'duckdb';

const db = new duckdb.Database(':memory:');

// Load vss extension
db.run('INSTALL vss;', (err) => {
  if (err) throw err;
  db.run('LOAD vss;', (err) => {
    if (err) throw err;
    
    // Create table with vector column
    db.run(`
      CREATE TABLE memories (
        id VARCHAR,
        key VARCHAR,
        domain VARCHAR,
        embedding FLOAT[384]
      )
    `, (err) => {
      if (err) throw err;
      
      // Create HNSW index for vector search
      db.run(`
        CREATE INDEX idx_embedding 
        ON memories 
        USING HNSW (embedding) 
        WITH (metric = 'cosine')
      `, (err) => {
        if (err) throw err;
        
        // Query with vector similarity
        db.all(`
          SELECT * FROM memories
          ORDER BY array_cosine_distance(embedding, ?::FLOAT[384])
          LIMIT 10
        `, [queryEmbedding], (err, results) => {
          if (err) throw err;
          console.log(results);
        });
      });
    });
  });
});
```

### Pattern 3: JSONL Partitioned Storage with Manifest
**What:** Partitioned JSONL files with manifest-based DuckDB glob queries
**When to use:** Large-scale memory storage, efficient querying
**Example:**
```typescript
// Source: https://duckdb.org/docs/stable/data/multiple_files/overview.html
import duckdb from 'duckdb';
import fs from 'fs';
import path from 'path';

interface Manifest {
  partitions: string[];
  lastUpdated: string;
}

class PartitionedStorage {
  private manifestPath: string;
  
  constructor(namespacePath: string) {
    this.manifestPath = path.join(namespacePath, 'manifest.json');
  }
  
  getManifest(): Manifest {
    if (!fs.existsSync(this.manifestPath)) {
      return { partitions: [], lastUpdated: new Date().toISOString() };
    }
    return JSON.parse(fs.readFileSync(this.manifestPath, 'utf-8'));
  }
  
  queryDuckDB(db: duckdb.Database, domain: string): void {
    const manifest = this.getManifest();
    const partitionPaths = manifest.partitions
      .filter(p => p.startsWith(domain))
      .map(p => `memory/${p}/**/*.jsonl`);
    
    // Use glob pattern to query all partition files
    const globPattern = partitionPaths.join(',');
    db.all(`
      SELECT * FROM read_json_auto('${globPattern}', format = 'json_lines')
      WHERE action != 'tombstone'
      ORDER BY timestamp DESC
    `, (err, results) => {
      if (err) throw err;
      console.log(results);
    });
  }
}
```

### Pattern 4: Async Git Write Queue
**What:** Single-threaded git commit queue to avoid index.lock collisions
**When to use:** Concurrent write scenarios
**Example:**
```typescript
// Source: https://www.npmjs.com/package/simple-git
import simpleGit, { SimpleGit } from 'simple-git';

class GitWriteQueue {
  private git: SimpleGit;
  private queue: Array<() => Promise<void>> = [];
  private processing = false;
  private lineThreshold: number;
  private timeThreshold: number;
  private pendingLines = 0;
  private lastCommitTime: number;
  
  constructor(repoPath: string, lineThreshold: number, timeThreshold: number) {
    this.git = simpleGit(repoPath);
    this.lineThreshold = lineThreshold;
    this.timeThreshold = timeThreshold;
    this.lastCommitTime = Date.now();
  }
  
  async enqueue(writeOperation: () => Promise<number>): Promise<void> {
    const linesWritten = await writeOperation();
    this.pendingLines += linesWritten;
    
    const shouldCommitByLines = this.pendingLines >= this.lineThreshold;
    const shouldCommitByTime = (Date.now() - this.lastCommitTime) >= this.timeThreshold;
    
    if (shouldCommitByLines || shouldCommitByTime) {
      await this.addToQueue();
    }
  }
  
  private async addToQueue(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await this.git.add('.');
          await this.git.commit(`Auto-commit: ${this.pendingLines} lines`);
          this.pendingLines = 0;
          this.lastCommitTime = Date.now();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      
      if (!this.processing) {
        this.processQueue();
      }
    });
  }
  
  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) {
      this.processing = false;
      return;
    }
    
    this.processing = true;
    const task = this.queue.shift();
    if (task) {
      await task();
      this.processQueue();
    }
  }
}
```

### Anti-Patterns to Avoid
- **Multiple concurrent git commits:** Causes `index.lock` errors — use single-threaded queue
- **Direct row updates:** Breaks append-only guarantee — always append, use tombstones for deletions
- **Scanning entire database:** Slow queries — use manifest to target specific partitions
- **Using DuckDB 1.3.3:** Compromised with malware — use v1.3.4+ or v1.4.4+

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| MCP server framework | Custom JSON-RPC over stdio | `@modelcontextprotocol/server` | Protocol complexity, session management, tool registration |
| Embedded SQL queries | Custom JSONL parser | DuckDB `read_json_auto()` | Optimized parsing, SQL queries, indexing |
| Vector similarity search | Brute-force cosine similarity | DuckDB vss extension with HNSW | 100x faster, index-based search |
| Git operations | Direct `git` CLI calls | `simple-git` | Error handling, promise interface, concurrency safety |
| Schema validation | Manual type checks | Zod | TypeScript integration, MCP SDK requirement |
| DNS rebinding protection | Custom host validation | Express middleware from MCP SDK | Security-critical, battle-tested |

**Key insight:** The MCP protocol is complex with session management, tool registration, and transport handling. Building a custom implementation risks incompatibility with Claude Desktop and other MCP clients. Similarly, DuckDB's vss extension provides HNSW indexing that's far superior to naive vector search.

## Common Pitfalls

### Pitfall 1: Git index.lock Collisions
**What goes wrong:** Multiple concurrent git operations create `index.lock` file, blocking all subsequent operations
**Why it happens:** Git uses file-based locking to prevent concurrent modifications; simple-git spawns separate processes
**How to avoid:** Implement single-threaded write queue, serialize all git operations
**Warning signs:** Error message "A lock file already exists in the repository"

### Pitfall 2: DuckDB Package Security
**What goes wrong:** Installing compromised DuckDB npm package (v1.3.3) with cryptocurrency malware
**Why it happens:** NPM account compromised via phishing attack in September 2025
**How to avoid:** Pin version to 1.4.4+, verify checksum, use lockfile
**Warning signs:** Version 1.3.3 in package.json, unexpected crypto transactions

### Pitfall 3: Manifest Staleness
**What goes wrong:** Manifest doesn't reflect actual partition files, queries miss data
**Why it happens:** Partitions created but manifest not updated atomically
**How to avoid:** Update manifest immediately after creating partition, use atomic file writes
**Warning signs:** DuckDB queries return fewer results than expected

### Pitfall 4: VSS Index Persistence
**What goes wrong:** HNSW index lost after restart, queries slow
**Why it happens:** VSS indexes are in-memory by default; persistence is experimental
**How to avoid:** Set `hnsw_enable_experimental_persistence = true`, rebuild index on startup if corrupted
**Warning signs:** Index scan becomes table scan after restart

### Pitfall 5: Tombstone Accumulation
**What goes wrong:** Deleted memories still appear in queries
**Why it happens:** Queries don't filter out tombstone records
**How to avoid:** Always add `WHERE action != 'tombstone'` to queries
**Warning signs:** "Deleted" memories reappear in recall results

## Code Examples

### MCP Tool Registration with Zod
```typescript
// Source: https://ts.sdk.modelcontextprotocol.io/documents/server.html
import { McpServer } from '@modelcontextprotocol/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({ name: 'duckbrain', version: '1.0.0' });

server.registerTool(
  'recall',
  {
    title: 'Recall Memories',
    description: 'Query memories with filters and semantic search',
    inputSchema: {
      key: z.string().optional().describe('Exact key lookup'),
      keyPrefix: z.string().optional().describe('Prefix glob query'),
      domain: z.enum(['person', 'event', 'concept', 'message', 'config', 'raw_note']).optional(),
      query: z.string().optional().describe('Semantic search query'),
      limit: z.number().default(10)
    },
    outputSchema: {
      memories: z.array(z.object({
        id: z.string(),
        key: z.string(),
        domain: z.string(),
        timestamp: z.string(),
        attributes: z.record(z.unknown())
      }))
    }
  },
  async ({ key, keyPrefix, domain, query, limit }) => {
    // Implementation uses DuckDB with optional vector search
    return { memories: [] };
  }
);
```

### DuckDB VSS Setup
```typescript
// Source: https://duckdb.org/docs/stable/core_extensions/vss.html
import duckdb from 'duckdb';

async function initDuckDB(dbPath: string): Promise<duckdb.Database> {
  return new Promise((resolve, reject) => {
    const db = new duckdb.Database(dbPath);
    
    db.run('INSTALL vss;', (err) => {
      if (err) return reject(err);
      db.run('LOAD vss;', (err) => {
        if (err) return reject(err);
        
        // Enable experimental persistence
        db.run('SET hnsw_enable_experimental_persistence = true;', (err) => {
          if (err) return reject(err);
          resolve(db);
        });
      });
    });
  });
}
```

### JSONL Append with Atomic Write
```typescript
// Source: https://jsonl.rest/best-practices/
import fs from 'fs';
import path from 'path';

async function appendToJsonl(filePath: string, record: object): Promise<number> {
  const line = JSON.stringify(record) + '\n';
  
  // Append synchronously (git queue handles async)
  fs.appendFileSync(filePath, line);
  return 1; // Return lines written
}

function createPartition(partitionPath: string): void {
  const dir = path.dirname(partitionPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Create empty file
  if (!fs.existsSync(partitionPath)) {
    fs.writeFileSync(partitionPath, '');
  }
}
```

### Simple-Git with Error Handling
```typescript
// Source: https://www.npmjs.com/package/simple-git
import simpleGit from 'simple-git';

async function safeCommit(repoPath: string, message: string): Promise<void> {
  const git = simpleGit(repoPath);
  
  try {
    await git.add('.');
    await git.commit(message);
  } catch (err: any) {
    if (err.message?.includes('index.lock')) {
      // Another process is holding the lock - retry after delay
      await new Promise(resolve => setTimeout(resolve, 1000));
      return safeCommit(repoPath, message);
    }
    throw err;
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Custom JSON-RPC | MCP SDK with Zod schemas | 2024 (MCP spec) | Standardized tool registration, cross-client compatibility |
| Full table scans | Partitioned JSONL + glob queries | 2025 (DuckDB v1.4) | 10-100x faster queries on large datasets |
| Brute-force vectors | HNSW index via vss extension | 2024 (DuckDB vss) | Sub-second semantic search on millions of vectors |
| Manual git CLI | simple-git with queue | 2020+ | Promise interface, error handling, concurrency safety |
| SQLite for analytics | DuckDB columnar | 2023+ | 10x faster analytical queries, native JSONL support |

**Deprecated/outdated:**
- `duckdb@1.3.3`: Compromised with malware (CVE-2025-59037) — use v1.4.4+
- MCP SDK v2.x: Pre-alpha, not production-ready — use v1.28.0
- SSE transport: Deprecated in favor of Streamable HTTP — use for backward compatibility only

## Open Questions

1. **Chunk size thresholds**
   - What we know: CONTEXT.md marks this as the agent's discretion
   - What's unclear: Optimal size balancing file manageability vs query efficiency
   - Recommendation: Start with 1000 lines or 1MB per chunk, adjust based on performance testing

2. **Manifest atomicity**
   - What we know: Manifest tracks active partitions
   - What's unclear: Whether to use file locking or atomic rename for updates
   - Recommendation: Use atomic rename (write to temp file, then `fs.renameSync()`)

3. **DuckDB connection pooling**
   - What we know: Multiple modes available (per-query, pool, singleton)
   - What's unclear: Threshold for switching between modes
   - Recommendation: Start with singleton per namespace, add pooling if concurrent HTTP requests exceed 10/sec

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | ✓ | 24.8.0 | — |
| Bun | Package manager | ✓ | 1.x | npm as fallback |
| git | Version control | ✓ | System git | — |
| DuckDB npm | Storage layer | ✗ | — | Install required |
| MCP SDK | MCP server | ✗ | — | Install required |

**Missing dependencies with no fallback:**
- `duckdb@1.4.4` — Must install (PINNED, do not use 1.3.3)
- `@modelcontextprotocol/server@1.28.0` — Must install

**Missing dependencies with fallback:**
- None identified

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Not detected — project uses GSD workflow with verification tools |
| Config file | None — verification done via `verify` commands in GSD |
| Quick run command | `node .opencode/get-shit-done/bin/gsd-tools.cjs verify plan-structure` |
| Full suite command | `node .opencode/get-shit-done/bin/gsd-tools.cjs verify phase-completeness` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CORE-01 | remember() appends to JSONL | Unit | `node test/tools/remember.test.js` | ❌ Wave 0 |
| CORE-02 | recall() queries with filters | Unit | `node test/tools/recall.test.js` | ❌ Wave 0 |
| CORE-03 | list_keys() with pagination | Unit | `node test/tools/list_keys.test.js` | ❌ Wave 0 |
| CORE-04 | forget() appends tombstone | Unit | `node test/tools/forget.test.js` | ❌ Wave 0 |
| SCHEMA-01 | Hybrid schema validation | Unit | `node test/schema/hybrid.test.js` | ❌ Wave 0 |
| STORAGE-01 | Partitioned storage creation | Integration | `node test/storage/partition.test.js` | ❌ Wave 0 |
| STORAGE-02 | Manifest tracking | Integration | `node test/storage/manifest.test.js` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** Manual testing via MCP client
- **Per wave merge:** GSD verification commands
- **Phase gate:** All CORE-* and SCHEMA-* requirements must pass before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `test/tools/` — Test harness for MCP tools
- [ ] `test/storage/` — Storage layer tests
- [ ] `test/schema/` — Schema validation tests
- [ ] Framework setup: No test framework detected — use Node.js native assert + manual verification

## Sources

### Primary (HIGH confidence)
- **MCP TypeScript SDK** — `https://ts.sdk.modelcontextprotocol.io/documents/server.html` — Server setup, tool registration, stdio transport
- **DuckDB VSS Extension** — `https://duckdb.org/docs/stable/core_extensions/vss.html` — HNSW index, persistence, metrics
- **DuckDB Security Advisory** — `https://github.com/duckdb/duckdb-node/security/advisories/GHSA-w62p-hx95-gf2c` — CVE-2025-59037 details
- **simple-git npm** — `https://www.npmjs.com/package/simple-git` — API reference, error handling
- **MCP Proxy** — `https://github.com/sparfenyuk/mcp-proxy` — stdio to SSE bridging patterns

### Secondary (MEDIUM confidence)
- **JSONL Best Practices** — `https://jsonl.rest/best-practices/` — Chunking, partitioning patterns
- **DuckDB Multiple Files** — `https://duckdb.org/docs/stable/data/multiple_files/overview.html` — Glob query patterns
- **npm view commands** — Version verification via npm CLI

### Tertiary (LOW confidence)
- **Medium articles on partitioning** — General patterns, not DuckDB-specific
- **StackOverflow git index.lock** — User-reported solutions, not officially verified

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — Verified with official docs and npm registry
- Architecture: HIGH — Based on CONTEXT.md locked decisions + official patterns
- Pitfalls: HIGH — Security advisory verified, git patterns from simple-git docs
- Security: CRITICAL — CVE-2025-59037 verified with official GitHub advisory

**Research date:** 2026-03-27
**Valid until:** 2026-06-27 (90 days — DuckDB and MCP SDK are stable, but security advisories may update)
