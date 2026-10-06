# Verdict: DF-0924-10

**Task:** Remove fictional npm install/upgrade path from agent-facing docs (re-judge after src fix 09b0dff)
**Evaluated:** 2026-10-03T02:27:23.332626
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: Command timed out
- ✓ **tier2**
  - COMPLETE
  ✓ grep across the repo EXCLUDING append-only records (.gitreins/ and .coding-hermes/) and historical planning (.planning/) shows zero 'npm install -g duckbrain' or npmjs.org/package/duckbrain references in docs AND src; .opencode/agents/duckbrain-cli.md documents the git-clone + pnpm install --frozen-lockfile source path consistent with README.md: git grep -n 'npm install -g duckbrain' -- . ':(exclude).gitreins' ':(exclude).coding-hermes' ':(exclude).planning' returned EXIT:1 (zero matches); same for 'npmjs.org/package/duckbrain' (EXIT:1). Untracked-file grep (excluding node_modules/.git/etc.) also returned EXIT:1. src has no such refs (only src/utils/dependency-declaration.test.ts:9 mentions 'pnpm install --frozen-lockfile'). .opencode/agents/duckbrain-cli.md:15-16 and :397-398 document 'git clone <your-duckbrain-fork-or-release> && cd duckbrain && pnpm install --frozen-lockfile' with the note 'DuckBrain is not published to npm — this is the only path', consistent with README.md:220 (same placeholder) and docs/guide/getting-started.md:52. The only 'npm install -g' hit is a generic template line in .opencode/get-shit-done/templates/codebase/stack.md:149, not duckbrain-specific. [resolution 0.15; .opencode/agents/duckbrain-cli.md, README.md]
Both forbidden npm patterns are absent repo-wide (excluding the three dirs) and the agent doc documents the git-clone + pnpm install --frozen-lockfile source path consistent with README.md.

## Summary

Judge Result: DF-0924-10

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: Command timed out

Stage tier2: PASS
  COMPLETE
  ✓ grep across the repo EXCLUDING append-only records (.gitreins/ and .coding-hermes/) and historical planning (.planning/) shows zero 'npm install -g duckbrain' or npmjs.org/package/duckbrain references in docs AND src; .opencode/agents/duckbrain-cli.md documents the git-clone + pnpm install --frozen-lockfile source path consistent with README.md: git grep -n 'npm install -g duckbrain' -- . ':(exclude).gitreins' ':(exclude).coding-hermes' ':(exclude).planning' returned EXIT:1 (zero matches); same for 'npmjs.org/package/duckbrain' (EXIT:1). Untracked-file grep (excluding node_modules/.git/etc.) also returned EXIT:1. src has no such refs (only src/utils/dependency-declaration.test.ts:9 mentions 'pnpm install --frozen-lockfile'). .opencode/agents/duckbrain-cli.md:15-16 and :397-398 document 'git clone <your-duckbrain-fork-or-release> && cd duckbrain && pnpm install --frozen-lockfile' with the note 'DuckBrain is not published to npm — this is the only path', consistent with README.md:220 (same placeholder) and docs/guide/getting-started.md:52. The only 'npm install -g' hit is a generic template line in .opencode/get-shit-done/templates/codebase/stack.md:149, not duckbrain-specific. [resolution 0.15; .opencode/agents/duckbrain-cli.md, README.md]
Both forbidden npm patterns are absent repo-wide (excluding the three dirs) and the agent doc documents the git-clone + pnpm install --frozen-lockfile source path consistent with README.md.

Overall: FAIL ✗
