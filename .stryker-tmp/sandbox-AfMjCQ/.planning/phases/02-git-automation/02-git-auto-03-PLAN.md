---
phase: 02-git-automation
plan: 03
type: execute
wave: 2
depends_on: [02-git-auto-02]
files_modified: [src/git/merge.ts, src/cli/human.ts, src/mcp/tools/namespace.ts, src/config/index.ts]
autonomous: true
requirements: [GIT-03, NAMESPACE-01, NAMESPACE-02, NAMESPACE-03]
user_setup: []

must_haves:
  truths:
    - "User can list/create/delete/switch namespaces via CLI"
    - "Agent can create/switch/list namespaces via MCP tools"
    - "Merge conflicts auto-resolve by appending both versions"
    - "All writes stamped with git email for attribution"
    - "Shared origin pull/push works across namespaces"
  artifacts:
    - path: "src/git/merge.ts"
      provides: "Merge conflict resolution logic"
      exports: ["resolveMergeConflict", "autoMerge", "logMergeActivity"]
    - path: "src/mcp/tools/namespace.ts"
      provides: "Namespace MCP tools"
      exports: ["createNamespaceTool", "listNamespacesTool", "switchNamespaceTool", "deleteNamespaceTool"]
    - path: "src/cli/human.ts"
      provides: "Namespace CLI commands"
      contains: "namespace create|list|delete|use commands"
  key_links:
    - from: "src/git/merge.ts"
      to: "src/storage/jsonl.ts"
      via: "append-only merge"
      pattern: "appendMemory|writeChunk"
    - from: "src/mcp/tools/namespace.ts"
      to: "src/config/index.ts"
      via: "namespaceMappings updates"
      pattern: "registerNamespace|updateConfig"

---

<objective>
Implement merge conflict resolution (GIT-03) and multi-namespace management (NAMESPACE-01..03)

Purpose: Enable collaborative sharing via git push/pull with auto-resolving merges, full namespace management across CLI/MCP/API
Output: Merge resolver, namespace CLI commands, namespace MCP tools, multi-user attribution
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
@.planning/phases/01-core-mvp/01-CONTEXT.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create merge conflict resolver</name>
  <files>src/git/merge.ts</files>
  <action>
    Create src/git/merge.ts with append-only merge logic:

    1. **resolveMergeConflict(theirs, ours, options)**:
       - Accept: theirs (remote JSONL content), ours (local JSONL), options
       - Parse both as line-by-line JSON records
       - Deduplicate by UUID field (id)
       - Append unique records from theirs to ours
       - Log merge activity with timestamps
       - Return merged content with stats

    2. **autoMerge(remotePath, localPath)**:
       - Called during git pull when conflicts detected
       - Read both versions
       - Call resolveMergeConflict
       - Write merged result
       - Stage for commit
       - Return { success, mergedCount, skippedCount }

    3. **logMergeActivity(merge)**:
       - Append entry to conflicts.log in namespace directory
       - Include: timestamp, source (remote URL), records merged, tombstones handled
       - Format: JSONL for easy querying

    4. **detectDuplicates(records)**:
       - Group records by UUID
       - Return duplicates array
       - Used for deduplication stats

    Key principle: Never fail a merge — append-only architecture means conflicts always resolvable.
    Use UUID-based deduplication (from SCHEMA-01).
    Follow logging pattern from src/storage/manifest.ts.
  </action>
  <verify>
    <automated>npx ts-node -e "import { resolveMergeConflict } from './src/git/merge'; console.log('merge module loads')" 2>&1 | grep -q "merge module loads" && echo "PASS"</automated>
  </verify>
  <done>merge.ts created with 4 exported functions, UUID-based deduplication works</done>
</task>

<task type="auto">
  <name>Task 2: Add namespace CLI commands</name>
  <files>src/cli/human.ts</files>
  <action>
    Extend src/cli/human.ts with full namespace management commands:

    1. **namespace create <name> [options]**:
       - Create new directory in namespaces/<name>/
       - Initialize git repo (git init)
       - Create initial manifest.json
       - Update duckbrain.config.json with namespaceMappings[name] = path
       - Set as default if --default flag provided
       - Output: "Created namespace '<name>' at <path>"

    2. **namespace list**:
       - Read namespaceMappings from config
       - Display table: name, path, isDefault, lastAccessed
       - Show git remote URL if configured
       - Highlight current active namespace

    3. **namespace delete <name>**:
       - Require --force flag for safety
       - Remove from namespaceMappings
       - Optionally delete directory (--purge flag)
       - Warn about data loss
       - Output: "Deleted namespace '<name>'"

    4. **namespace use <name>** (alias: namespace switch):
       - Validate namespace exists
       - Update currentNamespace in config
       - Output: "Switched to namespace '<name>'"
       - All subsequent operations use this namespace

    5. **namespace set-remote <name> <url>**:
       - Configure git remote for namespace
       - Enable push/pull sharing
       - Output: "Set remote for '<name>' to <url>"

    Follow existing command patterns in human.ts.
    Use config update pattern from src/config/index.ts (atomic writes).
  </action>
  <verify>
    <automated>npx ts-node -e "import('./src/cli/human').then(m => console.log('namespaceCommand' in m ? 'PASS' : 'FAIL'))" 2>&1 | grep -q "PASS"</automated>
  </verify>
  <done>CLI namespace commands work: duckbrain namespace create|list|use|delete|set-remote</done>
