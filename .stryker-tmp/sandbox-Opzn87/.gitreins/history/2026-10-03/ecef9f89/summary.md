# Verdict: DF-0924-10

**Task:** Remove fictional npm install/upgrade path from agent-facing docs (re-judge after src fix 09b0dff)
**Evaluated:** 2026-10-03T03:22:28.445735
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.2 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ grep across the repo EXCLUDING append-only records (.gitreins/ and .coding-hermes/) and historical planning (.planning/) shows zero 'npm install -g duckbrain' or npmjs.org/package/duckbrain references in docs AND src; .opencode/agents/duckbrain-cli.md documents the git-clone + pnpm install --frozen-lockfile source path consistent with README.md: git grep for 'npm install -g duckbrain' and 'npmjs.org/package/duckbrain' excluding .gitreins/.coding-hermes/.planning returns ZERO matches in docs AND src (only hits are inside the excluded dirs: .gitreins/tasks.yaml:2271, .coding-hermes/board/*, .planning/phases/*). src fix 09b0dff removed the fictional 'sudo npm install -g duckbrain' line from src/ssh/client.ts (now src/ssh/client.ts:324-332 points to the GitHub release binary with note 'DuckBrain is not published to npm'). .opencode/agents/duckbrain-cli.md:15-16 documents 'git clone <your-duckbrain-fork-or-release> && cd duckbrain && pnpm install --frozen-lockfile' with comment 'DuckBrain is not published to npm — this is the only path', consistent with README.md:96-101 (git clone https://github.com/wojons/duckbrain.git + pnpm install) and README.md:220. Test evidence: `npx vitest run src/ssh/client.test.ts` → 'Test Files 1 passed (1), Tests 11 passed (11)'. Remaining npm+duckbrain co-occurrences are pnpm, the agent doc's explicit 'not published to npm' statement, or historical dogfood E404 notes — none are install instructions. [resolution 0.16; .opencode/agents/duckbrain-cli.md, README.md]
The fictional npm install/upgrade path is fully removed from docs and src (only excluded append-only/planning dirs retain it), and the agent doc's git-clone + pnpm install --frozen-lockfile path matches README.md.

## Summary

Judge Result: DF-0924-10

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.2 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ grep across the repo EXCLUDING append-only records (.gitreins/ and .coding-hermes/) and historical planning (.planning/) shows zero 'npm install -g duckbrain' or npmjs.org/package/duckbrain references in docs AND src; .opencode/agents/duckbrain-cli.md documents the git-clone + pnpm install --frozen-lockfile source path consistent with README.md: git grep for 'npm install -g duckbrain' and 'npmjs.org/package/duckbrain' excluding .gitreins/.coding-hermes/.planning returns ZERO matches in docs AND src (only hits are inside the excluded dirs: .gitreins/tasks.yaml:2271, .coding-hermes/board/*, .planning/phases/*). src fix 09b0dff removed the fictional 'sudo npm install -g duckbrain' line from src/ssh/client.ts (now src/ssh/client.ts:324-332 points to the GitHub release binary with note 'DuckBrain is not published to npm'). .opencode/agents/duckbrain-cli.md:15-16 documents 'git clone <your-duckbrain-fork-or-release> && cd duckbrain && pnpm install --frozen-lockfile' with comment 'DuckBrain is not published to npm — this is the only path', consistent with README.md:96-101 (git clone https://github.com/wojons/duckbrain.git + pnpm install) and README.md:220. Test evidence: `npx vitest run src/ssh/client.test.ts` → 'Test Files 1 passed (1), Tests 11 passed (11)'. Remaining npm+duckbrain co-occurrences are pnpm, the agent doc's explicit 'not published to npm' statement, or historical dogfood E404 notes — none are install instructions. [resolution 0.16; .opencode/agents/duckbrain-cli.md, README.md]
The fictional npm install/upgrade path is fully removed from docs and src (only excluded append-only/planning dirs retain it), and the agent doc's git-clone + pnpm install --frozen-lockfile path matches README.md.

Overall: FAIL ✗
