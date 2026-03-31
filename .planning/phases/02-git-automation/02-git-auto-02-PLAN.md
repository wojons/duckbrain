---
phase: 02-git-automation
plan: 02
type: execute
wave: 1
depends_on: []
files_modified: [src/git/squash.ts, src/cli/human.ts, src/mcp/tools/squash.ts]
autonomous: true
requirements: [GIT-02]
user_setup: []

must_haves:
  truths:
    - "User can trigger squash manually via CLI command"
    - "Squash converts old JSONL partitions to Parquet format"
    - "Tombstoned records are removed during compaction"
    - "Git history is squashed for compacted partitions"
    - "Squash aggressiveness is configurable"
  artifacts:
    - path: "src/git/squash.ts"
      provides: "Squash/compaction logic"
      exports: ["squashPartition", "compactHistory", "removeTombstones"]
    - path: "src/mcp/tools/squash.ts"
      provides: "MCP tool for agents"
      exports: ["squashTool"]
    - path: "src/config/index.ts"
      provides: "Squash configuration options"
      contains: "squash config schema"
  key_links:
    - from: "src/git/squash.ts"
      to: "src/storage/manifest.ts"
      via: "partition reading"
      pattern: "manifest\\.read|getPartitions"
    - from: "src/git/squash.ts"
      to: "src/duckdb/queries.ts"
      via: "Parquet conversion"
      pattern: "toParquet|convertToParquet"

---

<objective>
Implement squash/compaction process for Phase 02 GIT-02

Purpose: Reduce repository bloat by converting old JSONL to Parquet, removing tombstones, and squashing git history
Output: Squash module, MCP tool, CLI command, configuration options
</objective>

<execution_context>
@/Users/lexykwaii/Code/duckbrain/.opencode/get-shit-done/workflows/execute-plan.md
@/Users/lexykwaii/Code/duckbrain/.opencode/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/phases/02-git-automation/02-CONTEXT.md
@.planning/codebase/ARCHITECTURE.md
@.planning/codebase/CONVENTIONS.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create squash module</name>
  <files>src/git/squash.ts</files>
  <action>
    Create src/git/squash.ts with the following functions:

    1. **squashPartition(options)** — Main entry point:
       - Accept: partition path, options (dryRun, compress, squashCommits)
       - Read all JSONL files in partition
       - Filter out tombstoned records (action === 'forget')
       - Convert remaining records to Parquet format using DuckDB
       - Replace original JSONL with Parquet files
       - If squashCommits=true, use git filter-branch or git rebase to compact history
       - Update manifest file to reflect new Parquet format

    2. **compactHistory(options)** — Time-based compaction:
       - Accept: maxAge (default: 30 days), threshold (default: 1000 records)
       - Find partitions older than maxAge
       - Call squashPartition for each
       - Log compaction activity

    3. **removeTombstones(partition)** — Cleanup function:
       - Read partition JSONL
       - Filter records where action !== 'forget'
       - Rewrite JSONL without tombstones
       - Return count of removed records

    4. **getCompactionStats()** — Diagnostics:
       - Scan all partitions
       - Calculate: total size, tombstone %, Parquet ratio
       - Return stats object

    Use DuckDB connection from src/duckdb/connection.ts for Parquet conversion.
    Follow append-only pattern from src/storage/jsonl.ts.
  </action>
  <verify>
    <automated>npx ts-node -e "import { squashPartition } from './src/git/squash'; console.log('squash module loads')" 2>&1 | grep -q "squash module loads" && echo "PASS"</automated>
  </verify>
  <done>squash.ts created with 4 exported functions, compiles without errors</done>
</task>