</task>

<task type="auto">
  <name>Task 3: Add namespace MCP tools</name>
  <files>src/mcp/tools/namespace.ts</files>
  <action>
    Create src/mcp/tools/namespace.ts with 4 MCP tools:

    1. **create_namespace tool**:
       - name: "create_namespace"
       - description: "Create a new memory namespace (separate git repo)"
       - inputSchema: { name: string, setDefault: boolean (optional) }
       - handler: Create namespace, update config, return { success, path }

    2. **list_namespaces tool**:
       - name: "list_namespaces"
       - description: "List all available namespaces"
       - inputSchema: {} (empty)
       - handler: Read config, return { namespaces: [{name, path, isDefault}] }

    3. **switch_namespace tool**:
       - name: "switch_namespace"
       - description: "Switch to a different namespace"
       - inputSchema: { name: string }
       - handler: Validate, update config, return { success, previous, current }

    4. **delete_namespace tool**:
       - name: "delete_namespace"
       - description: "Delete a namespace (requires confirmation)"
       - inputSchema: { name: string, confirm: boolean }
       - handler: Require confirm=true, delete, return { success }

    Register all tools in src/mcp/server.ts.
    Follow tool pattern from src/mcp/tools/recall.ts.
    Include Zod validation on all inputs.
  </action>
  <verify>
    <automated>grep -q "create_namespace\|list_namespaces\|switch_namespace\|delete_namespace" src/mcp/tools/namespace.ts && echo "PASS"</automated>
  </verify>
  <done>4 namespace MCP tools created, registered, callable by agents</done>
</task>

<task type="auto">
  <name>Task 4: Add multi-user attribution</name>
  <files>src/mcp/tools/remember.ts, src/cli/human.ts</files>
  <action>
    Stamp all writes with git email for attribution (NAMESPACE-02):

    1. Create src/git/attribution.ts:
       - getAuthorEmail(): Read from git config or process.env
       - getAuthorName(): Read from git config or process.env
       - Export { email, name } object

    2. Modify src/mcp/tools/remember.ts:
       - Import getAuthorEmail from src/git/attribution.ts
       - Add author field to memory record: { ..., author: getAuthorEmail() }
       - Include in remember() tool response

    3. Modify src/cli/human.ts remember command:
       - Same attribution pattern
       - Display author in output

    4. Modify src/git/merge.ts:
       - Use author field for deduplication context
       - Log which authors' memories were merged

    This enables shared namespaces where multiple users contribute memories.
    Author field already in schema from SCHEMA-01 — just populate it.
  </action>
  <verify>
    <automated>grep -q "author" src/mcp/tools/remember.ts && grep -q "getAuthorEmail" src/mcp/tools/remember.ts && echo "PASS"</automated>
  </verify>
  <done>All writes include author field from git config, visible in responses</done>
</task>

<task type="auto">
  <name>Task 5: Add pull/push for shared origins</name>
  <files>src/git/remote.ts, src/cli/human.ts</files>
  <action>
    Enable collaborative memory sharing (NAMESPACE-03):

    1. Create src/git/remote.ts:
       - pull(namespace): git pull --no-commit, then call autoMerge from merge.ts
       - push(namespace): git push to configured remote
       - addRemote(namespace, url): git remote add
       - removeRemote(namespace): git remote remove
       - getRemote(namespace): return configured remote URL

    2. Add CLI commands to src/cli/human.ts:
       - duckbrain pull [namespace] — Pull and auto-merge
       - duckbrain push [namespace] — Push to remote
       - duckbrain remote add <namespace> <url>
       - duckbrain remote remove <namespace>

    3. Add MCP tools:
       - pull_memories(namespace?: string)
       - push_memories(namespace?: string)

    4. Handle merge conflicts:
       - On pull, if conflicts detected, call autoMerge from merge.ts
       - Log merge activity to conflicts.log
       - Commit merged result with message "Merge from <remote>"

    This enables collaborative workflows: user A pushes, user B pulls and auto-merges.
  </action>
  <verify>
    <automated>test -f src/git/remote.ts && grep -q "pull\|push" src/git/remote.ts && echo "PASS"</automated>
  </verify>
  <done>duckbrain pull/push commands work, auto-merge on conflicts, MCP tools available</done>
</task>

</tasks>

<verification>
- [ ] duckbrain namespace create|list|use|delete commands work
- [ ] MCP tools: create_namespace, list_namespaces, switch_namespace, delete_namespace
- [ ] All memories include author field from git config
- [ ] duckbrain pull auto-merges conflicts
- [ ] duckbrain push pushes to configured remote
- [ ] conflicts.log tracks merge activity
- [ ] Multiple namespaces can be created and switched between
</verification>

<success_criteria>
1. CLI namespace management: create, list, delete, switch all work
2. MCP agents can manage namespaces via 4 tools
3. All writes include author attribution (git email)
4. Pull/push enables collaborative sharing
5. Merge conflicts auto-resolve by appending both versions (never fail)
6. conflicts.log provides audit trail of all merges
</success_criteria>

<output>
After completion, create .planning/phases/02-git-automation/02-git-auto-03-SUMMARY.md
</output>
