---
phase: 01-core-mvp
plan: 02
type: execute
wave: 2
depends_on: [01]
files_modified: [src/duckdb/connection.ts, src/duckdb/vss.ts, src/duckdb/queries.ts, src/mcp/tools/remember.ts, src/mcp/tools/forget.ts]
autonomous: true
requirements: [CORE-01, CORE-04, STORAGE-03]

must_haves:
  truths:
    - "DuckDB connects to JSONL files with vss extension loaded"
    - "remember() appends validated memory to correct partition"
    - "forget() appends tombstone record (never deletes)"
    - "Author attribution from git email"
  artifacts:
    - path: "src/duckdb/connection.ts"
      provides: "DuckDB connection management"
      exports: ["initDuckDB", "getDuckDBConnection", "closeDuckDB"]
    - path: "src/duckdb/vss.ts"
      provides: "VSS extension setup"
      exports: ["loadVSSExtension", "enablePersistence"]
    - path: "src/duckdb/queries.ts"
      provides: "Predefined query patterns"
      exports: ["insertMemory", "tombstoneMemory"]
    - path: "src/mcp/tools/remember.ts"
      provides: "remember() MCP tool"
      exports: ["rememberTool"]
    - path: "src/mcp/tools/forget.ts"
      provides: "forget() MCP tool"
      exports: ["forgetTool"]
  key_links:
    - from: "src/mcp/tools/remember.ts"
      to: "src/schema/memory.ts"
      via: "Zod validation before append"
      pattern: "MemorySchema\\.parse\\("
    - from: "src/mcp/tools/remember.ts"
      to: "src/storage/jsonl.ts"
      via: "appendToJsonl call"
      pattern: "appendToJsonl\\("
    - from: "src/duckdb/connection.ts"
      to: "src/duckdb/vss.ts"
      via: "Extension loading on init"
      pattern: "loadVSSExtension\\("
---

<objective>
Implement remember() and forget() tools with DuckDB initialization and VSS extension.

Purpose: Enable agents to persist memories and mark them as deleted (tombstones).
Output: Working remember()/forget() MCP tools, DuckDB configured with vss extension.
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
@.planning/phases/01-core-mvp/01-PLAN.md

<interfaces>
<!-- Contracts from Wave 1 that this plan implements against -->

