# Verdict: DF-0924-10

**Task:** Remove fictional npm install/upgrade path from agent-facing docs
**Evaluated:** 2026-10-03T02:15:33.810938
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: Command timed out
- ✗ **tier2**
  - INCOMPLETE
  ✗ grep across repo (excl .planning) shows zero 'npm install -g duckbrain' or npmjs duckbrain package references; .opencode/agents/duckbrain-cli.md documents the git-clone + pnpm install source path consistent with README: First half FAILS: `git grep -n "npm install -g duckbrain" -- . ':!.planning'` returns src/ssh/client.ts:326: `console.error(`  ssh ${host} "sudo npm install -g duckbrain"`);` — a user-facing instruction still printing the fictional npm install path (in installRemote(), alongside the real curl-from-GitHub-releases path). Additional npmjs-duckbrain references remain in .coding-hermes/board/tasks.jsonl:226, .coding-hermes/board/events.jsonl:1319, and .gitreins/history/*/commit.patch. Second half PASSES: .opencode/agents/duckbrain-cli.md lines 15-22 document `git clone <your-duckbrain-fork-or-release> && cd duckbrain && pnpm install --frozen-lockfile` with the note 'DuckBrain is not published to npm — this is the only path', consistent with README.md:220 (`git clone ... && cd duckbrain && pnpm install`). Because the criterion is conjunctive and the zero-reference requirement is violated, the criterion FAILS.
The agent doc was correctly rewritten to the git-clone + pnpm path, but the fictional `npm install -g duckbrain` string still exists in src/ssh/client.ts:326, so the zero-reference requirement is not met.

## Summary

Judge Result: DF-0924-10

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: Command timed out

Stage tier2: FAIL
  INCOMPLETE
  ✗ grep across repo (excl .planning) shows zero 'npm install -g duckbrain' or npmjs duckbrain package references; .opencode/agents/duckbrain-cli.md documents the git-clone + pnpm install source path consistent with README: First half FAILS: `git grep -n "npm install -g duckbrain" -- . ':!.planning'` returns src/ssh/client.ts:326: `console.error(`  ssh ${host} "sudo npm install -g duckbrain"`);` — a user-facing instruction still printing the fictional npm install path (in installRemote(), alongside the real curl-from-GitHub-releases path). Additional npmjs-duckbrain references remain in .coding-hermes/board/tasks.jsonl:226, .coding-hermes/board/events.jsonl:1319, and .gitreins/history/*/commit.patch. Second half PASSES: .opencode/agents/duckbrain-cli.md lines 15-22 document `git clone <your-duckbrain-fork-or-release> && cd duckbrain && pnpm install --frozen-lockfile` with the note 'DuckBrain is not published to npm — this is the only path', consistent with README.md:220 (`git clone ... && cd duckbrain && pnpm install`). Because the criterion is conjunctive and the zero-reference requirement is violated, the criterion FAILS.
The agent doc was correctly rewritten to the git-clone + pnpm path, but the fictional `npm install -g duckbrain` string still exists in src/ssh/client.ts:326, so the zero-reference requirement is not met.

Overall: FAIL ✗
