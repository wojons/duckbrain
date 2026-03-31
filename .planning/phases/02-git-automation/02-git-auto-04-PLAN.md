---
phase: 02-git-automation
plan: 04
type: execute
wave: 1
depends_on: []
files_modified: [src/mcp/server.ts]
autonomous: true
requirements: [NAMESPACE-01, NAMESPACE-02]
gap_closure: true

must_haves:
  truths:
    - "Agent can create/switch/list/delete namespaces via MCP tools"
    - "Namespace tools appear in MCP server's available tools list"
  artifacts:
    - path: "src/mcp/server.ts"
      provides: "MCP tool registration"
      contains: "import namespace tools + registerTool calls"
  key_links:
    - from: "src/mcp/server.ts"
      to: "src/mcp/tools/namespace.ts"
      via: "import and registerTool"
      pattern: "createNamespaceTool|listNamespacesTool|switchNamespaceTool|deleteNamespaceTool"
---

<objective>
Close verification gap: Register namespace MCP tools in server.ts

Purpose: Fix failed verification truth "Agent can create/switch/list namespaces via MCP tools" — tools exist but are not registered
Output: server.ts imports and registers all 4 namespace tools
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
@.planning/phases/02-git-automation/02-VERIFICATION.md
@.planning/codebase/ARCHITECTURE.md
@.planning/codebase/CONVENTIONS.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Import namespace tools in server.ts</name>
  <files>src/mcp/server.ts</files>
  <action>
    Add import statement to src/mcp/server.ts (after line 14, with other tool imports):

    ```typescript
    import { 
      createNamespaceTool, 
      listNamespacesTool, 
      switchNamespaceTool, 
      deleteNamespaceTool 
    } from './tools/namespace';
    ```

    This follows the existing import pattern used for recall, list_keys, remember, forget, and squash tools.
  </action>
  <verify>
    <automated>grep -q "createNamespaceTool.*listNamespacesTool.*switchNamespaceTool.*deleteNamespaceTool" src/mcp/server.ts && echo "PASS"</automated>
  </verify>
  <done>Import statement added, TypeScript compiles without errors</done>
</task>

<task type="auto">
  <name>Task 2: Register namespace tools in server.ts</name>
  <files>src/mcp/server.ts</files>
  <action>
    Add 4 registerTool calls to registerTools() function in src/mcp/server.ts (after compactionStatsToolDef registration, before line 96):

    ```typescript
    server.registerTool('create_namespace', {
      title: 'Create Namespace',
      description: 'Create a new memory namespace (separate git repo)',
      inputSchema: { /* schema from namespace.ts */ }
    }, wrapHandler(createNamespaceTool));

    server.registerTool('list_namespaces', {
      title: 'List Namespaces',
      description: 'List all available namespaces',
      inputSchema: {}
    }, wrapHandler(listNamespacesTool));

    server.registerTool('switch_namespace', {
      title: 'Switch Namespace',
      description: 'Switch to a different namespace',
      inputSchema: { /* schema from namespace.ts */ }
    }, wrapHandler(switchNamespaceTool));

    server.registerTool('delete_namespace', {
      title: 'Delete Namespace',
      description: 'Delete a namespace (requires confirmation)',
      inputSchema: { /* schema from namespace.ts */ }
    }, wrapHandler(deleteNamespaceTool));
    ```

    For inputSchema, import the schemas from namespace.ts or define inline matching the schemas already in namespace.ts:
    - create_namespace: { name: string, setDefault?: boolean }
    - list_namespaces: {} (empty)
    - switch_namespace: { name: string }
    - delete_namespace: { name: string, confirm: boolean }
  </action>
  <verify>
    <automated>grep -q "create_namespace\|list_namespaces\|switch_namespace\|delete_namespace" src/mcp/server.ts && echo "PASS"</automated>
  </verify>
  <done>All 4 namespace tools registered: create_namespace, list_namespaces, switch_namespace, delete_namespace</done>
</task>

</tasks>

<verification>
- [ ] src/mcp/server.ts imports namespace tools
- [ ] src/mcp/server.ts registers all 4 namespace tools
- [ ] TypeScript compiles: npx tsc --noEmit
- [ ] MCP server starts without errors
- [ ] Namespace tools appear in available tools list
</verification>

<success_criteria>
1. Import statement present in server.ts for namespace tools
2. All 4 namespace tools registered with correct names: create_namespace, list_namespaces, switch_namespace, delete_namespace
3. Tools callable by MCP clients
4. Verification gap closed: "Agent can create/switch/list namespaces via MCP tools" now achievable
</success_criteria>

<output>
After completion, create .planning/phases/02-git-automation/02-git-auto-04-SUMMARY.md
</output>
