# Scheduled Ops Scripts — Host Inventory (OPS-SCHED-UNTRACKED-001)

Status: live-verified 2026-10-07 on the production ops host.
Scope: every scheduled or recurring DuckBrain ops script that lives OUTSIDE this
repo (hermes cron, system crontab, systemd --user timers), plus the known
untracked/unscheduled helpers — so an operator can discover and review them
from the repo without copying credential-bearing content into it.

No script CONTENT is reproduced here. Tracked twins already exist in this repo
for 9 of the 24 entries (the `Tracked?` column is the count of record — one row
is a retired deployment-only helper, see "S3 alert path"); the rest are
referenced by path and purpose only.

## Scheduled + recurring scripts

| Script | Host path | Schedule surface | Schedule | Purpose | Tracked? | Secrets? |
|---|---|---|---|---|---|---|
| duckbrain-leg-watchdog.sh | ~/.hermes/scripts/duckbrain-leg-watchdog.sh | hermes-cron 3541777ce883 | daily 08:00 | MCP-leg liveness watchdog entrypoint (execs the probe; stdout IS the alert) | no | no |
| duckbrain-leg-probe.py | ~/.hermes/scripts/duckbrain-leg-probe.py | helper — runs inside duckbrain-leg-watchdog.sh | — | MCP-leg liveness probe (HTTP + memory round-trip; catches agent-leg-only outages) | no | no |
| reports-s3-push.sh | ~/.hermes/scripts/reports-s3-push.sh | hermes-cron 2ee8eaa9612c | 50 3 * * * | git-backed S3 push of the reports repo (unchanged refs are no-ops) | no | no |
| duckbrain-ns-gc.sh | ~/.hermes/scripts/duckbrain-ns-gc.sh | system crontab | 10 4 * * * | daily git gc of the namespace repos (auto-gc is disabled repo-side) | no | no |
| duckbrain-ns-repack.sh | ~/.hermes/scripts/duckbrain-ns-repack.sh | systemd --user duckbrain-ns-repack.timer | Sun 04:20 | weekly repack sweep of namespace repos with an S3 remote | yes → scripts/maintenance/duckbrain-ns-repack.sh | no |
| duckbrain-s3-unified.sh | ~/.hermes/scripts/duckbrain-s3-unified.sh | hermes-cron 1229f45f3ea4 | */15 * * * * | ONE cron for all S3 backup layers (native delta + daily git push + weekly archive, internal cadence) | yes → scripts/s3/duckbrain-s3-unified.sh | no |
| duckbrain-s3-alert.sh | ~/.hermes/scripts/duckbrain-s3-alert.sh | hermes-cron 0633c41279d6 | */15 * * * * | legacy log-tail alert net over the S3 backup log — RETIRED, superseded by the gate (see "S3 alert path") | no — retired (no `main` twin; decommission pending) | no |
| duckbrain-test-quality-audit.py | ~/.hermes/scripts/duckbrain-test-quality-audit.py | hermes-cron 510718dbb0ab | daily 09:00 | CI + test-quality auditor over this repo (workdir: repo root) | no | no |
| stray-duckbrain-reaper.py | ~/.hermes/scripts/stray-duckbrain-reaper.py | systemd --user stray-duckbrain-reaper.timer | OnUnitActiveSec=60 | reaps orphaned DuckBrain HTTP daemons (test-suite strays) | no | no |
| health-check.js | ~/duckbrain/scripts/health-check.js | systemd --user duckbrain-http-health.timer | *-*-* *:*:00 (every minute) | dark-port /health probe (OPS-001) | yes → scripts/health-check.js | no |
| watchdog-recover.js | ~/duckbrain/scripts/watchdog-recover.js | systemd --user duckbrain-http-recover.timer | *-*-* *:*:30 (every minute) | recovers duckbrain-http after N consecutive DARK probes (GAP-059) | yes → scripts/watchdog-recover.js | no |
| cron-output-archive.py | ~/.hermes/scripts/cron-output-archive.py | hermes-cron 0d0d49d5d657 | every 120m | incremental archive of cron output files into the hermes-telemetry namespace, then S3 push | no | no |

