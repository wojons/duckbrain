---
phase: 01-core-mvp
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/schema/memory.ts, src/storage/manifest.ts, src/storage/jsonl.ts, package.json]
autonomous: true
requirements: [SCHEMA-01, SCHEMA-02, STORAGE-01, STORAGE-02]

must_haves:
  truths:
    - "Memory schema enforces strict base fields with Zod validation"
    - "Hierarchical keys use filesystem-style paths (/domain/subdomain/key)"
    - "Storage partitions by domain and time/key into namespace/domain/partition/"
    - "Manifest file tracks all active partition paths for DuckDB queries"
  artifacts:
    - path: "src/schema/memory.ts"
      provides: "Hybrid schema definition with Zod"
      exports: ["MemorySchema", "MemoryType", "DomainEnum"]
    - path: "src/storage/manifest.ts"
      provides: "Manifest file operations"
      exports: ["getManifest", "updateManifest", "Manifest interface"]
    - path: "src/storage/jsonl.ts"
      provides: "JSONL append/read utilities"
      exports: ["appendToJsonl", "readFromJsonl", "createPartition"]
    - path: "package.json"
      provides: "Dependency declarations"
      contains: "@modelcontextprotocol/server, duckdb, simple-git, zod, uuid"
  key_links:
    - from: "src/schema/memory.ts"
      to: "src/storage/jsonl.ts"
      via: "Zod-validated records written to JSONL"
      pattern: "MemorySchema\\.parse\\("
    - from: "src/storage/manifest.ts"
      to: "src/storage/jsonl.ts"
      via: "Manifest updated when partitions created"
      pattern: "updateManifest.*partition"
---

<objective>
Establish foundation: hybrid memory schema, partitioned JSONL storage, and manifest tracking.

Purpose: Enable all downstream tools (remember/recall/list_keys/forget) with validated data structures and efficient storage.
Output: Schema definitions, storage utilities, manifest management, dependencies installed.
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

<interfaces>
<!-- Key types and contracts from research -- extracted for executor context -->

From RESEARCH.md Standard Stack:
- @modelcontextprotocol/server@1.28.0 — MCP server framework
- duckdb@1.4.4 — Embedded SQL analytics (MUST NOT use 1.3.3 - compromised)
- simple-git@3.33.0 — Git operations
- zod@4.1.8 — Schema validation
- uuid — UUID generation

From RESEARCH.md Schema Design (D-08, D-09, D-10):
```typescript
// Hybrid schema structure
{
  id: string;              // UUID
  key: string;             // Hierarchical path: /domain/subdomain/key
  domain: 'person'|'event'|'concept'|'message'|'config'|'raw_note';
  timestamp: string;       // ISO-8601
  author: string;          // Git email
  action: 'add'|'update'|'tombstone';
  embedding_text: string;  // For vectorization
  attributes: Record<string, unknown>;  // Flexible JSON
}
```

