---
phase: 02-git-automation
plan: 05
type: execute
wave: 1
depends_on: []
files_modified: [src/config/index.ts, src/cli/human.ts]
autonomous: true
gap_closure: true

must_haves:
  truths:
    - "Config CLI 'get' subcommand exists and works"
    - "Git batching config accessible via git.batchLines and git.batchIntervalSeconds"
    - "authorEmail has default value preventing validation errors"
  artifacts:
    - path: "src/config/index.ts"
      provides: "Config schema with defaults and nested gitBatching exposed as flat keys"
      exports: ["gitBatching", "authorEmail"]
    - path: "src/cli/human.ts"
      provides: "Config CLI handlers for get/set with aligned key names"
      contains: "config get subcommand"
  key_links:
    - from: "src/cli/human.ts configCommand"
      to: "src/config/index.ts schema"
      via: "aligned key names"
      pattern: "git\\.batchLines"
---

<objective>
Close UAT gaps: Fix config CLI/schema alignment and add authorEmail default

Purpose: Address test failures where config CLI uses flat keys (git.batchLines) but schema uses nested (gitBatching.maxLines), and authorEmail lacks default causing validation errors
Output: Working config get/set with aligned key names and no validation failures
</objective>

<execution_context>
@/Users/lexykwaii/Code/duckbrain/.opencode/get-shit-done/workflows/execute-plan.md
@/Users/lexykwaii/Code/duckbrain/.opencode/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/02-git-automation/02-CONTEXT.md
@.planning/phases/02-git-automation/02-UAT.md
@.planning/REQUIREMENTS.md

**Gap details from UAT:**
- Test 1: Config subcommand 'get' doesn't exist. Config show fails with validation error about missing authorEmail. Git batch config options not found in schema.
- Root cause: Schema has gitBatching object but CLI uses flat keys. authorEmail has no default.
- Artifacts: src/config/index.ts (authorEmail default), src/cli/human.ts (key alignment)
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add authorEmail default in config schema</name>
  <files>src/config/index.ts</files>
  <action>
    Read src/config/index.ts and find the DuckBrainConfigSchema definition.
    
    Locate the authorEmail field (likely around line 50-80) and add a .default() value.
    
    The field currently looks like:
    ```typescript
    authorEmail: z.string().email().describe("Git author email for attribution"),
    ```
    
    Change it to:
    ```typescript
    authorEmail: z.string().email().default("duckbrain@localhost").describe("Git author email for attribution"),
    ```
    
    This prevents validation errors when config is accessed before user sets their email.
  </action>
  <verify>
    <automated>grep -q 'authorEmail.*default' src/config/index.ts && echo "PASS" || echo "FAIL"</automated>
  </verify>
  <done>authorEmail field has .default() value preventing validation errors</done>
</task>

<task type="auto">
  <name>Task 2: Add config 'get' subcommand handler</name>
  <files>src/cli/human.ts</files>
  <action>
    Read src/cli/human.ts and locate the configCommand function (around line 770-850).
    
    The current config command likely only supports 'set' and 'show'. Add a 'get' subcommand that retrieves a specific config value by key.
    
    Add handler for:
    - `duckbrain config get <key>` — returns the value for that key
    
    Example implementation to add in the switch/if block handling config subcommands:
    ```typescript
    } else if (subcommand === 'get') {
      const key = args[1];
      if (!key) {
        console.error('Usage: duckbrain config get <key>');
        process.exit(1);
      }
      const value = await getConfigValue(key);
      console.log(value);
    }
    ```
    
    Also add getConfigValue helper function if it doesn't exist:
    ```typescript
    async function getConfigValue(key: string): Promise<string | number | boolean | undefined> {
      const config = await loadConfig();
      const keys = key.split('.');
      let value: any = config;
      for (const k of keys) {
        value = value?.[k];
      }
      return value;
    }
    ```
    
    Update help text to include 'get' subcommand.
  </action>
  <verify>
    <automated>grep -q "config get" src/cli/human.ts && grep -q "subcommand === 'get'" src/cli/human.ts && echo "PASS" || echo "FAIL"</automated>
  </verify>
  <done>Config 'get' subcommand exists and retrieves values by key</done>
</task>

<task type="auto">
  <name>Task 3: Align config CLI keys with schema structure</name>
  <files>src/cli/human.ts</files>
  <action>
    Read src/cli/human.ts config command handlers.
    
    The CLI currently uses flat keys like "git.batchLines" but schema uses nested "gitBatching.maxLines".
    
    Add key mapping in the config set/get handlers to translate between user-friendly flat keys and schema structure:
    
    ```typescript
    // Key mapping for user-friendly flat keys
    const KEY_MAP: Record<string, string> = {
      'git.batchLines': 'gitBatching.maxLines',
      'git.batchIntervalSeconds': 'gitBatching.intervalSeconds',
      'git.autoCompact': 'gitBatching.autoCompact',
    };
    
    function resolveKey(userKey: string): string {
      return KEY_MAP[userKey] || userKey;
    }
    ```
    
    Update config set handler to use resolveKey() before setting values.
    Update config get handler to check both mapped and unmapped keys.
    
    Also update help text to document the available config keys with their flat names.
  </action>
  <verify>
    <automated>grep -q "git.batchLines" src/cli/human.ts && grep -q "gitBatching" src/cli/human.ts && echo "PASS" || echo "FAIL"</automated>
  </verify>
  <done>Config CLI uses flat keys (git.batchLines) that map to schema structure (gitBatching.maxLines)</done>
</task>

</tasks>

<verification>
- [ ] authorEmail has .default() in schema
- [ ] Config 'get' subcommand works: `duckbrain config get git.batchLines`
- [ ] Config keys are aligned: git.batchLines maps to gitBatching.maxLines
- [ ] Config validation passes without errors
</verification>

<success_criteria>
1. `duckbrain config get git.batchLines` returns the configured value
2. `duckbrain config get authorEmail` returns default if not set
3. `duckbrain config show` works without validation errors
4. Config CLI keys match user expectations from CONTEXT decisions
</success_criteria>

<output>
After completion, create .planning/phases/02-git-automation/02-git-auto-05-SUMMARY.md
</output>
