#!/usr/bin/env bash
# S3-SYNC-STOPPED-001 — the SCHEDULED `sync all push`.
#
# The mirror went eight days stale because nothing ran this: the only schedule
# was a paused Hermes cron job, and no surface could tell a stale mirror from a
# current one. This is the entry point the systemd timer
# (ops/systemd/duckbrain-s3-sync.{service,timer}) executes.
#
# Deliberately thin: the engine writes the run record (`.s3state/
# last-push-run.json`) and the per-namespace push record (`.s3state/<ns>.push.json`),
# so `s3 status` reports last-run/last-result and the Prometheus gauges
# (duckbrain_s3_last_push_age_seconds, duckbrain_s3_unpushed_files) are fed from
# the same facts. Nothing here reformats or suppresses the engine's output.
#
# Runs the SOURCE CLI on purpose: dist/ lags a landed fix until someone rebuilds,
# and a scheduled backup that silently runs month-old code is the defect this
# row is about.
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
export AWS_PROFILE="${AWS_PROFILE:-duckbrain}"

REPO="${DUCKBRAIN_REPO:-$HOME/duckbrain}"
cd "$REPO" || { echo "SCHEDULED S3 PUSH FAILED — duckbrain repo missing: $REPO"; exit 1; }

# A crashed pass leaves namespaces/.s3state/.lock behind and every later sync
# then fails with "another sync is in progress" — a stale lock silently killed
# all namespace backups for 2.5 days once (S3-GAP-2026-09-30). Clear it only
# when its owner is gone, or when it is empty/garbled for >5 min, or when the
# owner is alive but has held it for >45 min.
LOCKFILE="namespaces/.s3state/.lock"
if [ -f "$LOCKFILE" ]; then
  LOCK_PID=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$LOCKFILE" 2>/dev/null | head -1)
  LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$LOCKFILE") ))
  STALE=0
  if [ -z "$LOCK_PID" ]; then
    [ "$LOCK_AGE" -gt 300 ] && STALE=1
  elif ! kill -0 "$LOCK_PID" 2>/dev/null; then
    STALE=1
  elif [ "$LOCK_AGE" -gt 2700 ]; then
    STALE=1
  fi
  if [ "$STALE" -eq 1 ]; then
    echo "STALE LOCK cleared pid='${LOCK_PID}' age=${LOCK_AGE}s $(date -u +%F-%T)"
    rm -f "$LOCKFILE"
  fi
fi

exec node --import tsx bin/duckbrain.ts s3 sync all push
