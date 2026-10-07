#!/usr/bin/env bash
# duckbrain-s3-unified.sh — ONE cron for ALL DuckBrain → S3 backup layers.
# Bane 2026-08-27: merged 4 S3 crons (native 15min, daily raw sync, weekly git
# archive, duckbrain-s3-backup) into a single cron running every 15 min with
# internal cadence:
#   1. native delta sync   — EVERY run   (duckbrain.js s3 sync all push)
#   2. git-history push    — ≤ once/24h  (git-remote-s3 → s3://duckbrain/current/git/<ns>)
#   3. weekly tar.xz       — ≤ once/7d   (s3://duckbrain/archives/weekly/, keep 12)
# Marker files gate cadence. Silent when healthy (no_agent watchdog); loud on
# any failure.
#
# S3-GIT-002 (2026-09-15): the git layer advances its marker when the layer
# COMPLETED, not only when it exited 0. duckbrain-s3-push.sh stamps
# $STATE_DIR/s3-git-pass.last at the end of a completed pass and defers
# namespaces that are in push-failure backoff, so a single rejecting namespace
# (e.g. hermes-canopy, "multiple bundles exists on server") no longer re-runs
# the whole ~140-repo pass every 15 minutes. Failures are still loud: the
# component is appended to `failures` and the failing namespace names are
# printed in the summary line.
#
# Env overrides (each defaults to the production value):
#   DUCKBRAIN_S3_STATE_DIR          (default $HOME/.hermes/state) — markers + lock + ns state
#   DUCKBRAIN_S3_SCRIPTS_DIR        (default $HOME/.hermes/scripts) — layer scripts
#   DUCKBRAIN_S3_SKIP_COMPONENTS    (default empty = all run) — comma subset of native,git,weekly
#
# S3-GIT-003 forced full pass: the git layer decides per namespace whether an
# unchanged namespace still needs a re-push (a remote-side wipe is otherwise
# never repaired). This wrapper adds NO cadence of its own — it runs the layer at
# most once per 24h and the layer's age rule spreads a full pass over ~a week.
# The two knobs are plain environment variables and are inherited unchanged by
# the layer, so an explicit on-demand pass is:
#   DUCKBRAIN_S3_FORCE_FULL=1 duckbrain-s3-unified.sh
# (the WEEKLY component below is the tar.xz snapshot upload — not a git push —
# so it is deliberately not the thing that forces a git re-push)
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"

STATE_DIR="${DUCKBRAIN_S3_STATE_DIR:-$HOME/.hermes/state}"
SCRIPTS_DIR="${DUCKBRAIN_S3_SCRIPTS_DIR:-$HOME/.hermes/scripts}"
SKIP_COMPONENTS="${DUCKBRAIN_S3_SKIP_COMPONENTS:-}"
GIT_MARKER="$STATE_DIR/s3-git-push.last"
ARCH_MARKER="$STATE_DIR/s3-weekly-archive.last"
GIT_PASS_STAMP="$STATE_DIR/s3-git-pass.last"
GATE_STATE="$STATE_DIR/s3-alert-state"

# Single-instance lock: the cron fires every 15 min but a full git-history
# push + weekly tar can outlive the tick window; without flock two concurrent
# runs clobber the same /tmp tarball (observed 2026-08-27 — manual run
# collided with the first cron tick; S3 data survived, upload raced).
#
# S3-GIT-006: the layer scripts + node below are spawned WITHOUT the lock fd.
# The shell takes the lock on fd 9 and every layer invocation closes fd 9
# for that invocation only (`9>&-`): the shell's own fd still holds the
# flock, while children no longer inherit it — so a timeout-killed cron can
# never leave the lock reachable from orphaned node processes. (Closing the
# shell's fd itself would RELEASE the flock — the lock lives on the open
# file description, which dies with its last fd — so the close must be
# per-invocation, never `exec 9>&-` at top level.)
mkdir -p "$STATE_DIR"
LOCK="$STATE_DIR/duckbrain-s3-unified.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "duckbrain unified S3 backup SKIPPED — another run in progress"
  exit 0
fi

# ---- S3-ALERT-001: consecutive-failure alert gate ---------------------------
# The cron running this script is a no_agent silent watchdog: each run only
# reports ITSELF, so the 2026-10-03 outage (S3-GIT-007) stayed silent for
# 3+ days. The gate counts consecutive failures across runs (state under
# GATE_STATE, flock-serialized) and fires a `hermes send` alert at the
# S3_ALERT_THRESHOLD crossing, re-alerting every S3_REALERT_EVERY failures
# while an outage drags on.
#
# EXIT/TERM/INT trap: a timeout-killed cron run (the sync layer's 300s
# deadline has killed runs before) would otherwise die before reaching the
# call_gate below and the failure would never be counted. The trap records
# rc 143/130 for the killed run; because bash runs the EXIT trap after the
# signal trap, exactly ONE gate call happens per run. The gate inherits
# fd 9 — harmless: it locks its OWN per-job file, not this one.
#   S3_ALERT_GATE=0   disables the gate entirely (tests/one-off runs)
GATE="$SCRIPTS_DIR/s3-alert-gate.sh"
GATE_RC=0

on_run_killed() {
  case "$1" in
    TERM) GATE_RC=143 ;;
    INT)  GATE_RC=130 ;;
  esac
  echo "duckbrain unified S3 backup KILLED by signal $1 — recording failure via alert gate" >&2
}
trap 'on_run_killed TERM' TERM
trap 'on_run_killed INT' INT

