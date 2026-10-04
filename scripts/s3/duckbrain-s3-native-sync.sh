#!/usr/bin/env bash
# Native S3 delta sync — runs every 15 min (Bane directive 2026-08-24).
# Quiet on success (no_agent cron: empty stdout = silent); loud on failure.
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
export AWS_PROFILE=duckbrain
export AWS_ENDPOINT_URL=https://hel1.your-objectstorage.com
export AWS_DEFAULT_REGION=us-east-1
LOG="$HOME/.hermes/backups/duckbrain-s3-native.log"
mkdir -p "$(dirname "$LOG")"
cd "$HOME/duckbrain" || { echo "duckbrain dir missing"; exit 1; }

# S3-GAP-2026-09-30: a crashed sync leaves namespaces/.s3state/.lock behind and
# every later sync fails forever ("another sync is in progress") — a stale EMPTY
# lock silently killed ALL namespace backups for 2.5 days. Live locks carry
# {"pid":N,"ts":N}; treat a lock as stale when its owner is gone, when it is
# empty/garbled for >5 min, or when its owner is alive but hung for >45 min.
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
    echo "STALE LOCK cleared pid='${LOCK_PID}' age=${LOCK_AGE}s size=$(stat -c %s "$LOCKFILE") $(date -u +%F-%T)" >> "$LOG"
    rm -f "$LOCKFILE"
  fi
fi

# S3-GIT-007: the sync wrapper had no per-run deadline — a hung node call made
# the 15-min cron run ~2h, get SIGTERM'd at 7200s, then the next run cleared
# the stale lock and repeated. Bound the whole call so failure is loud and fast.
SYNC_ALL_DEADLINE_S="${S3_SYNC_ALL_DEADLINE_S:-3600}"
OUT=$(timeout "$SYNC_ALL_DEADLINE_S" node bin/duckbrain.js s3 sync all push 2>&1)
RC=$?
if [ $RC -eq 124 ]; then
  echo "FAIL sync-all-deadline rc=124 $(date -u +%F-%T)" >> "$LOG"
  echo "duckbrain native s3 sync FAILED — sync-all exceeded ${SYNC_ALL_DEADLINE_S}s deadline (rc=124); see $LOG"
  exit 1
fi
if [ $RC -ne 0 ]; then
  echo "FAIL rc=$RC $(date -u +%F-%T)" >> "$LOG"
  echo "$OUT" | tail -6 >> "$LOG"
  echo "duckbrain native s3 sync FAILED rc=$RC — see $LOG"
  exit 1
fi
# S3-GAP-2026-09-30: `s3 sync all push` exits 0 EVEN WHEN EVERY NAMESPACE FAILS
# (proven: 479 "lock held" lines + "push complete: 0 namespaces, 0 files
# transferred" → rc=0). A stale namespaces/.s3state/.lock from a crashed sync
# silently killed all namespace backups for 2.5 days while this cron reported
# "ok". The tool lies about per-namespace failure, so detect it in the output.
if printf '%s\n' "$OUT" | grep -qiE "lock held|failed:|Error:"; then
  echo "FAIL namespace-errors $(date -u +%F-%T)" >> "$LOG"
  printf '%s\n' "$OUT" | grep -iE "lock held|failed:|Error:" | head -8 >> "$LOG"
  printf '%s\n' "$OUT" | tail -3 >> "$LOG"
  echo "duckbrain native s3 sync FAILED — namespaces errored (lock held or sync failed); see $LOG"
  printf '%s\n' "$OUT" | grep -iE "lock held|failed:|Error:" | head -3
  exit 1
fi
if [ -n "$OUT" ]; then
  echo "$(date -u +%F-%T) $OUT" >> "$LOG"
  echo "$OUT" | tail -2
fi
exit 0