<task type="auto">
  <name>Task 2: Add MCP tool for squash</name>
  <files>src/mcp/tools/squash.ts</files>
  <action>
    Create src/mcp/tools/squash.ts following the pattern from src/mcp/tools/remember.ts:

    1. Import server, schema validation from src/mcp/server.ts
    2. Create squashTool definition:
       - name: "squash"
       - description: "Compact old memory partitions to reduce repository size"
       - inputSchema: Zod schema with optional params:
         - partition: string (optional — specific partition to squash)
         - dryRun: boolean (optional — preview without changes)
         - aggressive: boolean (optional — squash git history)
       - handler: Async function that:
         - Validates inputs with Zod
         - Calls squashPartition from src/git/squash.ts
         - Returns { success, stats, message }

    3. Export registerSquashTool function that adds tool to MCP server
    4. Register tool in src/mcp/server.ts alongside recall, list_keys, etc.

    Follow hybrid response pattern from other tools (text response + structured data).
  </action>
  <verify>
    <automated>grep -q "squash" src/mcp/server.ts && echo "PASS: squash tool registered"</automated>
  </verify>
  <done>squash MCP tool created, registered, accepts partition/dryRun/aggressive params</done>
</task>

<task type="auto">
  <name>Task 3: Add CLI squash command</name>
  <files>src/cli/human.ts</files>
  <action>
    Add squash subcommand to src/cli/human.ts following existing command patterns:

    1. Add namespacesCommand-like structure for squashCommand:
       - Usage: duckbrain squash [options]
       - Options:
         - --partition <name> — Target specific partition
         - --dry-run — Preview without changes
         - --aggressive — Include git history squashing
         - --stats — Show compaction statistics

    2. Implement command handlers:
       - duckbrain squash --stats → Call getCompactionStats(), display table
       - duckbrain squash --dry-run → Call squashPartition with dryRun=true, show preview
       - duckbrain squash → Run full compaction with default options
       - duckbrain squash --partition <name> --aggressive → Targeted aggressive squash

    3. Add output formatting:
       - Before/after size comparison
       - Records removed (tombstones)
       - Git commits squashed (if applicable)
       - Time taken

    4. Update help text in CLI to include squash command
  </action>
  <verify>
    <automated>npx ts-node -e "import('./src/cli/human').then(m => console.log('squashCommand' in m ? 'PASS' : 'FAIL'))" 2>&1 | grep -q "PASS"</automated>
  </verify>
  <done>CLI squash command works: duckbrain squash --stats shows compaction status</done>
</task>

<task type="auto">
  <name>Task 4: Add squash configuration options</name>
  <files>src/config/index.ts</files>
  <action>
    Extend DuckBrainConfigSchema in src/config/index.ts with squash settings:

    1. Add squash object to schema:
       ```typescript
       squash: z.object({
         maxAgeDays: z.number().default(30), // Compact partitions older than N days
         thresholdRecords: z.number().default(1000), // Only compact if > N records
         autoCompact: z.boolean().default(false), // Enable background compaction
         squashGitHistory: z.boolean().default(true), // Rewrite git history
         compressionLevel: z.number().default(6) // Parquet compression (1-9)
       })
       ```

    2. Add default squash config to DEFAULT_CONFIG constant

    3. Update duckbrain config set command to accept squash.* keys:
       - duckbrain config set squash.maxAgeDays 60
       - duckbrain config set squash.autoCompact true

    4. Add validation: compressionLevel must be 1-9, maxAgeDays must be > 0
  </action>
  <verify>
    <automated>grep -q "squash" src/config/index.ts && grep -q "maxAgeDays" src/config/index.ts && echo "PASS"</automated>
  </verify>
  <done>Config schema includes squash settings, duckbrain config set squash.* works</done>
</task>

</tasks>

<verification>
- [ ] duckbrain squash --stats displays compaction statistics
- [ ] duckbrain squash --dry-run shows preview without modifying files
- [ ] MCP squash tool callable by agents
- [ ] Parquet files created for compacted partitions
- [ ] Tombstones removed during compaction
- [ ] Config options squash.* work via duckbrain config set
</verification>

<success_criteria>
1. Manual squash command works: duckbrain squash compacts old partitions
2. Dry-run mode shows what would be compacted without making changes
3. Stats command displays repository health (tombstone %, Parquet ratio)
4. MCP agents can call squash() tool with partition/dryRun/aggressive options
5. Configuration controls compaction behavior (maxAgeDays, thresholdRecords, autoCompact)
</success_criteria>

<output>
After completion, create .planning/phases/02-git-automation/02-git-auto-02-SUMMARY.md
</output>
