#!/usr/bin/env bash
# s3-alert-gate.sh — consecutive-failure alert gate for S3 backup cron jobs
# (S3-ALERT-001).
#
# Why this exists: the "DuckBrain S3 unified backup (15min)" cron is a
# no_agent silent watchdog. When the S3 pipeline broke on 2026-10-03
# (S3-GIT-007) it stayed broken for 3+ DAYS with no alert, because a cron
# job only reports its own run — nobody counts consecutive failures across
# runs. This gate does exactly that: the cron script calls it once at the
# end of every run with the run's real exit code, and the gate keeps a
# per-job counter of consecutive failures. It speaks only when the streak
# crosses the threshold, so a single blip never pages anyone but a real
# outage cannot go quiet again.
#
# Usage:
#   s3-alert-gate.sh <job-name> <exit-code> [state-dir]
#
#   <job-name>   simple identifier, no '/', not dot-prefixed (one counter
#                per job; e.g. duckbrain-s3-unified)
#   <exit-code>  the job run's real exit status: 0 resets the counter,
#                non-zero increments it
#   [state-dir]  counter/lock directory (default
#                ~/.hermes/backups/s3-alert-state)
#
# Exit codes:
#   0   processed (counter reset / incremented / alert delivered or
#       suppressed) — the gate never masks the caller's own exit code
#   2   a threshold alert FIRED but delivery FAILED: the alert was written
#       to the fallback log instead (see below) so the outage is still
#       recorded on disk
#   64  usage error (bad/missing arguments)
#
# Alert policy (S3-ALERT-001):
#   - counter reaches S3_ALERT_THRESHOLD (default 3) consecutive failures
#       -> fire ONE alert for that threshold crossing;
#   - every S3_REALERT_EVERY (default 8) consecutive failures AFTER the
#       first alert -> fire again (an ongoing outage must not go silent
#       forever: at a 15-min cron cadence that is a re-alert every ~2h);
#   - any successful run resets the counter to 0 and the cycle starts over.
#
# Alert mechanism — what was chosen and why:
#   Primary: `hermes send` (a subcommand of the hermes CLI already on this
#   host). It was built for exactly this shape — "pipe text from any shell
#   script to any messaging platform Hermes is already configured for": no
#   LLM call, no agent loop, and for bot-token platforms (Telegram) it does
#   NOT need a running gateway. Its exit code tells us whether delivery
#   actually succeeded, which is what makes the fallback honest.
#   Fallback: when the notifier command fails (or times out), a clearly
#   formatted ALERT line is appended to
#   ~/.hermes/backups/s3-alerts.log (S3_ALERT_FALLBACK_LOG) and the gate
#   exits 2, so the caller's cron record shows the alert-delivery failure.
#   Every alert (delivered or fallen back) is appended to that same log as
#   an audit trail.
#
# Env:
#   S3_ALERT_THRESHOLD    consecutive failures before the first alert
#                         (default 3; ~45 min at a 15-min cadence)
#   S3_REALERT_EVERY      re-alert every N consecutive failures after the
#                         first (default 8)
#   S3_ALERT_COMMAND      notifier command template. Run via
#                         `bash -c "<template>" s3-alert-gate <job> <count>
#                         <last-error>` — i.e. "$1"=job name, "$2"=failure
#                         count, "$3"=last error line. Override it in tests
#                         to mock the notifier.
#   S3_ALERT_TARGET       delivery target for the default notifier
#                         (default: telegram = the fleet home channel)
#   S3_ALERT_LAST_ERROR   optional: the caller's last error line, included
#                         in the alert message
#   S3_ALERT_FALLBACK_LOG audit/fallback log
#                         (default ~/.hermes/backups/s3-alerts.log)
#   S3_ALERT_TIMEOUT      notifier timeout in seconds (default 30)
#
# Crash safety: concurrent runs serialize on an flock(1) taken on a
# dedicated <job>.lock file; the counter itself is written to a temp file
# and atomically rename(2)d into place, so a crash mid-write can never
# leave a torn count. (The lock must live on a file that is never replaced:
# flock is bound to the inode, so mv-ing the locked file itself would let
# the next waiter lock a different inode than the writer replaced — the
# classic rename-under-flock race.)
set -uo pipefail

die_usage() {
  echo "s3-alert-gate: $*" >&2
  echo "usage: s3-alert-gate.sh <job-name> <exit-code> [state-dir]" >&2
  exit 64
}

GATE_JOB="${1:-}"
GATE_RC="${2:-}"
STATE_DIR="${3-$HOME/.hermes/backups/s3-alert-state}"