From 01-PLAN.md Wave 1 outputs:
```typescript
// From src/schema/memory.ts
export interface MemoryType {
  id: string;
  key: string;              // Starts with /
  domain: 'person'|'event'|'concept'|'message'|'config'|'raw_note';
  timestamp: string;        // ISO-8601
  author: string;           // Git email
  action: 'add'|'update'|'tombstone';
  embedding_text: string;
  attributes: Record<string, unknown>;
}
export function validateMemory(data: unknown): MemoryType;

// From src/storage/jsonl.ts
export function getPartitionPath(namespace: string, domain: string, partitionType: string, partitionValue: string): string;
export function createPartition(partitionPath: string): void;
export function appendToJsonl(filePath: string, record: MemoryType): number;

// From src/storage/manifest.ts
export function getManifest(namespacePath: string): Manifest;
export function addPartition(namespacePath: string, partitionPath: string): void;
export function getPartitionsForDomain(namespacePath: string, domain: string): string[];
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Initialize DuckDB with VSS extension</name>
  <files>src/duckdb/connection.ts, src/duckdb/vss.ts</files>
  <action>
    Create DuckDB connection management per D-12 (multiple modes) and D-13 (embedded DuckDB):
    
    In src/duckdb/connection.ts:
    - initDuckDB(dbPath: string = ':memory:'): Promise<Database>
      Creates Database instance, calls loadVSSExtension
      Supports modes: :memory: for testing, file path for persistence
    
    - getDuckDBConnection(mode: 'singleton'|'pool'|'per-query', namespacePath: string): Database
      Singleton mode: Returns cached connection per namespace
      Pool mode: Returns connection from pool (for concurrent HTTP)
      Per-query mode: Creates new connection (simple, for testing)
      Default: singleton per namespace
    
    - closeDuckDB(db: Database): Promise<void>
      Closes connection cleanly
    
    In src/duckdb/vss.ts:
    - loadVSSExtension(db: Database): Promise<void>
      Runs: INSTALL vss; LOAD vss;
      Handles errors gracefully (extension may already be installed)
    
    - enablePersistence(db: Database): Promise<void>
      Runs: SET hnsw_enable_experimental_persistence = true;
      Per RESEARCH.md "Pitfall 4: VSS Index Persistence"
    
    Reference: RESEARCH.md "DuckDB VSS Setup" and "Pattern 2: DuckDB with VSS Extension".
    
    CRITICAL: Verify duckdb version != 1.3.3 in code with runtime check.
  </action>
  <verify>
    <automated>node -e "const c = require('./src/duckdb/connection'); console.log('Connection exports:', Object.keys(c))"</automated>
  </verify>
  <done>DuckDB connections working, vss extension loads without errors</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Create predefined DuckDB query patterns</name>
  <files>src/duckdb/queries.ts</files>
  <action>
    Create reusable query patterns for remember/forget operations:
    
    Functions:
    - insertMemory(db: Database, memory: MemoryType, partitionPath: string): void
      Uses read_json_auto() to insert into DuckDB table
      Creates table if not exists with columns matching MemoryType base fields
      Embeds attributes JSON as string
    
    - tombstoneMemory(db: Database, memoryId: string, partitionPath: string): void
      Appends tombstone record with action='tombstone'
      Copies all fields from original memory, changes action field
    
    - queryMemories(db: Database, partitionPaths: string[], filters?: object): MemoryType[]
      Uses glob pattern: read_json_auto('path1.jsonl,path2.jsonl', format='json_lines')
      Filters: WHERE action != 'tombstone' (per RESEARCH.md Pitfall 5)
      Supports domain, key prefix, timestamp range filters
    
    Reference: RESEARCH.md "Pattern 3: JSONL Partitioned Storage with Manifest" for glob queries.
    
    Note: DuckDB queries JSON on the fly per D-09 - no need to flatten attributes.
  </action>
  <verify>
    <automated>node -e "const q = require('./src/duckdb/queries'); console.log('Query exports:', Object.keys(q))"</automated>
  </verify>
  <done>Insert, tombstone, and query functions working with partition targeting</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Implement remember() MCP tool</name>
  <files>src/mcp/tools/remember.ts</files>
  <action>
    Create remember() tool per CORE-01 and D-05 (hybrid response format):
    
    Tool registration with MCP server:
    - name: 'remember'
    - title: 'Remember Memory'
    - description: 'Append a memory to JSONL storage'
    
    Input schema (using Zod from src/schema/memory.ts):
    - key: z.string().describe('Hierarchical key path (e.g., /projects/mcp/schema)')
    - domain: DomainEnum
    - attributes: z.record(z.unknown()).describe('Memory attributes')
    - embedding_text: z.string().optional().describe('Text for vector embedding')
    
    Implementation:
    1. Validate input with MemorySchema.parse()
    2. Generate UUID for memory.id (use uuid library)
    3. Set timestamp to ISO-8601 now()
    4. Get author from git config: git config user.email (per D-18)
    5. Set action = 'add'
    6. Determine partition path using getPartitionPath() with time-based partitioning
    7. Create partition if not exists
    8. Append to JSONL file synchronously (per D-16)
    9. Update manifest with addPartition()
    10. Return hybrid response: {success, id, key, partition, author}
    
    Git batching: Note that git commit is async (Phase 2, GIT-01) - for now just sync write.
    
    Response format per D-05:
    ```typescript
    {
      success: true,
      id: "uuid-string",
      key: "/projects/mcp/schema",
      partition: "default/person/2026-03",
      author: "user@example.com"
    }
    ```
    
    Reference: RESEARCH.md "MCP Tool Registration with Zod" example.
  </action>
  <verify>
    <automated>node -e "const r = require('./src/mcp/tools/remember'); console.log('Remember exports:', Object.keys(r))"</automated>
  </verify>
  <done>remember() tool validates input, appends to JSONL, updates manifest, returns hybrid response</done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: Implement forget() MCP tool</name>
  <files>src/mcp/tools/forget.ts</files>
  <action>
    Create forget() tool per CORE-04 and D-11 (tombstone-based deletion):
    
    Tool registration:
    - name: 'forget'
    - title: 'Forget Memory'
    - description: 'Mark a memory as deleted (tombstone)'
    
    Input schema:
    - id: z.string().uuid().describe('Memory ID to forget')
    - reason: z.string().optional().describe('Optional reason for deletion')
    
    Implementation:
    1. Validate input with Zod
    2. Query DuckDB to find existing memory by ID (using queries.ts)
    3. If not found: return {success: false, error: 'Memory not found'}
    4. If found: create tombstone record with:
       - All fields copied from original
       - action changed to 'tombstone'
       - tombstone_reason added to attributes if provided
       - timestamp updated to now()
    5. Append tombstone to same partition as original
    6. Return: {success: true, id, tombstoned: true}
    
    CRITICAL: Never delete files per D-11 - always append tombstone to preserve git history.
    
    Reference: RESEARCH.md "Pitfall 5: Tombstone Accumulation" - queries must filter WHERE action != 'tombstone'.
  </action>
  <verify>
    <automated>node -e "const f = require('./src/mcp/tools/forget'); console.log('Forget exports:', Object.keys(f))"</automated>
  </verify>
  <done>forget() finds memory by ID, appends tombstone record, never deletes files</done>
</task>

</tasks>

<verification>
Phase verification (Wave 2):
1. DuckDB initializes with vss extension loaded
2. remember() validates input, appends to correct partition, updates manifest
3. forget() finds memory, appends tombstone with same ID
4. Author attribution from git email works
5. Hybrid response format includes id, key, partition for debugging
</verification>

<success_criteria>
- [ ] CORE-01: remember() appends to JSONL partition ✓
- [ ] CORE-04: forget() appends tombstone (never deletes) ✓
- [ ] STORAGE-03: DuckDB initialized with vss extension ✓
- [ ] D-05: Hybrid response format implemented ✓
- [ ] D-11: Tombstone-based deletion working ✓
- [ ] D-16: Synchronous write to disk (async git in Phase 2) ✓
- [ ] D-18: Author attribution from git email ✓
</success_criteria>

<output>
After completion, create `.planning/phases/01-core-mvp/02-SUMMARY.md` with:
- DuckDB connection modes tested
- remember() tool example input/output
- forget() tool example input/output
- Tombstone record structure
- Verification results
</output>
