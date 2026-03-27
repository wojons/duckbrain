---
phase: 01-core-mvp
plan: 03
type: execute
wave: 2
depends_on: [01]
files_modified: [src/mcp/tools/recall.ts, src/mcp/tools/list_keys.ts, src/mcp/server.ts]
autonomous: true
requirements: [CORE-02, CORE-03, SCHEMA-03]

must_haves:
  truths:
    - "recall() returns memories via DuckDB queries (exact key, glob, semantic)"
    - "list_keys() explores hierarchical structure with pagination and depth limits"
    - "All MCP tool inputs validated by Zod schemas"
    - "DuckDB queries filter out tombstone records"
  artifacts:
    - path: "src/mcp/tools/recall.ts"
      provides: "recall() MCP tool with multiple query modes"
      exports: ["recallTool"]
    - path: "src/mcp/tools/list_keys.ts"
      provides: "list_keys() guardrail tool"
      exports: ["listKeysTool"]
    - path: "src/mcp/server.ts"
      provides: "MCP server setup with all tools registered"
      exports: ["server", "startServer"]
  key_links:
    - from: "src/mcp/tools/recall.ts"
      to: "src/duckdb/queries.ts"
      via: "queryMemories call with filters"
      pattern: "queryMemories\\("
    - from: "src/mcp/tools/list_keys.ts"
      to: "src/storage/manifest.ts"
      via: "getPartitionsForDomain for key extraction"
      pattern: "getPartitionsForDomain\\("
    - from: "src/mcp/server.ts"
      to: "src/mcp/tools/*.ts"
      via: "Tool registration"
      pattern: "server\\.registerTool\\("
---

<objective>
Implement recall() and list_keys() tools, register all tools with MCP server.

Purpose: Enable agents to query memories with filters and explore key structure safely.
Output: Working recall()/list_keys() tools, complete MCP server with all 4 tools registered.
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
@.planning/phases/01-core-mvp/02-PLAN.md

<interfaces>
<!-- Contracts from Wave 1-2 that this plan implements against -->

From 01-PLAN.md Wave 1:
```typescript
// From src/schema/memory.ts
export const MemorySchema: ZodSchema<MemoryType>;
export function validateMemory(data: unknown): MemoryType;
export const DomainEnum: z.ZodEnum<['person','event','concept','message','config','raw_note']>;

// From src/storage/manifest.ts
export function getManifest(namespacePath: string): Manifest;
export function getPartitionsForDomain(namespacePath: string, domain: string): string[];
```

