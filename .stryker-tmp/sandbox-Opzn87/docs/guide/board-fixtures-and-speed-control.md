# Board Schema: Perpetual Fixtures & Adaptive Speed Control (SCHED-GAP-104/105/106)

> **Scope note:** the `.coding-hermes/board/` row schema documented here is a
> DuckBrain product convention (this repo ships the board). The *scheduler*
> that consumes it for speed control lives in the authors' private fleet
> infrastructure and is not required to use boards — outside installers get
> the board, fixtures, and never-done conventions out of the box.

> Audience: fleet operators + foreman implementers. This is the DuckBrain-side
> spec of the board-row convention that drives scheduler speed control.
> Scheduler-side implementation: `coding-hermes/scheduler` `internal/scheduler/adaptive_cooldown.go`
> (GAP-104/105/106), boardctl seed: `internal/board/init.go` (defaultFixtureLine).

## The problem this solves

Scheduler adaptive cooldown needs an honest answer to "did this project do
work?" — but the two cheapest signals both lie:

- **Commits lie** when the foreman self-commits board bookkeeping every tick
  (a finished project "proves progress" forever). → Fixed by GAP-104
  (commit-anatomy: only commits touching files outside `.coding-hermes/`
  count as code work).
- **Board rows lie** when a PERMANENT fixture row sits open forever. The
  NEVER-DONE audit fixture exists on 32+ boards by design — it is not work,
  and its per-tick refreshes must never fake new work or keep a project hot.
  → Fixed by GAP-106.

## The convention (board rows)

### Perpetual fixture rows

A row is a PERPETUAL FIXTURE when either:

1. `id` starts with `NEVER-DONE` (case-insensitive, suffixes allowed:
   `NEVER-DONE-2`, `NEVERDONE`, …), OR
2. it carries `"perpetual": true`.

Fixture semantics:

- **Always on the board, never completed.** It marks standing work (the
  periodic audit), not a task.
- **Invisible to speed control in BOTH directions:** excluded from the
  scheduler's open-row count (GAP-105 direction signal) and from the
  pending-work urgency boost. A finished project whose only open row is the
  fixture is treated as idle and decays to its cooldown ceiling; the
  fixture's refreshes can never wake it.
- **Refresh, don't mutate:** update `worker_summary` / `foreman_note` only.
- **Built in unless disabled:** `boardctl init` ships the fixture (row 0 of
  `tasks.jsonl`, registered in `fixtures.jsonl`, full default schema so new
  rows stay schema-self-similar). Operators disable it by deleting BOTH the
  tasks.jsonl row and the fixtures.jsonl registry entry.

### New-work wake rule (companion, scheduler-side)

A genuinely NEW non-fixture open row resets the project to floor speed —
rate-limited to one wake per 6h per project so injection streams (QA
findings, error-scanner rows, PM digests) cannot pin everything hot.

## The scheduler speed-control loop (as of 09-10)

```
tick completes
  ├─ code commits? (paths outside .coding-hermes/)  → PROGRESS  ┐
  ├─ open rows NET DECREASED (closed real work)     → PROGRESS  ┘→ streak 0,
  │    (fixture rows NOT counted as open)                        cooldown → floor
  └─ neither → no-progress tick
       streak ≥ threshold(10) → cooldown ×2 per further no-progress
       tick, capped at cooldown_ceiling_s (default 7d). Restart re-pins
       from fleet.toml; arming = fleet-cooldown-policy.py only.
```

## DuckBrain-side obligations

- Fleet sync (duckbrain-sync role) writes project state per namespace —
  fixture exclusion does NOT change the sync schema; boards keep syncing
  as-is. The convention lives in the board file, and this doc.
- Decision records about model/cadence choices follow the
  `coding-hermes-skill-authoring` Portability Law: record the DECISION +
  `revisit_when` under `/decisions/…`, never hardcode the current answer
  into specs.
- When the fleet gains a NEW permanent fixture type (beyond NEVER-DONE),
  update this doc + `isFixtureRow()` in the scheduler in the same change —
  the detector and the spec must move together.

## Verification receipts (2026-09-10)

- Scheduler: `TestBoardOpenRowsExcludesPerpetualFixtures_GAP106`,
  `TestCountPendingBoardExcludesPerpetualFixtures_GAP106` PASS; full
  `-short` suite green at `e861ec3` (main).
- boardctl: full suite green at `372246c` (init seeds fixture, create
  self-similarity asserted).
- Backfill: 32 enabled-project boards stamped `perpetual:true` on their
  NEVER-DONE rows (one-shot script; idempotent).
