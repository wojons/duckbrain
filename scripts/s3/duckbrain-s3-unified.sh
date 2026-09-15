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
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"

STATE_DIR="${DUCKBRAIN_S3_STATE_DIR:-$HOME/.hermes/state}"
SCRIPTS_DIR="${DUCKBRAIN_S3_SCRIPTS_DIR:-$HOME/.hermes/scripts}"
SKIP_COMPONENTS="${DUCKBRAIN_S3_SKIP_COMPONENTS:-}"
GIT_MARKER="$STATE_DIR/s3-git-push.last"
ARCH_MARKER="$STATE_DIR/s3-weekly-archive.last"
GIT_PASS_STAMP="$STATE_DIR/s3-git-pass.last"

# Single-instance lock: the cron fires every 15 min but a full git-history
# push + weekly tar can outlive the tick window; without flock two concurrent
# runs clobber the same /tmp tarball (observed 2026-08-27 — manual run
# collided with the first cron tick; S3 data survived, upload raced).
mkdir -p "$STATE_DIR"
LOCK="$STATE_DIR/duckbrain-s3-unified.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "duckbrain unified S3 backup SKIPPED — another run in progress"
  exit 0
fi

NOW=$(date +%s)
failures=""
FAILED_NS=""

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
if skip_component native; then
  echo "duckbrain unified S3 backup: native-sync SKIPPED (DUCKBRAIN_S3_SKIP_COMPONENTS=$SKIP_COMPONENTS)"
elif ! "$SCRIPTS_DIR/duckbrain-s3-native-sync.sh"; then
  failures="$failures native-sync"
fi

# ---- 2. GIT-HISTORY PUSH — at most once per 24h ---------------------------
LAST_GIT=0
if [ -f "$GIT_MARKER" ]; then LAST_GIT="$(cat "$GIT_MARKER" 2>/dev/null || echo 0)"; fi
case "$LAST_GIT" in ''|*[!0-9]*) LAST_GIT=0 ;; esac
if skip_component git; then
  echo "duckbrain unified S3 backup: git-push SKIPPED (DUCKBRAIN_S3_SKIP_COMPONENTS=$SKIP_COMPONENTS)"
elif [ $((NOW - LAST_GIT)) -ge 86400 ]; then
  GIT_START=$(date +%s)
  GIT_OUT="$("$SCRIPTS_DIR/duckbrain-s3-daily.sh" 2>&1)"
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
  fi
fi

# ---- 3. WEEKLY TAR.XZ ARCHIVE — at most once per 7d ------------------------
LAST_ARCH=0
if [ -f "$ARCH_MARKER" ]; then LAST_ARCH="$(cat "$ARCH_MARKER" 2>/dev/null || echo 0)"; fi
case "$LAST_ARCH" in ''|*[!0-9]*) LAST_ARCH=0 ;; esac
if skip_component weekly; then
  echo "duckbrain unified S3 backup: weekly-archive SKIPPED (DUCKBRAIN_S3_SKIP_COMPONENTS=$SKIP_COMPONENTS)"
elif [ $((NOW - LAST_ARCH)) -ge 604800 ]; then
  if "$SCRIPTS_DIR/duckbrain-s3-weekly.sh"; then
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
