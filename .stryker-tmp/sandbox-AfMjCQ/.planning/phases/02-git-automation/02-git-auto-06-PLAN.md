---
phase: 02-git-automation
plan: 06
type: execute
wave: 1
depends_on: []
files_modified: [src/cli/human.ts, bin/duckbrain.ts]
autonomous: true
gap_closure: true

must_haves:
  truths:
    - "Squash command shows help without requiring namespace setup"
    - "'namespace' singular works as alias for 'namespaces' plural"
    - "Pull and push commands are accessible via CLI"
  artifacts:
    - path: "src/cli/human.ts"
      provides: "Squash command with --help flag handling"
      contains: "squashCommand with early --help check"
    - path: "bin/duckbrain.ts"
      provides: "CLI entry point with namespace alias and pull/push wiring"
      contains: "'namespace' case, 'pull' case, 'push' case, 'remote' case"
  key_links:
    - from: "bin/duckbrain.ts"
      to: "src/cli/human.ts:pullCommand|pushCommand|remoteCommand"
      via: "switch case routing"
      pattern: "case 'pull':|case 'push':|case 'remote':"
---

<objective>
Close UAT gaps: Fix CLI entry point wiring — squash --help, namespace alias, pull/push commands

Purpose: Address test failures where squash --help fails without namespace, 'namespace' singular is unknown, and pull/push commands are not accessible
Output: Fully wired CLI with all commands accessible and proper help handling
</objective>

<execution_context>
@/Users/lexykwaii/Code/duckbrain/.opencode/get-shit-done/workflows/execute-plan.md
@/Users/lexykwaii/Code/duckbrain/.opencode/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/02-git-automation/02-CONTEXT.md
@.planning/phases/02-git-automation/02-UAT.md
@.planning/phases/02-git-automation/02-git-auto-03-SUMMARY.md

**Gap details from UAT:**
- Test 2: Squash command fails with 'Compaction failed: Default namespace not found' on --help
- Test 4: 'namespace' singular unknown (only 'namespaces' plural works)
- Test 9: Pull/push commands unknown - not wired in CLI entry point

**Root causes:**
- squashCommand doesn't check for --help before executing
- bin/duckbrain.ts missing 'namespace' case in switch statement
- bin/duckbrain.ts missing pull/push/remote cases in switch statement
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add --help flag handling to squash command</name>
  <files>src/cli/human.ts</files>
  <action>
    Read src/cli/human.ts and locate the squashCommand function (around line 647-770).
    
    The function immediately tries to execute compaction without checking for --help flag first.
    
    Add early --help handling at the start of squashCommand:
    
    ```typescript
    async function squashCommand(args: string[]): Promise<void> {
      // Handle --help before any namespace checks
      if (args.includes('--help') || args.includes('-h')) {
        console.log(`Usage: duckbrain squash [options]`);
        console.log('');
        console.log('Options:');
        console.log('  --stats           Show compaction statistics');
        console.log('  --dry-run         Preview what would be compacted without making changes');
        console.log('  --partition <id>  Compact specific partition only');
        console.log('  --aggressive      More aggressive compaction (lower thresholds)');
        console.log('  --help, -h        Show this help message');
        console.log('');
        console.log('Squashes/compacts memory partitions by converting old JSONL files to Parquet');
        console.log('and removing tombstoned records. Also squashes git history for compacted partitions.');
        return;
      }
      
      // Rest of existing squashCommand implementation...
    }
    ```
    
    Ensure the help text is displayed before any namespace validation or compaction logic runs.
  </action>
  <verify>
    <automated>grep -q "args.includes('--help')" src/cli/human.ts && grep -q "squashCommand" src/cli/human.ts && echo "PASS" || echo "FAIL"</automated>
  </verify>
  <done>Squash command shows help without requiring namespace setup</done>
</task>

<task type="auto">
  <name>Task 2: Add 'namespace' singular alias to CLI router</name>
  <files>bin/duckbrain.ts</files>
  <action>
    Read bin/duckbrain.ts and locate the switch statement handling CLI commands (around line 95-102).
    
    Currently only 'namespaces' (plural) is handled. Add 'namespace' (singular) as an alias:
    
    Find the existing case:
    ```typescript
    case 'namespaces':
      await namespacesCommand(rest);
      break;
    ```
    
    Add the singular alias either as a fall-through or duplicate:
    ```typescript
    case 'namespace':
    case 'namespaces':
      await namespacesCommand(rest);
      break;
    ```
    
    Also update the help text to show 'namespace(s)' indicating both work:
    Find the help text section (around line 40-60) and update:
    - From: "namespace          Namespace management"
    - To: "namespace(s)       Namespace management"
  </action>
  <verify>
    <automated>grep -E "case 'namespace':" bin/duckbrain.ts | head -1 && echo "PASS" || echo "FAIL"</automated>
  </verify>
  <done>'namespace' singular works as alias for 'namespaces' plural</done>
</task>

<task type="auto">
  <name>Task 3: Wire pull/push/remote commands in CLI router</name>
  <files>bin/duckbrain.ts</files>
  <action>
    Read bin/duckbrain.ts and identify all existing command cases in the switch statement.
    
    The handlers exist in src/cli/human.ts (pullCommand, pushCommand, remoteCommand) but are not wired in bin/duckbrain.ts.
    
    Add cases for pull, push, and remote commands:
    
    ```typescript
    case 'pull':
      await pullCommand(rest);
      break;
    
    case 'push':
      await pushCommand(rest);
      break;
    
    case 'remote':
      await remoteCommand(rest);
      break;
    ```
    
    Also add import for these commands at the top of bin/duckbrain.ts if not already present:
    ```typescript
    import {
      // ... existing imports ...
      pullCommand,
      pushCommand,
      remoteCommand,
    } from '../src/cli/human';
    ```
    
    Update help text to document these commands:
    ```
    pull              Pull changes from remote repository
    push              Push changes to remote repository
    remote            Configure remote repository
    ```
  </action>
  <verify>
    <automated>grep -q "case 'pull':" bin/duckbrain.ts && grep -q "case 'push':" bin/duckbrain.ts && grep -q "case 'remote':" bin/duckbrain.ts && echo "PASS" || echo "FAIL"</automated>
  </verify>
  <done>Pull, push, and remote commands accessible via CLI</done>
</task>

</tasks>

<verification>
- [ ] `duckbrain squash --help` shows usage without namespace error
- [ ] `duckbrain namespace --help` works (singular alias)
- [ ] `duckbrain pull --help` shows usage
- [ ] `duckbrain push --help` shows usage
- [ ] `duckbrain remote --help` shows usage
- [ ] All commands in help text are actually wired
</verification>

<success_criteria>
1. Squash --help displays help without requiring namespace setup
2. Both 'namespace' and 'namespaces' work as CLI commands
3. Pull/push/remote commands accessible and show help
4. All commands listed in help text are functional
5. No "command unknown" errors for documented commands
</success_criteria>

<output>
After completion, create .planning/phases/02-git-automation/02-git-auto-06-SUMMARY.md
</output>