call_gate() { # one gate call per run, success or failure
  # shellcheck disable=SC2086  # intentional unquoted: empty => omit arg
  if [ "$GATE_RC" -ne 0 ] || [ -n "$failures" ]; then
    set -- 1
  else
    set -- 0
  fi
  if [ -x "$GATE" ]; then
    S3_ALERT_LAST_ERROR="${S3_ALERT_LAST_ERROR:-$LAST_ERROR_LINE}" \
      "$GATE" duckbrain-s3-unified "$1" "$GATE_STATE"
  else
    echo "duckbrain unified S3 backup: alert gate missing ($GATE) — not counted" >&2
  fi
}
trap call_gate EXIT

if [ "${S3_ALERT_GATE:-1}" = "0" ]; then
  trap - EXIT
fi

NOW=$(date +%s)
failures=""
FAILED_NS=""
LAST_ERROR_LINE=""

record_last_error() { # keep the most recent non-blank stderr/stdout line for the alert gate
  LAST_ERROR_LINE="${1##*$'\n'}"
}

# skip_component <name> — true (0) when the component was explicitly skipped
skip_component() {
  local c="$1"
  if [ -z "$SKIP_COMPONENTS" ]; then return 1; fi
  case ",${SKIP_COMPONENTS}," in
    *",${c},"*) return 0 ;;
  esac
  return 1
}

# ---- 1. NATIVE DELTA SYNC — every run -------------------------------------
# `9>&-` per invocation (S3-GIT-006): the layer gets NO fd 9; the shell keeps
# holding the flock itself.
if skip_component native; then
  echo "duckbrain unified S3 backup: native-sync SKIPPED (DUCKBRAIN_S3_SKIP_COMPONENTS=$SKIP_COMPONENTS)"
elif NATIVE_OUT="$("$SCRIPTS_DIR/duckbrain-s3-native-sync.sh" 9>&- 2>&1)"; then
  if [ -n "$NATIVE_OUT" ]; then printf '%s\n' "$NATIVE_OUT"; fi
else
  if [ -n "$NATIVE_OUT" ]; then printf '%s\n' "$NATIVE_OUT"; fi
  failures="$failures native-sync"
  record_last_error "$NATIVE_OUT"
fi

# ---- 2. GIT-HISTORY PUSH — at most once per 24h ---------------------------
LAST_GIT=0
if [ -f "$GIT_MARKER" ]; then LAST_GIT="$(cat "$GIT_MARKER" 2>/dev/null || echo 0)"; fi
case "$LAST_GIT" in ''|*[!0-9]*) LAST_GIT=0 ;; esac
if skip_component git; then
  echo "duckbrain unified S3 backup: git-push SKIPPED (DUCKBRAIN_S3_SKIP_COMPONENTS=$SKIP_COMPONENTS)"
elif [ $((NOW - LAST_GIT)) -ge 86400 ]; then
  GIT_START=$(date +%s)
  # `9>&-` per invocation (S3-GIT-006): see the lock comment above.
  GIT_OUT="$("$SCRIPTS_DIR/duckbrain-s3-daily.sh" 9>&- 2>&1)"
  GIT_RC=$?
  if [ -n "$GIT_OUT" ]; then printf '%s\n' "$GIT_OUT"; fi
  PASS_TS=0
  if [ -f "$GIT_PASS_STAMP" ]; then PASS_TS="$(cat "$GIT_PASS_STAMP" 2>/dev/null || echo 0)"; fi
  case "$PASS_TS" in ''|*[!0-9]*) PASS_TS=0 ;; esac
  # completed = clean exit OR a completion stamp written by this very run
  layer_ok=0
  if [ "$GIT_RC" -eq 0 ]; then layer_ok=1; fi
  if [ "$PASS_TS" -ge "$GIT_START" ]; then layer_ok=1; fi
  if [ "$layer_ok" -eq 1 ]; then
    echo "$NOW" > "$GIT_MARKER"
  fi
  # loud regardless: a non-zero layer exit is still a reported failure
  if [ "$GIT_RC" -ne 0 ]; then
    failures="$failures git-push"
    ns="$(printf '%s\n' "$GIT_OUT" | sed -n 's/.*FAILED:\(.*\) (log:.*/\1/p' || true)"
    FAILED_NS="$FAILED_NS$ns"
    record_last_error "$GIT_OUT"
  fi
fi

# ---- 3. WEEKLY TAR.XZ ARCHIVE — at most once per 7d ------------------------
LAST_ARCH=0
if [ -f "$ARCH_MARKER" ]; then LAST_ARCH="$(cat "$ARCH_MARKER" 2>/dev/null || echo 0)"; fi
case "$LAST_ARCH" in ''|*[!0-9]*) LAST_ARCH=0 ;; esac
if skip_component weekly; then
  echo "duckbrain unified S3 backup: weekly-archive SKIPPED (DUCKBRAIN_S3_SKIP_COMPONENTS=$SKIP_COMPONENTS)"
elif [ $((NOW - LAST_ARCH)) -ge 604800 ]; then
  # `9>&-` per invocation (S3-GIT-006): see the lock comment above.
  if "$SCRIPTS_DIR/duckbrain-s3-weekly.sh" 9>&-; then
    echo "$NOW" > "$ARCH_MARKER"
  else
    failures="$failures weekly-archive"
  fi
fi

if [ -n "$failures" ]; then
  msg="duckbrain unified S3 backup FAILED components:$failures"
  if [ -n "$FAILED_NS" ]; then msg="$msg namespaces:$FAILED_NS"; fi
  echo "$msg"
  exit 1
fi
exit 0