case "$GATE_JOB" in ''|*/*|.*) die_usage "job-name must be a simple non-empty name (no '/', not dot-prefixed), got '$GATE_JOB'" ;; esac
case "$GATE_RC" in ''|*[!0-9]*) die_usage "exit-code must be a non-negative integer, got '$GATE_RC'" ;; esac
[ -n "$STATE_DIR" ] || die_usage "state-dir must not be empty"

# int_or <default> <value> — value when it is a clean non-negative int, else default
int_or() {
  case "$2" in ''|*[!0-9]*) printf '%s' "$1" ;; *) printf '%s' "$2" ;; esac
}

THRESHOLD="$(int_or 3 "${S3_ALERT_THRESHOLD:-}")"
REALERT="$(int_or 8 "${S3_REALERT_EVERY:-}")"
[ "$THRESHOLD" -ge 1 ] || THRESHOLD=1
[ "$REALERT" -ge 1 ] || REALERT=1
NOTIFY_TIMEOUT="$(int_or 30 "${S3_ALERT_TIMEOUT:-}")"

LAST_ERROR="${S3_ALERT_LAST_ERROR:-(no error detail)}"
FALLBACK_LOG="${S3_ALERT_FALLBACK_LOG:-$HOME/.hermes/backups/s3-alerts.log}"

# Default notifier: hermes send -> fleet Telegram home channel. "$1".."$3"
# are the positional args bash -c receives below (job, count, last error).
S3_ALERT_COMMAND="${S3_ALERT_COMMAND:-hermes send --quiet --to ${S3_ALERT_TARGET:-telegram} \"\$1: \$2 consecutive S3 backup failures — last error: \$3\"}"

if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
  echo "s3-alert-gate: cannot create state dir $STATE_DIR" >&2
  exit 2
fi

COUNT_FILE="$STATE_DIR/$GATE_JOB.count"
LOCK_FILE="$STATE_DIR/$GATE_JOB.lock"
TMP_FILE="$STATE_DIR/$GATE_JOB.count.tmp.$$"

# --- serialize counter read/decide/write across concurrent runs --------------
if ! exec 9>"$LOCK_FILE"; then
  echo "s3-alert-gate: cannot open lock file $LOCK_FILE" >&2
  exit 2
fi
if ! flock -w 10 9; then
  echo "s3-alert-gate: could not acquire $LOCK_FILE within 10s" >&2
  exit 2
fi

count=0
if [ -f "$COUNT_FILE" ]; then
  count="$(tr -d '[:space:]' < "$COUNT_FILE" 2>/dev/null)"
  case "$count" in ''|*[!0-9]*) count=0 ;; esac
fi

save_count() { # atomic replace under the lock
  if printf '%s\n' "$1" > "$TMP_FILE" 2>/dev/null && mv -f "$TMP_FILE" "$COUNT_FILE" 2>/dev/null; then
    return 0
  fi
  rm -f "$TMP_FILE" 2>/dev/null
  echo "s3-alert-gate: cannot write counter $COUNT_FILE" >&2
  return 1
}

audit_log() { # best-effort audit/fallback line; never fails the gate by itself
  printf '%s s3-alert-gate ALERT job=%s count=%s delivered=%s :: %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$GATE_JOB" "$new" "$1" "$LAST_ERROR" >> "$FALLBACK_LOG" 2>/dev/null
  return 0
}

deliver_alert() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$NOTIFY_TIMEOUT" bash -c "$S3_ALERT_COMMAND" s3-alert-gate "$GATE_JOB" "$new" "$LAST_ERROR"
  else
    bash -c "$S3_ALERT_COMMAND" s3-alert-gate "$GATE_JOB" "$new" "$LAST_ERROR"
  fi
}

# --- success: reset the streak ------------------------------------------------
if [ "$GATE_RC" -eq 0 ]; then
  if save_count 0; then
    echo "s3-alert-gate: job=$GATE_JOB rc=0 -> counter reset (was $count)"
    exit 0
  fi
  exit 2
fi

# --- failure: increment and decide --------------------------------------------
new=$((count + 1))
want_alert=0
if [ "$new" -eq "$THRESHOLD" ]; then
  want_alert=1
elif [ "$new" -gt "$THRESHOLD" ] && [ $(( (new - THRESHOLD) % REALERT )) -eq 0 ]; then
  want_alert=1
fi

if [ "$want_alert" -eq 0 ]; then
  if save_count "$new"; then
    echo "s3-alert-gate: job=$GATE_JOB rc=$GATE_RC -> count=$new (below threshold $THRESHOLD, next re-alert at $((THRESHOLD + REALERT)))"
    exit 0
  fi
  exit 2
fi

# --- threshold crossing / re-alert: fire exactly once per crossing -----------
if deliver_alert; then
  save_count "$new" || exit 2
  audit_log "yes"
  echo "s3-alert-gate: job=$GATE_JOB ALERT delivered (count=$new, threshold=$THRESHOLD, re-alert every $REALERT)"
  exit 0
else
  save_count "$new" || exit 2
  audit_log "no"
  echo "s3-alert-gate: job=$GATE_JOB ALERT DELIVERY FAILED — line appended to $FALLBACK_LOG (count=$new)" >&2
  exit 2
fi