## Untracked / unscheduled scripts (on-demand, helper, or one-shot)

| Script | Host path | Schedule surface | Schedule | Purpose | Tracked? | Secrets? |
|---|---|---|---|---|---|---|
| dagger-duckbrain-sync-loop.sh | ~/.hermes/scripts/dagger-duckbrain-sync-loop.sh | — (invoked by worktree sync workflows) | — | runs the per-project namespace-sync pipeline (deterministic, zero LLM calls) | no | no |
| duckbrain-mirror-sync.sh | ~/.hermes/scripts/duckbrain-mirror-sync.sh | — (manual / on demand) | — | pushes the GitHub canon repo to the GitLab mirror; silent on success | no | no |
| duckbrain-session-summary.sh | ~/.hermes/scripts/duckbrain-session-summary.sh | — (end-of-tick hook, invoked by lanes) | — | asks the model to summarise a session into a fixed schema and writes it to DuckBrain | no | no |
| pm-duckbrain-log-20260827.sh | ~/.hermes/scripts/pm-duckbrain-log-20260827.sh | — (one-shot, retained for record) | — | 2026-08-27 PM-lane log ingest into DuckBrain | no | no |
| duckbrain-s3-daily.sh | ~/.hermes/scripts/duckbrain-s3-daily.sh | helper — called every run by duckbrain-s3-unified.sh | — | cadence wrapper: exec of the core pusher for the daily git layer | yes → scripts/s3/duckbrain-s3-daily.sh (HOST COPY STALE — see drift log) | no |
| duckbrain-s3-native-sync.sh | ~/.hermes/scripts/duckbrain-s3-native-sync.sh | helper — called every run by duckbrain-s3-unified.sh | — | native delta sync of namespace data to object storage | yes → scripts/s3/duckbrain-s3-native-sync.sh | no |
| duckbrain-s3-push.sh | ~/.hermes/scripts/duckbrain-s3-push.sh | helper — called by daily/weekly/unified | — | core git-remote-s3 pusher (bundles per ref; unchanged = no-op) | yes → scripts/s3/duckbrain-s3-push.sh | no |
| duckbrain-s3-weekly.sh | ~/.hermes/scripts/duckbrain-s3-weekly.sh | helper — weekly cadence inside duckbrain-s3-unified.sh | — | weekly tar.xz archive of all namespace repos + rotation (keeps 12) | yes → scripts/s3/duckbrain-s3-weekly.sh | no |
| s3-alert-gate.sh | ~/.hermes/scripts/s3-alert-gate.sh | helper — called by duckbrain-s3-unified.sh on every run (EXIT trap) | — | **the** S3 alert implementation: counts consecutive failed runs, re-alert cadence, `hermes send` delivery + fallback log | yes → scripts/s3/s3-alert-gate.sh | no |
| make_reports_index.sh | ~/.hermes/scripts/make_reports_index.sh | — (run by report-publish flows) | — | regenerates the static index page with presigned links after report publishes | no | no |
| sync_task_router_duckbrain.py | ~/.hermes/scripts/sync_task_router_duckbrain.py | — (task-router flows; not on any schedule surface) | — | task-router table sync into DuckBrain under the HTTP body cap | no | no |
| tg_backfill_duckbrain.py | ~/.hermes/scripts/tg_backfill_duckbrain.py | — (manual one-shot) | — | backfills a chat export into the chat-archive tables (new days only) | no | no |

## S3 alert path (S3-ALERT-002)

ONE alert implementation: `scripts/s3/s3-alert-gate.sh`. It is called by
`duckbrain-s3-unified.sh` from its `EXIT` trap on **every** run, so the alert
decision shares a signal source with the backup run itself (the wrapper exit
status folds in every failing layer) and has one delivery path (`hermes send`,
plus the fallback/audit log). Cron-to-script mapping:

| Schedule surface | Script | Role |
|---|---|---|
| hermes-cron 1229f45f3ea4 (*/15) | `duckbrain-s3-unified.sh` → `s3-alert-gate.sh` | **the** S3 alert: counts consecutive failed runs for job `duckbrain-s3-unified` (state under `s3-alert-state/`), resets on any clean run, alerts at `S3_ALERT_THRESHOLD` and re-alerts every `S3_REALERT_EVERY`; delivery failure falls back to `~/.hermes/backups/s3-alerts.log` and exits 2 |
| hermes-cron 0633c41279d6 (*/15) | `duckbrain-s3-alert.sh` | **RETIRED** legacy net: log-tail streak over `duckbrain-s3-native.log`, threshold 4. It never landed on `main` — only on the unmerged `feat/native-s3` branch (commit 68d09d6e) — and it duplicates the gate's signal: every `FAIL` line it counted is written by a non-zero `native-sync` exit, which the wrapper already reports to the gate. Two nets also mean two deliveries for one outage |

Origin of the drift: the net was built first (log-tail, no repo twin on `main`),
then S3-ALERT-001 landed the gate *inside* the tracked wrapper. The deployment
kept running both, and the inventory row above claimed a `scripts/s3/` twin that
never existed on `main`.

Decommission (one ops touch; deliberately **not** automated from the repo, so a
repo change can never silently disarm a live alert):

```bash
hermes cron pause 0633c41279d6                              # stop the legacy net
rm ~/.hermes/scripts/duckbrain-s3-alert.sh                  # remove the deployed copy
# rollback, if the net is ever needed again:
#   git show 68d09d6e:ops/duckbrain-s3-alert.sh > ~/.hermes/scripts/duckbrain-s3-alert.sh
#   hermes cron resume 0633c41279d6
```

Until that runs, `scripts/s3/test-component-completeness.sh` reports the deployed
copy as a known retired artifact (fingerprint `c22d93c4ff99044b…`) and fails if it
is ever *edited in place* — alert behaviour changes belong in the gate.

Two things to know before decommissioning:

* **Delivery target.** The gate posts to `S3_ALERT_TARGET` (default `telegram`,
  the fleet home channel); the legacy net posted to its own cron delivery thread.
  If that thread must keep receiving S3 alerts, set `S3_ALERT_TARGET` for the
  unified cron *before* removing the net.
* **Honest gap.** The gate counts non-zero exits, including its `TERM`/`INT`
  traps; a `SIGKILL`ed wrapper runs no trap and is therefore not counted. The
  log-tail net covered that case indirectly. If that margin matters, add a
  marker-age dead-man check to the gate — not a second script.

## Secrets posture

Scanned 2026-10-07 (credential-pattern grep over all 24 entries: key/token
literals, private key blocks, AKIA ids, password/key assignments): no inline
credentials found. The S3 scripts authenticate via an AWS profile; DuckBrain
token reads reference token FILES by path. Per policy, no script content is
copied into this repo — only tracked twins that were already sanitized.

## Live verification evidence (2026-10-07, redacted)

System crontab (user-level, `crontab -l`):

    10 4 * * * ~/.hermes/scripts/duckbrain-ns-gc.sh 2>&1 | logger -t duckbrain-ns-gc

systemd --user timers (`systemctl --user list-timers --all`):

    stray-duckbrain-reaper.timer     next in ~60s   (last: 52s ago)
    duckbrain-ns-repack.timer        next Sun 04:22 (last: 3 days ago)
    duckbrain-http-health.timer      last 1 day ago (OnCalendar every minute)
    duckbrain-http-recover.timer     last 1 day ago (OnCalendar every minute)

