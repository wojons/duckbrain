# scripts/maintenance — DuckBrain namespace repack sweep

## What this is

`duckbrain-ns-repack.sh` is the drift-repair sweep for DuckBrain namespace repos
that have an S3 remote (git-remote-s3 auto-push). This in-repo copy is
**canonical**; the deployed copy at `~/.hermes/scripts/duckbrain-ns-repack.sh`
must stay byte-identical (verify with `cmp`).

## Why it exists

git-remote-s3 has **no negotiation and no delta**: every push re-bundles over
ALL reachable objects on a single CPU. The storage layer is append-only JSONL,
and git stores a NEW FULL BLOB per append — `remember` keys, sync keys, and
foreman ticks each add whole-file blobs. Loose objects are delta-less and
individually compressed, so loose-object count is the direct multiplier on
per-push CPU and push latency.

Critically, git's own auto-gc (`gc.auto` = 6700 loose objects) never trips on
namespace repos: they orbit around 3k loose objects at steady state, so the
bloat accumulates silently — the sweep is the only repair. Without it a
push has to compress thousands of unpacked blobs every time.

## What the sweep does

1. Scans each namespace repo under `~/duckbrain/namespaces/` (overridable via
   `DUCKBRAIN_NAMESPACES_DIR`).
2. Only touches repos with an `s3://` remote (the ones whose pushes pay the
   bundling cost).
3. Measures loose-object count, loose-object size, pack-file count, and the
   largest loose object.
4. If any threshold is exceeded and NO git process is mid-flight on that
   namespace (see `pgrep -f "namespaces/$ns"`), runs
   `nice -10 timeout 1800s git repack -adf` followed by `git prune-packed`,
   with a 30-minute per-repo wall clock guard and a HEAD readability check
   after the repack.
5. Writes per-run state: `~/.hermes/state/duckbrain-ns-repack.log` and
   `~/.hermes/state/duckbrain-ns-repack-last.json` (one JSON row per repo
   with before/after metrics: git_mb, loose count, pack count).
6. `DRY_RUN=1` reports what WOULD be repacked without touching anything.

## Thresholds (env-overridable)

| env var | default | fires when |
|---|---|---|
| `REPACK_LOOSE_COUNT` | `500` | loose object count exceeds this |
| `REPACK_LOOSE_MB` | `50` | loose-object total bytes exceeds this |
| `REPACK_PACKS` | `3` | pack-file count exceeds this |
| `REPACK_MAX_OBJECT_MB` | `20` | largest single loose object exceeds this |
| `REPACK_TIMEOUT` | `1800` | per-repo wall-clock guard (seconds) |
| `REPACK_LOG` | `~/.hermes/state/duckbrain-ns-repack.log` | where the log goes |
| `REPACK_LAST_JSON` | `~/.hermes/state/duckbrain-ns-repack-last.json` | last-run JSON |
| `REPACK_LOCK` | `~/.hermes/state/duckbrain-ns-repack.lock` | single-flight lock |

## Live-daemon interaction

- **Single-flight:** the sweep holds an exclusive `flock` on
  `~/.hermes/state/duckbrain-ns-repack.lock` for its whole run — two concurrent
  sweeps cannot fight over repo locks; a second invocation exits 0 with a SKIP
  line. Note this lock protects two sweeps from each other — it does NOT block
  the duckbrain daemon, which is handled by the busy-check below.
- **Busy-check (pause-equivalent window):** there is no stop-the-writer pause.
  Instead each repo is checked for git work in flight (`pgrep -f
  "namespaces/$ns"`) before touching it; a namespace with a push/commit/gc
  mid-repack is skipped entirely for that sweep ("BUSY" log line, re-tried next
  weekly tick). `git repack -adf` fails cleanly (non-zero rc → "left as-is for
  next sweep") if it races a writer; no corruption path, only a skipped repo.
- **Scheduling:** deployed copy is run by the systemd user unit
  `duckbrain-ns-repack.service`, triggered weekly by
  `duckbrain-ns-repack.timer` (Sun 04:20, `Persistent=true`,
  `RandomizedDelaySec=15m`). The service runs at `Nice=10`, `CPUWeight=20`,
  `IOSchedulingClass=idle`, `TimeoutStartSec=3600` to stay out of the way of
  real work.
- **Per-repo timeout:** each repack is individually bounded by
  `REPACK_TIMEOUT` (default 30 min) via `timeout`, so one giant namespace
  cannot stall the whole sweep (service-level 3600s is the outer bound).

## Deploy path (canonical → deployed)

1. This repo's copy is the source of truth. Edits land here first.
2. The deployed copy at `~/.hermes/scripts/duckbrain-ns-repack.sh` is updated
   by **atomic `mv`** (write to a temp file in the same directory, then `mv`
   over the deployed path, so the systemd unit never half-reads a script).
3. Keep them byte-identical; a freshness drift check is simply:
   `cmp scripts/maintenance/duckbrain-ns-repack.sh ~/.hermes/scripts/duckbrain-ns-repack.sh`
4. No service restart is needed after a script update — the unit invokes the
   file fresh per run.

## Recent observed state (2026-09-19 dry run, 141 scanned / 56 would-repack)

Typical drift: steady-state namespaces sit around 500-3000 loose objects
(scheduler 1214, crier 2450, hermes-canopy 2066); the largest offenders carry
hundreds of MB of loose bytes on top of the count (fleet-quality 262MB,
coding-hermes 123MB). This is exactly the profile that never trips auto-gc and
that the weekly sweep is for. Run `DRY_RUN=1` first whenever touching the
thresholds, and read the `-last.json` for before/after deltas.
