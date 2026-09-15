#!/usr/bin/env bash
# Core DuckBrain → Hetzner S3 git push (awslabs/git-remote-s3)
# Usage: duckbrain-s3-push.sh <subprefix> <remote-name>
#   daily:  duckbrain-s3-push.sh current/git   s3daily   → s3://duckbrain/current/git/<ns>
#   weekly: duckbrain-s3-push.sh archives/git  s3weekly  → s3://duckbrain/archives/git/<ns>
# Pushes EVERY namespace repo (full git history) as an S3 git remote.
# Storage: each ref = <prefix>/<ref>/<sha>.bundle; unchanged repos = no-op
# ("Everything up-to-date" — helper not invoked). Restore anywhere:
#   AWS_PROFILE=duckbrain AWS_ENDPOINT_URL=https://hel1.your-objectstorage.com \
#     git clone s3://duckbrain/<subprefix>/<namespace>
# Uses AWS_PROFILE=duckbrain (NOT sourcing ~/.hermes/.env — line 39 has a bare
# token that breaks `source`). Only repo mutation: the named remote.
#
# S3-GIT-002 hardening (2026-09-15) — one rejecting namespace must never force a
# full ~140-repo re-push on every 15-minute tick:
#   * per-namespace state ($STATE_DIR/s3-git-ns/<remote>/<ns>.state) records the
#     last successful push (HEAD sha + a hash of all pushed refs), so an unchanged
#     healthy namespace is skipped WITHOUT any push — the cheap steady state;
#   * a failed push starts/extends a backoff ladder (900/3600/21600/86400 s);
#     further attempts are deferred (logged, not attempted) until next_retry;
#   * a COMPLETED pass (the loop walked every namespace) stamps
#     $STATE_DIR/s3-git-pass.last, so the wrapper can tell "the pass ran" from
#     "the pass never started";
#   * the exit code stays honest: 1 only when an ATTEMPTED push failed.
#
# Env overrides (each defaults to the production value):
#   DUCKBRAIN_S3_NS_ROOT       (default $HOME/duckbrain/namespaces)
#   DUCKBRAIN_S3_STATE_DIR     (default $HOME/.hermes/state)
#   DUCKBRAIN_S3_LOG_DIR       (default $HOME/.hermes/backups)
#   DUCKBRAIN_S3_URL_TEMPLATE  (default s3://${BUCKET}/${PREFIX}/${name})
#     Template tokens: ${BUCKET} ${PREFIX} ${name} (production default) and the
#     brace forms {bucket} {prefix} {name}. Tests point this at file:// remotes.
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
export AWS_PROFILE="duckbrain"
export AWS_ENDPOINT_URL="https://hel1.your-objectstorage.com"
export AWS_DEFAULT_REGION="us-east-1"
BUCKET="duckbrain"
SUBPREFIX="${1:?usage: duckbrain-s3-push.sh <subprefix> <remote-name>}"
REMOTE_NAME="${2:?usage: duckbrain-s3-push.sh <subprefix> <remote-name>}"
PREFIX="${SUBPREFIX}"

# ---- configurable roots (defaults == production values) --------------------
NS_ROOT="${DUCKBRAIN_S3_NS_ROOT:-$HOME/duckbrain/namespaces}"
STATE_DIR="${DUCKBRAIN_S3_STATE_DIR:-$HOME/.hermes/state}"
LOG_DIR="${DUCKBRAIN_S3_LOG_DIR:-$HOME/.hermes/backups}"
TPL_DEFAULT='s3://${BUCKET}/${PREFIX}/${name}'
URL_TEMPLATE="${DUCKBRAIN_S3_URL_TEMPLATE:-$TPL_DEFAULT}"

# State is keyed by remote name: the same namespace pushed under a different
# remote (different S3 prefix) must not be skipped as "already pushed".
REMOTE_KEY="${REMOTE_NAME//[!A-Za-z0-9._-]/_}"
NS_STATE_DIR="$STATE_DIR/s3-git-ns/$REMOTE_KEY"
PASS_STAMP="$STATE_DIR/s3-git-pass.last"
BACKOFF_LADDER=(900 3600 21600 86400)
LOG="$LOG_DIR/duckbrain-${REMOTE_NAME}.log"
START=$(date +%s)
mkdir -p "$LOG_DIR" "$NS_STATE_DIR"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }

# ---- helpers ---------------------------------------------------------------
# render_url <template> <namespace> — expand the template tokens. Quoted
# patterns make the replacement literal; no eval anywhere.
render_url() {
  local t="$1" n="$2" p
  p='${BUCKET}'; t="${t//"$p"/$BUCKET}"
  p='${PREFIX}'; t="${t//"$p"/$PREFIX}"
  p='${name}';   t="${t//"$p"/$n}"
  p='{bucket}';  t="${t//"$p"/$BUCKET}"
  p='{prefix}';  t="${t//"$p"/$PREFIX}"
  p='{name}';    t="${t//"$p"/$n}"
  printf '%s' "$t"
}

# state_file_for <namespace> — filename is sanitised (namespace names may
# contain spaces, e.g. "Hermes DAGger"); the real name is stored inside as
# `name=`.
state_file_for() {
  printf '%s/%s.state' "$NS_STATE_DIR" "${1//[!A-Za-z0-9._-]/_}"
}

# state_get <file> <key> [default] — single-value read from a key=value file.
state_get() {
  local f="$1" k="$2" d="${3:-}" v=""
  if [ -f "$f" ]; then
    v="$(grep -m1 "^${k}=" "$f" 2>/dev/null | cut -d= -f2- || true)"
  fi
  if [ -z "$v" ]; then v="$d"; fi
  printf '%s' "$v"
}

# state_write <file> <line>... — atomic (tmp + mv) so a concurrent reader never
# sees a half-written state file.
state_write() {
  local f="$1"; shift
  local tmp="$f.tmp.$$" line
  : > "$tmp"
  for line in "$@"; do printf '%s\n' "$line" >> "$tmp"; done
  mv -f "$tmp" "$f"
}

if ! command -v git-remote-s3 >/dev/null 2>&1; then
  echo "FAIL: git-remote-s3 not on PATH"; log "FAIL: git-remote-s3 missing"; exit 1
fi
if [ ! -d "$NS_ROOT" ]; then
  echo "FAIL: $NS_ROOT does not exist"; log "FAIL: namespaces dir missing"; exit 1
fi

