#!/usr/bin/env bash
# duckbrain-s3-alert.sh — S3-ALERT-001 backup alert net (no_agent watchdog).
#
# The 15-min unified S3 backup (cron 1229f45f3ea4 -> duckbrain-s3-unified.sh)
# can fail for DAYS with no alert: nothing watches for consecutive failures.
# Proven live: 36+ FAIL lines in ~/.hermes/backups/duckbrain-s3-native.log
# (rc=1 UnknownError legs, namespace-errors legs) and sync-all deadline
# kills, all silent. This net reads the SAME log the runner writes, counts
# consecutive failures at the log tail, and speaks only when the streak
# crosses S3_ALERT_THRESHOLD consecutive failures.
#
# Silence = nothing to report (streak below threshold). When it speaks it
# prints: streak length, time of first and last failure, and the last 3
# failure lines, then exits non-zero (records the incident in cron state;
# the stdout delivery IS the alert — no double posting).
#
# Implementation note: the tail streak is computed in ONE awk pass (a
# per-line `grep -q` subprocess loop took >60s on the 95k-line production
# log; awk does the same in <1s). A non-FAIL line resets the streak (any
# success clears it — silence means "backed up recently"). first/last are
# tab-separated in the awk output so lines with spaces survive the shell
# read round-trip.
#
# Env:
#   S3_ALERT_THRESHOLD  consecutive FAIL lines before alerting (default 4;
#                       at a 15-min cadence = ~1h of continuous failure)
#   S3_ALERT_LOG        log file to tail (default ~/.hermes/backups/duckbrain-s3-native.log)
set -uo pipefail

LOG="${S3_ALERT_LOG:-$HOME/.hermes/backups/duckbrain-s3-native.log}"
THRESHOLD="${S3_ALERT_THRESHOLD:-4}"

if [ ! -f "$LOG" ]; then
  # The runner has never logged anything. Absence of the log = nothing to
  # report, not an error.
  exit 0
fi

# One awk pass over the whole log: track the streak of consecutive
# FAIL-prefixed lines ending at EOF. Prints "<streak>\t<first>\t<last>".
IFS=$'\t' read -r STREAK FIRST LAST < <(awk '
  /^FAIL/ {
    if (streak == 0) first = $0
    streak++
    last = $0
    next
  }
  { streak = 0 }
  END { printf "%d\t%s\t%s\n", streak+0, first, last }
' "$LOG")

if [ "${STREAK:-0}" -lt "$THRESHOLD" ]; then
  exit 0
fi

ts=$(date -u +%F-%T)
printf 'duckbrain S3 BACKUP FAILING: %s consecutive failures (threshold %s) as of %s UTC\n' \
  "$STREAK" "$THRESHOLD" "$ts"
printf 'first: %s\nlast:  %s\n' "$FIRST" "$LAST"
printf 'last failures:\n'
grep '^FAIL' "$LOG" | tail -3
printf 'log: %s\nfix hint: check lock/state, endpoint reachability, and recent FAIL context in the log\n' "$LOG"
exit 1