From RESEARCH.md Storage Pattern (D-01, D-02, D-04):
```typescript
// Three-level hierarchy
namespace/
  person/
    2026-03/
      chunk1.jsonl
  event/
    projects/
      chunk1.jsonl
  manifest.json          // Tracks active partitions
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Install dependencies and verify versions</name>
  <files>package.json, bun.lock</files>
  <action>
    Install core dependencies with pinned versions per RESEARCH.md Standard Stack:
    ```bash
    bun add @modelcontextprotocol/server@1.28.0 duckdb@1.4.4 simple-git@3.33.0 zod@4.1.8 uuid
    ```
    
    Verify versions (CRITICAL: duckdb must NOT be 1.3.3 - compromised):
    ```bash
    bun pm ls | grep -E "(modelcontextprotocol|duckdb|simple-git|zod)"
    ```
    
    Per D-13: Use embedded DuckDB (duckdb-node), no server needed.
  </action>
  <verify>
    <automated>bun pm ls 2>&1 | grep -q "duckdb@1.4" && echo "✓ DuckDB safe version"</automated>
  </verify>
  <done>All dependencies installed, duckdb version confirmed != 1.3.3</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Define hybrid memory schema with Zod validation</name>
  <files>src/schema/memory.ts</files>
  <action>
    Create Zod schema per D-08 (strict base fields) and D-09 (flexible attributes):
    
    Required base fields:
    - id: z.string().uuid() — UUID format
    - key: z.string().regex(/^\//) — Must start with / (filesystem-style per D-06)
    - domain: z.enum(['person', 'event', 'concept', 'message', 'config', 'raw_note']) per D-10
    - timestamp: z.string().datetime() — ISO-8601
    - author: z.string().email() — Git email for attribution per D-18
    - action: z.enum(['add', 'update', 'tombstone']) per D-11
    - embedding_text: z.string() — For vectorization
    - attributes: z.record(z.unknown()) — Flexible JSON
    
    Export:
    - MemorySchema (Zod schema)
    - MemoryType (inferred TypeScript type)
    - DomainEnum (reusable enum)
    - validateMemory() helper function
    
    Reference: RESEARCH.md "MCP Tool Registration with Zod" example.
  </action>
  <verify>
    <automated>node -e "const s = require('./src/schema/memory'); console.log('Schema exports:', Object.keys(s))"</automated>
  </verify>
  <done>Memory schema defined with all 8 base fields + attributes, exports working</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Implement partitioned JSONL storage utilities</name>
  <files>src/storage/jsonl.ts</files>
  <action>
    Create partitioned storage per D-01 (three-level hierarchy), D-02 (time/key partitioning), D-03 (chunked files):
    
    Functions:
    - getPartitionPath(namespace: string, domain: string, partitionType: 'time'|'key', partitionValue: string): string
      Returns: namespace/domain/partitionValue/ (e.g., "default/person/2026-03/")
    
    - createPartition(partitionPath: string): void
      Creates directory recursively, initializes empty .gitkeep
    
    - appendToJsonl(filePath: string, record: MemoryType): number
      Appends JSON line synchronously (per D-16: sync write, async git), returns lines written
      Uses MemorySchema.parse() for validation before write
    
    - readFromJsonl(filePath: string, limit?: number): MemoryType[]
      Reads lines, parses JSON, applies schema validation
      Limit parameter for pagination support
    
    Chunking strategy (per the agent's discretion):
    - Max 1000 lines OR 1MB per chunk file
    - Name chunks: 0001.jsonl, 0002.jsonl, etc. for ordering
    
    Reference: RESEARCH.md "JSONL Append with Atomic Write" pattern.
  </action>
  <verify>
    <automated>node -e "const s = require('./src/storage/jsonl'); console.log('Storage exports:', Object.keys(s))"</automated>
  </verify>
  <done>Partition path generation, creation, append, and read functions working with schema validation</done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: Implement manifest file tracking</name>
  <files>src/storage/manifest.ts</files>
  <action>
    Create manifest management per D-04 (lightweight index for DuckDB glob queries):
    
    Manifest interface:
    ```typescript
    {
      partitions: string[];     // Array of active partition paths
      lastUpdated: string;      // ISO-8601 timestamp
    }
    ```
    
    Functions:
    - getManifest(namespacePath: string): Manifest
      Returns existing manifest or creates default {partitions: [], lastUpdated: now}
    
    - addPartition(namespacePath: string, partitionPath: string): void
      Adds partition to manifest if not exists, updates lastUpdated
      Uses atomic write: write to .tmp file, then fs.renameSync() (per RESEARCH.md Open Questions)
    
    - removePartition(namespacePath: string, partitionPath: string): void
      Removes from manifest (for cleanup, not tombstones)
    
    - getPartitionsForDomain(namespacePath: string, domain: string): string[]
      Filters partitions by domain prefix for targeted DuckDB queries per D-14
    
    Reference: RESEARCH.md "JSONL Partitioned Storage with Manifest" pattern.
  </action>
  <verify>
    <automated>node -e "const m = require('./src/storage/manifest'); console.log('Manifest exports:', Object.keys(m))"</automated>
  </verify>
  <done>Manifest CRUD operations working with atomic writes and domain filtering</done>
</task>

</tasks>

<verification>
Phase verification (Wave 1):
1. Schema validates all 8 base fields + attributes JSON
2. Hierarchical keys enforced to start with /
3. Partition paths follow namespace/domain/partition structure
4. Manifest tracks partitions and updates atomically
5. All modules export expected functions/types
</verification>

<success_criteria>
- [ ] SCHEMA-01: Hybrid schema defined with strict base + flexible attributes ✓
- [ ] SCHEMA-02: Hierarchical key validation (must start with /) ✓
- [ ] STORAGE-01: Partitioned storage paths generated correctly ✓
- [ ] STORAGE-02: Manifest file tracks partitions with atomic updates ✓
- [ ] All Zod schemas exported and usable by MCP tools ✓
- [ ] Dependencies pinned to safe versions (duckdb != 1.3.3) ✓
</success_criteria>

<output>
After completion, create `.planning/phases/01-core-mvp/01-SUMMARY.md` with:
- Installed dependency versions
- Schema field list
- Storage utility function signatures
- Manifest structure
- Test results from automated verification
</output>
