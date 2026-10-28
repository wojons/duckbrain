# DB-GAP-065 — Evidence: `namespaces prune` + registry drift guard

Task: DB-GAP-065 (P1) — namespace registry accumulates dead rows: add
`namespaces prune` and a drift guard so the accumulation can never be silent
again. Worker commit `a203d3ca` (wt/DB-GAP-065), merged to the foreman branch
via `5cc4d3f3`. This artifact records the live evidence for the row's
acceptance criteria (AC-1..AC-6).

## What landed (code surfaces)

| Surface | File | Behavior |
|---|---|---|
| Prune plan/apply | `src/namespaces/prune.ts` | `planNamespacePrune()` (pure read): a row is removed iff its resolved path does not exist; live rows carried byte-identically; dead rows whose path escapes the namespaces root are REFUSED (kept + reported). `applyNamespacePrune()`: no write when the dead set is empty; otherwise one stamped, fsynced config write, then `.s3state/<ns>.json` manifest pruning for removed names only (S3 objects untouched). |
| CLI verb | `src/cli/namespaces-prune.ts`, `src/cli/human.ts` | `duckbrain namespaces prune [--dry-run] [--apply]` — dry-run is the DEFAULT; `--apply` writes; `--dry-run` wins if both passed. Exit 0 = success/clean, 1 = refused rows present, 2 = aborted (config changed mid-flight; nothing written). The dead set is printed in full. |
| Crash-safe config write | `src/config/index.ts` | `updateConfig({expectedStamp, fsync})`: aborts (throws) when the file changed between read and write (concurrent-writer guard); writes via pid-suffixed tmp + fsync(data) + fsync(dir) + rename. Existing callers unchanged. |
| Path-safety reuse | `src/namespaces/delete.ts` | The delete-namespace path-safety rule extracted as exported `checkNamespacePathSafety()` (resolution anchored to the config-file root) and called by BOTH `deleteNamespace()` and prune — one guard, not two copies. |
| Drift guard | `src/http/routes/namespaces.ts`, `src/http/types/api.ts` | `GET /api/namespaces` adds `driftWarning {deadCount, liveCount, hint: "run 'duckbrain namespaces prune --apply'"}` when deadCount >= 25 OR deadCount > 2 x liveCount; the field is omitted entirely below threshold / for a clean registry. |
| Tests | `src/cli/namespaces-prune-dbgap065.test.ts` (360 lines), `src/http/routes/namespaces-drift-warning-dbgap065.test.ts` (186 lines) | Dry-run default incl. real CLI dispatch, exact removal set + byte-identical live rows + manifest scope, idempotent second run, out-of-root refusal, threshold edge cases, field-omission below threshold. |

## Live probes (T3 — invoked and observed, 2026-10-28)

1. **CLI dry-run (default), merged tree:**
   `node bin/duckbrain.js namespaces prune` →
   `Namespace registry: 232 mapping(s), 14352 bytes / live: 232 dead: 0
   refused: 0 / Nothing to prune — every registered mapping has a directory on
   disk.` rc=0. (Today's registry is clean: the 2026-10-27 out-of-band prune
   removed the 15k+ dead rows this tool now guards against — the zero result
   IS the expected live state; the synthetic dead-row cases are covered by the
   13-test battery.)

   First probe attempt against the pre-existing `bin/`+`dist/` answered
   `Unknown namespace subcommand: prune` — a STALE build artifact issue, not a
   code defect: `bin/duckbrain.js` prefers `dist/` and the old dist predated
   the verb. `pnpm build:cli` (tsc -p tsconfig.build.json, rc=0) fixed the
   probe. Any consumer that has not rebuilt sees the same; the repo build step
   (`pnpm build`) covers it.

2. **HTTP drift guard, merged tree:** scratch daemon
   (`node bin/duckbrain.js http --port 3999 --auth=none`) →
   `GET /api/namespaces` = 200, 24,667 bytes, 279 rows (registry ∪ on-disk
   census), `driftWarning` ABSENT (below threshold: dead=0 — correct per the
   omit-when-clean contract) alongside the pre-existing `drift` field.

3. **Fleet service:** `duckbrain-http.service` (systemd --user, runs this
   checkout via `bin/duckbrain.js`) was RESTARTED after `pnpm build:cli` so the
   live fleet-facing server runs the merged tree; `/health` answered
   `{"status":"degraded", ...}` with only the known cold-start embedding-probe
   degradation (provider note: probe deadline, self-recovering), and the
   duckbrain-http-health/recover timers were active throughout.

## Gates (exact commands + results)

| Gate | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` (merged tree) | rc=0, no output |
| Full suite | `npx vitest run` (merged tree) | **Test Files 237 passed (237) / Tests 1973 passed (1973)**, rc=0 |
| Full suite (judge tier1 re-run) | gitreins guard tests leg | 237/1973 rc=0 (independent second run) |
| AGENTS.md count sync | `bash scripts/sync-agents-md-counts.sh /tmp/dbg065-vitest-merged.out` | "already matches live suite (237 suites, 1973 tests) — no change (idempotent)" — the worker's commit already carried the correct counts, so the test-adding commit + count sync share one push (GAP-012 class cannot recur on this push) |
| Merge hygiene | `git diff --name-status origin/main..HEAD \| grep -c '^D'` | 0 file deletions |
| GitReins judge | `gitreins task complete DB-GAP-065` | tier1 tests PASS; tier2 INCOMPLETE solely on the then-missing evidence artifact (this file + docs/CHANGELOG entries close it); verdict `2026-10-28/e9249a74` |

## Tier1 secrets step — disposition

gitleaks: clean ("no leaks found"). The builtin cross-check reported 6
SENSITIVE PATH findings, all under `.stryker-tmp/sandbox-*/` — leftover
mutation-test sandboxes (84 MB) in the repo root, path-ignored by
`.gitignore:74` but not scanner-excluded. They are scratch residue from a
prior `test:mutation` run, not repository content; removed in this tick's
closeout (`.stryker-tmp/` regenerated on demand by stryker).

## Registry baseline (the row's evidence numbers)

| When | Registry rows | Bytes | directoryMissing |
|---|---|---|---|
| 2026-10-27 baseline (row text) | 16,251 | 2,075,057 | 15,299 |
| 2026-10-27 after out-of-band owner prune | 276 | 24,343 | 0 |
| 2026-10-28 live (this tree, CLI) | 232 mappings | 14,352 | 0 (dead: 0, refused: 0) |
| 2026-10-28 live (`GET /api/namespaces`, scratch daemon) | 279 rows (union w/ census) | 24,667 | driftWarning absent (below threshold) |

The regression closure: before this row, nothing could remove dead rows or
warn about them — the listing could only grow. After this row,
`duckbrain namespaces prune` removes exactly the dead set (dry-run default),
and any future accumulation >= 25 dead rows (or dead > 2x live) turns
`GET /api/namespaces` loud via `driftWarning`.

## Traceability

ch:trace row=DB-GAP-065 spec=.coding-hermes/board/tasks.jsonl#DB-GAP-065 test=src/cli/namespaces-prune-dbgap065.test.ts+src/http/routes/namespaces-drift-warning-dbgap065.test.ts evidence=docs/evidence/DB-GAP-065-evidence.md witness=none:unattended-foreman-recovery-tick

STATUS: complete
TIER: T3 (live CLI + live HTTP probe on the merged tree; transcripts above)
EVIDENCE: docs/evidence/DB-GAP-065-evidence.md; commit a203d3ca (worker) merged via 5cc4d3f3