OK=0; SKIPPED=0; FAILED=0; FAILED_NS=""
for ns in "$NS_ROOT"/*/; do
  if [ ! -d "$ns/.git" ]; then SKIPPED=$((SKIPPED+1)); continue; fi
  name="$(basename "$ns")"
  if ! git -C "$ns" rev-parse --verify HEAD >/dev/null 2>&1; then
    SKIPPED=$((SKIPPED+1)); log "skip $name (no commits)"; continue
  fi
  head_sha="$(git -C "$ns" rev-parse HEAD)"
  # everything `--all --tags` would push, hashed: a new tag with an unchanged
  # HEAD must NOT be mistaken for "up to date".
  refs_now="$(git -C "$ns" for-each-ref --format='%(refname):%(objectname)' refs/heads refs/tags | sha256sum | cut -d' ' -f1 || true)"
  sfile="$(state_file_for "$name")"
  fail_count="$(state_get "$sfile" fail_count 0)"
  next_retry="$(state_get "$sfile" next_retry 0)"
  last_refs="$(state_get "$sfile" refs_hash "")"
  case "$fail_count" in ''|*[!0-9]*) fail_count=0 ;; esac
  case "$next_retry" in ''|*[!0-9]*) next_retry=0 ;; esac
  now=$(date +%s)

  # a prior attempt failed and its backoff window is still open → defer
  if [ "$fail_count" -gt 0 ] && [ "$next_retry" -gt "$now" ]; then
    SKIPPED=$((SKIPPED+1))
    log "defer $name (fail_count=$fail_count next_retry=$next_retry retry_in_s=$((next_retry-now)))"
    continue
  fi

  # last successful push covered exactly these refs and no failure is
  # outstanding → nothing to do, do not even build the remote URL
  if [ "$fail_count" -eq 0 ] && [ -n "$last_refs" ] && [ "$last_refs" = "$refs_now" ]; then
    SKIPPED=$((SKIPPED+1))
    log "skip $name (up-to-date ${head_sha:0:12})"
    continue
  fi

  url="$(render_url "$URL_TEMPLATE" "$name")"
  if git -C "$ns" remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
    git -C "$ns" remote set-url "$REMOTE_NAME" "$url"
  else
    git -C "$ns" remote add "$REMOTE_NAME" "$url"
  fi

  push_all_out=""; push_tags_out=""
  if push_all_out="$(git -C "$ns" push -q "$REMOTE_NAME" --all 2>&1)" \
     && push_tags_out="$(git -C "$ns" push -q "$REMOTE_NAME" --tags 2>&1)"; then
    OK=$((OK+1))
    state_write "$sfile" "name=$name" "sha=$head_sha" "refs_hash=$refs_now" \
      "last_success=$now" "last_attempt=$now" "fail_count=0" "next_retry=0"
  else
    FAILED=$((FAILED+1)); FAILED_NS="$FAILED_NS $name"; log "FAIL push $name"
    reason="$(printf '%s\n%s\n' "$push_all_out" "$push_tags_out" | grep -v '^[[:space:]]*$' | tail -n1 || true)"
    if [ -n "$reason" ]; then log "  reason[$name]: $reason"; fi
    fail_count=$((fail_count+1))
    idx=$((fail_count-1))
    ladder_max=$(( ${#BACKOFF_LADDER[@]} - 1 ))
    if [ "$idx" -gt "$ladder_max" ]; then idx="$ladder_max"; fi
    next_retry=$((now + BACKOFF_LADDER[idx]))
    state_write "$sfile" "name=$name" \
      "sha=$(state_get "$sfile" sha "")" \
      "refs_hash=$(state_get "$sfile" refs_hash "")" \
      "last_success=$(state_get "$sfile" last_success 0)" \
      "last_attempt=$now" "fail_count=$fail_count" "next_retry=$next_retry"
    log "  backoff[$name]: fail_count=$fail_count next_retry=$next_retry (+${BACKOFF_LADDER[idx]}s)"
  fi
done

# ---- completion stamp: the loop above walked EVERY namespace ---------------
# Written whether or not individual pushes failed — it means "the pass ran",
# not "the pass was clean". The wrapper uses it to advance the 24h marker.
stamp_tmp="$PASS_STAMP.tmp.$$"
date +%s > "$stamp_tmp"
mv -f "$stamp_tmp" "$PASS_STAMP"

# The S3 object count needs real AWS credentials — skip it for non-s3://
# targets (file:// remotes in the test harness) so no AWS call is ever made.
REMOTE_REPOS=0
if [[ "$URL_TEMPLATE" == s3://* ]]; then
  REMOTE_REPOS=$(AWS_PROFILE="$AWS_PROFILE" aws --endpoint-url "$AWS_ENDPOINT_URL" s3api list-objects-v2 --bucket "$BUCKET" --prefix "${PREFIX}/" --query 'Contents[].Key' --output text 2>/dev/null | tr '\t' '\n' | awk -F/ -v p="${PREFIX}/" 'index($0,p)==1 {print $3}' | sort -u | grep -c . || true)
  REMOTE_REPOS="${REMOTE_REPOS:-0}"
else
  log "note: skipped S3 remote repo count (URL template is not s3://)"
fi
END=$(date +%s); DUR=$((END-START))
log "OK: pushed=$OK skipped=$SKIPPED failed=$FAILED remote_repos=$REMOTE_REPOS duration_s=$DUR"
if [ "$FAILED" -gt 0 ]; then
  echo "duckbrain backup PARTIAL ($SUBPREFIX) — $OK pushed, $FAILED FAILED:$FAILED_NS (log: $LOG)"
  exit 1
fi
echo "duckbrain backup OK ($SUBPREFIX) — $OK namespaces pushed (full git history), $SKIPPED skipped (up-to-date/deferred), ${DUR}s, $REMOTE_REPOS repos on S3"
