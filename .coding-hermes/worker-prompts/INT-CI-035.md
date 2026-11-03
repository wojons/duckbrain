# Worker brief — INT-CI-035 (wave of 1, tick duckbrain-foreman-2026-10-31-17-10-06)

TASK: Fix board row INT-CI-035 — "CI red on main since e39a1110: keyword search returns one fewer hit (expected 3, got 2) in search-retr001 + search-retr008".

You are working in the git worktree /home/kara/worktrees/duckbrain-INT-CI-035 on branch wt/INT-CI-035 (base origin/main 51d2661e). Work ONLY in this worktree. Commit on this branch, then push it to origin.

REPRO (currently red on your base):
  cd /home/kara/worktrees/duckbrain-INT-CI-035 && pnpm exec vitest run src/search/search-retr001.test.ts src/search/search-retr008.test.ts
  -> Test Files 2 failed (2), Tests 8 failed | 23 passed (31)
Failures are pure result-count off-by-ones: AssertionError "expected 2 to be 3" (src/search/search-retr001.test.ts lines 252,309,372,398,411) and "expected 1 to be 2" (src/search/search-retr008.test.ts lines 162,243,258). All concern snippet/highlight surfaces ("finds GAP-020 with the exact-token memory first and a snippet", "searchTool returns highlightedSnippet", "recallTool contains= returns the highlight").

REGRESSION WINDOW (investigated by the foreman; verify, do not assume): exactly one commit — e39a1110 "fix(TESTQ-2026-10-30-1): refuse absent ticket-ID queries" changed ONLY src/search/query.ts (+18/−3): ticket-ID-like queries (letters+digits+hyphens) now require an exact literal match (tier 0), and a well-formed but absent ticket ID returns zero results instead of a lower-tier false positive. That change now also drops one matching memory from ordinary keyword queries (e.g. contains="GAP-020"), breaking the documented counts (RETR-001 keyword set expects 3 hits; RETR-008 highlight set expects 2). Find the exact drop with `git diff e39a1110^ e39a1110 -- src/search/query.ts` and by tracing the query pipeline (src/search/query.ts and its callers, e.g. src/search/*.ts, recall contains path). Fix the PRODUCT code so the refusal behavior stays scoped to ticket-ID-like queries.

ACCEPTANCE (board row INT-CI-035):
1) `pnpm exec vitest run src/search/search-retr001.test.ts src/search/search-retr008.test.ts` exits 0 with the documented counts restored (RETR-001 keyword set 3 hits, RETR-008 highlight set 2 hits).
2) Root cause traced to the e39a1110 query-refusal/filter path; the fix restores the documented counts WITHOUT changing ticket-ID refusal behavior.
3) Full suite green: `pnpm test:run` (expect 246 files / 2051 tests) and `pnpm tsc --noEmit` clean. (Red baseline CI run 41198684258.)
4) Behavior guard: `node scripts/recall-benchmark/run.mjs --scratch` still exits 0 with 20/20 cases; case 18 (DF-9999-99) must still refuse with zero results. Do NOT regress TESTQ-2026-10-30-1.

CONSTRAINTS:
- Do NOT touch .coding-hermes/, .gitreins/, or any board file — board+code mixing refuses the merge.
- Prefer the minimal fix in product code (likely src/search/query.ts). Change tests ONLY if an assertion is itself wrong versus documented behavior, and justify that loudly in the commit message.
- If your fix changes live test counts (files or tests), run `scripts/sync-agents-md-counts.sh` to sync AGENTS.md (CI asserts those counts).
- Include this fresh row-specific trace line in your commit message body:
  ch:trace row=INT-CI-035 spec=.coding-hermes/board/tasks.jsonl#INT-CI-035 test=src/search/search-retr001.test.ts+src/search/search-retr008.test.ts+scripts/recall-benchmark/run.mjs evidence=commit-body
- Single commit; message must carry the trailer: Co-authored-by: Alexis Okuwa <wojonstech@gmail.com>
- After committing: `git push origin wt/INT-CI-035`.

REPORT (final message): exact commands with outcomes (repro before, repro after, full suite, tsc, recall benchmark), root cause in 2-3 sentences, files changed, commit SHA.