hermes cron (relevant active entries; `hermes cron list`):

    1229f45f3ea4 [active] DuckBrain S3 unified backup (15min)   Schedule: */15 * * * *   Script: duckbrain-s3-unified.sh
    2ee8eaa9612c [active] reports-s3-git-push                   Schedule: 50 3 * * *     Script: reports-s3-push.sh
    3541777ce883 [active] DuckBrain agent-leg watchdog          Schedule: every day at 8am  Script: duckbrain-leg-watchdog.sh
    0633c41279d6 [active] DuckBrain S3 backup alert             Schedule: */15 * * * *   Script: duckbrain-s3-alert.sh
    510718dbb0ab [active] duckbrain-ci-test-quality-audit       Schedule: every day at 9am  Script: duckbrain-test-quality-audit.py
    0d0d49d5d657 [active] Cron Output Archive                   Schedule: every 120m     Script: cron-output-archive.py

Unit ExecStart targets confirm the two repo-tracked JS probes:

    duckbrain-http-health.service  → node ~/duckbrain/scripts/health-check.js --url=http://127.0.0.1:3000/health ...
    duckbrain-http-recover.service → node ~/duckbrain/scripts/watchdog-recover.js --confirm-probes=1 ...

Live note: at inventory time the unified S3 cron was mid-incident (native-sync
leg failing on a held lock; the alert net was armed and counting — that is the
system working as designed, not an inventory discrepancy).

## Drift log

| Script | Drift found 2026-10-07 | Disposition |
|---|---|---|
| duckbrain-s3-daily.sh | host copy (2026-08-07) differs from repo twin scripts/s3/duckbrain-s3-daily.sh (2026-10-04): the repo copy sanitizes the bucket name to s3://REDACTED-bucket/, the host copy still names the real bucket; otherwise byte-equal | repo copy is canonical for tracked scripts; refresh the host copy at the next ops touch (deliberate, not urgent) |
| all other tracked twins (6) | sha256-identical to host copies | clean |
| duckbrain-s3-alert.sh (2026-10-20, S3-ALERT-002) | deployed and cron-driven every 15 min, but **not on `main`**: the only commit that ever contained it is 68d09d6e on the unmerged `feat/native-s3` branch, so the inventory row's claimed twin `scripts/s3/duckbrain-s3-alert.sh` never existed. It is a second alert implementation over the same pipeline the tracked gate already counts | retired; alert path consolidated on `scripts/s3/s3-alert-gate.sh` (called by the tracked wrapper). Decommission (pause cron 0633c41279d6 + remove the deployed copy) is an ops action — see §"S3 alert path". `test-component-completeness.sh` now fails if the retired copy is edited in place or if a second alert implementation appears |
| s3-alert-gate.sh (2026-10-20, S3-ALERT-002) | the row described it as "called by unified + alert scripts"; nothing but the unified wrapper ever called it | corrected to its actual surface (wrapper `EXIT` trap, every run) |

## Drift policy

Canonical copies for tracked scripts live in this repo (scripts/s3/,
scripts/maintenance/, scripts/health-check.js, scripts/watchdog-recover.js);
host copies under ~/.hermes/scripts/ and ~/duckbrain/scripts/ are DEPLOYMENTS.
A reviewer checks a host copy against its twin with:

    sha256sum scripts/s3/duckbrain-s3-unified.sh ~/.hermes/scripts/duckbrain-s3-unified.sh

Matching hashes = in sync. A mismatch means either host drift (host edited
without a PR) or an undeployed repo change — reconcile before the next
scheduled run matters.

Automated surface check — run from the repo root:

    bash scripts/ops/check-ops-inventory.sh

Exit codes: 0 = inventory intact (missing host paths and unreadable surfaces
are WARN only — the doc may describe a foreign host); 1 = a SCHEDULED entry's
surface no longer mentions its script (real drift, page an operator); 2 = the
inventory doc itself is missing. Offline, idempotent, no network calls.

Self-test (also proves the guard can fail, in fixture space, without touching
live schedules):

    npx vitest run --config vitest.integration.config.ts tests/ops-inventory.int.test.ts

Inventory change rule: any PR that schedules a new DuckBrain ops script
(hermes cron, crontab entry, or systemd --user timer) MUST add an inventory
row to this doc in the same PR. The guard's test pins the minimum row count,
so silent row removal shows up as a review-visible doc diff, and the guard
fails CI-style when a scheduled surface loses its entry.
