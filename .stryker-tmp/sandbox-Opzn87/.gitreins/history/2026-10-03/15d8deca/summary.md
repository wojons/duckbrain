# Verdict: DF-0924-10

**Task:** Remove fictional npm install/upgrade path from agent-facing docs (re-judge after src fix 09b0dff)
**Evaluated:** 2026-10-03T02:47:18.232661
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: Command timed out
- ✓ **tier2**
  - COMPLETE
  ✓ grep across the repo EXCLUDING append-only records (.gitreins/ and .coding-hermes/) and historical planning (.planning/) shows zero 'npm install -g duckbrain' or npmjs.org/package/duckbrain references in docs AND src; .opencode/agents/duckbrain-cli.md documents the git-clone + pnpm install --frozen-lockfile source path consistent with README.md: `git grep -n "npm install -g duckbrain\|npmjs.org/package/duckbrain" -- . ':(exclude).gitreins' ':(exclude).coding-hermes' ':(exclude).planning'` returned exit 1 (zero matches) across all tracked files. Targeted greps of src/ (exit 1), docs/, design/, assets/, .github/, .opencode/, bin/, and root *.md all returned zero. The only match anywhere was dist/src/ssh/client.js:260, a stale build artifact — dist/ is git-ignored (git check-ignore exit 0) and untracked (git ls-files empty), so it is neither src nor docs. src fix 09b0dff replaced `sudo npm install -g duckbrain` in src/ssh/client.ts with the curl release-binary path plus '(DuckBrain is not published to npm...)'. .opencode/agents/duckbrain-cli.md:16 and :398 document `git clone <your-duckbrain-fork-or-release> && cd duckbrain && pnpm install --frozen-lockfile` and state 'DuckBrain is not published to npm — this is the only path', consistent with README.md:97/101 (git clone + pnpm install), README.md:220 (identical one-liner), and docs/guide/getting-started.md:52 (pnpm install --frozen-lockfile). Tests: `npx vitest run src/ssh/client.test.ts` => 'Test Files 1 passed (1)', 'Tests 11 passed (11)'. [resolution 0.16; .opencode/agents/duckbrain-cli.md, README.md]
Zero npm-install/npmjs references remain in tracked docs and src (only a git-ignored stale dist artifact), and the agent doc's git-clone + pnpm install --frozen-lockfile source path matches README.md.

## Summary

Judge Result: DF-0924-10

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: Command timed out

Stage tier2: PASS
  COMPLETE
  ✓ grep across the repo EXCLUDING append-only records (.gitreins/ and .coding-hermes/) and historical planning (.planning/) shows zero 'npm install -g duckbrain' or npmjs.org/package/duckbrain references in docs AND src; .opencode/agents/duckbrain-cli.md documents the git-clone + pnpm install --frozen-lockfile source path consistent with README.md: `git grep -n "npm install -g duckbrain\|npmjs.org/package/duckbrain" -- . ':(exclude).gitreins' ':(exclude).coding-hermes' ':(exclude).planning'` returned exit 1 (zero matches) across all tracked files. Targeted greps of src/ (exit 1), docs/, design/, assets/, .github/, .opencode/, bin/, and root *.md all returned zero. The only match anywhere was dist/src/ssh/client.js:260, a stale build artifact — dist/ is git-ignored (git check-ignore exit 0) and untracked (git ls-files empty), so it is neither src nor docs. src fix 09b0dff replaced `sudo npm install -g duckbrain` in src/ssh/client.ts with the curl release-binary path plus '(DuckBrain is not published to npm...)'. .opencode/agents/duckbrain-cli.md:16 and :398 document `git clone <your-duckbrain-fork-or-release> && cd duckbrain && pnpm install --frozen-lockfile` and state 'DuckBrain is not published to npm — this is the only path', consistent with README.md:97/101 (git clone + pnpm install), README.md:220 (identical one-liner), and docs/guide/getting-started.md:52 (pnpm install --frozen-lockfile). Tests: `npx vitest run src/ssh/client.test.ts` => 'Test Files 1 passed (1)', 'Tests 11 passed (11)'. [resolution 0.16; .opencode/agents/duckbrain-cli.md, README.md]
Zero npm-install/npmjs references remain in tracked docs and src (only a git-ignored stale dist artifact), and the agent doc's git-clone + pnpm install --frozen-lockfile source path matches README.md.

Overall: FAIL ✗