From 02-PLAN.md Wave 2:
```typescript
// From src/duckdb/queries.ts
export function queryMemories(db: Database, partitionPaths: string[], filters?: object): MemoryType[];
export function insertMemory(db: Database, memory: MemoryType, partitionPath: string): void;

// From src/duckdb/connection.ts
export function getDuckDBConnection(mode: string, namespacePath: string): Database;
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Implement recall() MCP tool with multiple query modes</name>
  <files>src/mcp/tools/recall.ts</files>
  <action>
    Create recall() tool per CORE-02 with three query modes:
    
    Tool registration:
    - name: 'recall'
    - title: 'Recall Memories'
    - description: 'Query memories with filters and semantic search'
    
    Input schema (all optional except limit):
    - key: z.string().optional().describe('Exact key lookup')
    - keyPrefix: z.string().optional().describe('Prefix glob query (e.g., /projects/)')
    - domain: DomainEnum.optional()
    - query: z.string().optional().describe('Semantic search query (uses vss extension)')
    - limit: z.number().default(10).describe('Max results to return')
    - namespace: z.string().default('default').describe('Namespace to query')
    
    Implementation logic:
    1. Validate input with Zod
    2. Get DuckDB connection using getDuckDBConnection('singleton', namespace)
    3. Get partition paths using getPartitionsForDomain() filtered by domain if provided
    4. Build query filters based on input mode:
       
       Mode A - Exact key lookup (key provided):
       - WHERE key = :key AND action != 'tombstone'
       
       Mode B - Prefix glob (keyPrefix provided):
       - WHERE key LIKE :keyPrefix || '%' AND action != 'tombstone'
       
       Mode C - Semantic search (query provided):
       - Generate embedding for query text (placeholder for now, TODO: integrate embedding model)
       - Use DuckDB vss: ORDER BY array_cosine_distance(embedding, ?::FLOAT[384])
       - Per RESEARCH.md "Pattern 2: DuckDB with VSS Extension"
       
       Mode D - Filtered list (domain only):
       - WHERE domain = :domain AND action != 'tombstone'
    
    5. Execute query with LIMIT
    6. Return: {memories: MemoryType[], count: number}
    
    CRITICAL: Always filter WHERE action != 'tombstone' per RESEARCH.md Pitfall 5.
    
    For semantic search (Mode C):
    - If no embedding model available yet, return error: "Semantic search requires embedding model - configure in Phase 2"
    - Or use embedding_text field directly if user provides pre-computed embeddings
    
    Reference: RESEARCH.md "Code Examples: MCP Tool Registration with Zod" and "DuckDB VSS Setup".
  </action>
  <verify>
    <automated>node -e "const r = require('./src/mcp/tools/recall'); console.log('Recall exports:', Object.keys(r))"</automated>
  </verify>
  <done>recall() supports exact key, prefix glob, domain filter, and semantic search modes, filters tombstones</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Implement list_keys() guardrail tool</name>
  <files>src/mcp/tools/list_keys.ts</files>
  <action>
    Create list_keys() tool per CORE-03 and D-07 (pagination, depth limits, prefix filtering):
    
    Motivation per D-07: Guardrail tool prevents AI path hallucinations by providing safe exploration.
    
    Tool registration:
    - name: 'list_keys'
    - title: 'List Memory Keys'
    - description: 'Explore hierarchical key structure with pagination'
    
    Input schema:
    - prefix: z.string().optional().default('/').describe('Key prefix to filter (e.g., /projects/)')
    - maxDepth: z.number().default(3).describe('Max hierarchy depth to return')
    - limit: z.number().default(50).describe('Max keys to return')
    - offset: z.number().default(0).describe('Pagination offset')
    - namespace: z.string().default('default')
    
    Implementation:
    1. Validate input with Zod
    2. Get manifest for namespace
    3. Query DuckDB for distinct keys matching prefix:
       SELECT DISTINCT key FROM read_json_auto('*.jsonl', format='json_lines')
       WHERE key LIKE :prefix || '%' AND action != 'tombstone'
    4. Parse hierarchical structure:
       - Split keys by / to determine depth
       - Truncate at maxDepth (e.g., depth=2 returns /projects/mcp but not /projects/mcp/schema)
    5. Apply pagination: slice results by offset and limit
    6. Return structured response:
       ```typescript
       {
         keys: string[],
         hasMore: boolean,
         nextOffset: number | null,
         prefixes: Record<string, number>  // Count of keys under each prefix
       }
       ```
    
    Depth calculation example:
    - key: "/projects/mcp/schema" 
    - depth 1: "/projects"
    - depth 2: "/projects/mcp"
    - depth 3: "/projects/mcp/schema"
    
    Reference: CORE-03 requirement for "hierarchical key explorer with pagination and depth limits".
  </action>
  <verify>
    <automated>node -e "const lk = require('./src/mcp/tools/list_keys'); console.log('ListKeys exports:', Object.keys(lk))"</automated>
  </verify>
  <done>list_keys() explores hierarchy with prefix filtering, depth limits, and pagination</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Set up MCP server with all tools registered</name>
  <files>src/mcp/server.ts</files>
  <action>
    Create MCP server per CLI-01 (stdio MCP for local Claude):
    
    Server setup using @modelcontextprotocol/server:
    ```typescript
    import { McpServer } from '@modelcontextprotocol/server/mcp.js';
    import { StdioServerTransport } from '@modelcontextprotocol/server/stdio.js';
    
    const server = new McpServer({
      name: 'duckbrain',
      version: '1.0.0'
    });
    ```
    
    Register all four tools:
    1. Import tool handlers from src/mcp/tools/{remember,recall,list_keys,forget}.ts
    2. Call server.registerTool() for each with:
       - Tool name
       - Metadata (title, description, inputSchema, outputSchema)
       - Handler function
    
    Server lifecycle:
    - startServer(): async function that:
      1. Creates StdioServerTransport
      2. Connects server to transport
      3. Logs "DuckBrain MCP server started" to stderr (stdout reserved for MCP protocol)
    
    - stopServer(): async function for graceful shutdown
    
    Export:
    - server instance (for testing)
    - startServer() function
    - stopServer() function
    
    Reference: RESEARCH.md "Pattern 1: MCP Server with Stdio Transport" and "Code Examples: MCP Tool Registration with Zod".
    
    Note: HTTP MCP mode (CLI-01) is Phase 2 - focus on stdio for now.
  </action>
  <verify>
    <automated>node -e "const s = require('./src/mcp/server'); console.log('Server exports:', Object.keys(s))"</automated>
  </verify>
  <done>MCP server created, all 4 tools (remember, recall, list_keys, forget) registered, stdio transport working</done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: Verify Zod validation on all MCP tool inputs</name>
  <files>src/mcp/tools/*.ts</files>
  <action>
    Audit all tool input schemas per SCHEMA-03 (Zod validation):
    
    Checklist for each tool:
    1. remember.ts:
       - [ ] key: z.string() with hierarchical path validation
       - [ ] domain: DomainEnum
       - [ ] attributes: z.record(z.unknown())
       - [ ] embedding_text: optional string
    
    2. recall.ts:
       - [ ] key: optional string
       - [ ] keyPrefix: optional string
       - [ ] domain: optional DomainEnum
       - [ ] query: optional string
       - [ ] limit: z.number().default(10)
       - [ ] namespace: z.string().default('default')
    
    3. list_keys.ts:
       - [ ] prefix: z.string().optional().default('/')
       - [ ] maxDepth: z.number().default(3)
       - [ ] limit: z.number().default(50)
       - [ ] offset: z.number().default(0)
       - [ ] namespace: z.string().default('default')
    
    4. forget.ts:
       - [ ] id: z.string().uuid()
       - [ ] reason: optional string
    
    Add validation wrapper if not present:
    ```typescript
    try {
      const validated = InputSchema.parse(input);
      // Proceed with implementation
    } catch (err) {
      return { success: false, error: err.message };
    }
    ```
    
    Test each tool with invalid input to confirm rejection.
    
    Reference: RESEARCH.md "Don't Hand-Roll: Schema validation - use Zod".
  </action>
  <verify>
    <automated>node test/schema/zod-validation.test.js 2>&1 || echo "Test file missing - manual verification required"</automated>
  </verify>
  <done>All 4 tools validate inputs with Zod schemas, reject invalid input with clear errors</done>
</task>

</tasks>

<verification>
Phase verification (Wave 2):
1. recall() queries memories with exact key, prefix glob, domain filter, semantic search
2. list_keys() returns hierarchical keys with pagination and depth limits
3. All 4 tools registered with MCP server
4. Zod validation rejects invalid input on all tools
5. Tombstone filtering works in all query paths
</verification>

<success_criteria>
- [ ] CORE-02: recall() queries with multiple modes (exact, glob, semantic) ✓
- [ ] CORE-03: list_keys() with pagination and depth limits ✓
- [ ] SCHEMA-03: Zod validation on all MCP tool inputs ✓
- [ ] D-07: list_keys() prevents path hallucinations with guardrails ✓
- [ ] D-14: DuckDB queries target specific partitions via manifest ✓
- [ ] CLI-01: Stdio MCP server setup complete ✓
</success_criteria>

<output>
After completion, create `.planning/phases/01-core-mvp/03-SUMMARY.md` with:
- recall() query modes tested
- list_keys() pagination examples
- MCP server registration confirmation
- Zod validation test results
- All tool input/output examples
</output>
