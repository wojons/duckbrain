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
# S3-GIT-003 (2026-09-18) — the skip above is keyed on LOCAL refs, so a
# REMOTE-side loss (a ref/object deleted or emptied on S3) survives forever: an
# unchanged namespace is never re-pushed and the loss stays silent. Two
# mechanisms restore the accidental self-heal the pre-S3-GIT-002 layer had, and
# NEITHER makes the 15-minute wrapper re-push everything:
#   * DUCKBRAIN_S3_FORCE_FULL=1 — explicit on-demand full pass: every namespace
#     NOT in failure backoff is pushed even when its refs are unchanged
#     (recovery after a known remote-side loss);
#   * an age-based periodic full pass — with DUCKBRAIN_S3_FULL_PASS_INTERVAL_S
#     (default 604800 = 7d; 0 disables) a namespace whose last SUCCESSFUL push
#     is at least that old is re-pushed even when its refs are unchanged. The
#     git layer itself runs at most once/24h, so this spreads a full pass over
#     every namespace roughly weekly — the one thing that can notice a
#     remote-side wipe with no local change. It is cheap on a healthy namespace
#     (the helper lists the remote refs and no-ops) and it is deliberately NOT
#     every 15 minutes.
#   Both are visible: per namespace `force-push <ns> (<reason>)`, then a
#   `forced-full:` roll-up (plus a `forced-full-age:` weekly-confirmation line),
#   and `forced=N` on the summary line. A forced pass that was partial says so —
#   deferred namespaces are named and forced failures are called out — instead
#   of printing a bare green line. Failure backoff is never overridden by
#   either mechanism.
#
# Env overrides (each defaults to the production value):
#   DUCKBRAIN_S3_NS_ROOT       (default $HOME/duckbrain/namespaces)
#   DUCKBRAIN_S3_STATE_DIR     (default $HOME/.hermes/state)
#   DUCKBRAIN_S3_LOG_DIR       (default $HOME/.hermes/backups)
#   DUCKBRAIN_S3_URL_TEMPLATE  (default s3://${BUCKET}/${PREFIX}/${name})
#     Template tokens: ${BUCKET} ${PREFIX} ${name} (production default) and the
#     brace forms {bucket} {prefix} {name}. Tests point this at file:// remotes.
#   DUCKBRAIN_S3_FORCE_FULL    (default 0 = off) — 1/true/yes/on forces the full
#     pass described in S3-GIT-003 above.
#   DUCKBRAIN_S3_FULL_PASS_INTERVAL_S (default 604800 = 7d; 0/non-numeric =
#     disabled) — age since last_success after which an unchanged namespace is
#     re-pushed anyway (the periodic forced full pass).
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
# S3-GIT-003 forced full pass (see the header). FORCE_FULL_ACTIVE is a plain
# 0/1 flag (the raw value is never used in arithmetic); FULL_PASS_INTERVAL is
# always a number (0 = disabled) so the age comparison cannot fail the pass.
FORCE_FULL_RAW="${DUCKBRAIN_S3_FORCE_FULL:-0}"
FORCE_FULL_ACTIVE=0
case "$FORCE_FULL_RAW" in
  1|true|TRUE|yes|YES|on|ON) FORCE_FULL_ACTIVE=1 ;;
esac
FULL_PASS_INTERVAL="${DUCKBRAIN_S3_FULL_PASS_INTERVAL_S:-604800}"
case "$FULL_PASS_INTERVAL" in
  ''|*[!0-9]*) FULL_PASS_INTERVAL=0 ;;
esac
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

# ---- S3-GIT-004: duplicate-bundle ref repair --------------------------------
# A ref on the remote is a DIRECTORY holding one bundle per tip:
#   <prefix>/<repo>/refs/heads/<branch>/<tipsha>.bundle
# Two racing pushes can each write a bundle with a DIFFERENT tip sha, leaving
# two objects under one ref. From then on every push to that ref is refused
# ("multiple bundles exists on server") and it never self-heals — the upstream
# per-ref lock is not reliable on S3-compatible endpoints. So converge by
# DETECTING and REPAIRING: quarantine the stale bundle OUTSIDE the ref tree
# (size-verified), then delete it from the ref path. See scripts/s3/README.md.
#
# Rules that matter:
#   * only for s3:// URLs — a file:// target makes ZERO aws calls;
#   * every failure is logged and swallowed: a repair never fails the pass;
#   * a bundle whose sha is not in the LOCAL repo is never deleted.
_s3_split_url() {
  local rest="${1#s3://}"
  _S3_BUCKET="${rest%%/*}"
  case "$rest" in
    */*) _S3_KEYPREFIX="${rest#*/}"; _S3_KEYPREFIX="${_S3_KEYPREFIX%/}" ;;
    *)   _S3_KEYPREFIX="" ;;
  esac
}

# helper_running <namespace-url> — 0 = a git-remote-s3 process is pushing THIS
# namespace's URL, 1 = none, 2 = the check could not be performed.
# Two details make it safe and precise:
#   * the helper execs its interpreter (python3), so a process-NAME match is
#     useless. The argv read straight out of /proc is the exact, self-match-proof
#     form — this script's own command line never names the helper as a token;
#   * the check is scoped to OUR namespace's URL. A helper pushing a different
#     namespace cannot add a bundle under our ref, and a host-wide check would
#     stall repairs for as long as any other namespace is pushing (proven live:
#     on this fleet the S3 layer keeps a helper alive for a minute at a time).
helper_running() {
  local url="$1" p cmd
  command -v pgrep >/dev/null 2>&1 || return 2
  [ -r /proc/self/cmdline ] || return 2
  for p in $(pgrep -f 'git-remote-s3' 2>/dev/null || true); do
    if [ "$p" = "$$" ] || [ "$p" = "$PPID" ]; then continue; fi
    cmd="$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null)" || continue
    case "$cmd" in
      *git-remote-s3*) ;;
      *) continue ;;
    esac
    case "$cmd" in
      *"$url"*) return 0 ;;
    esac
  done
  return 1
}

# _s3_list_ref_bundles <bucket> <ref-prefix> — one "key<TAB>LastModified<TAB>Size"
# line per bundle under the ref directory (empty output = no bundle). Tab
# separated because a namespace name may contain spaces. Excludes LOCK#/.lock/
# PROTECTED#/.zip — exactly what the upstream helper's get_bundles_for_ref()
# ignores. Returns non-zero when the listing itself failed.
_s3_list_ref_bundles() {
  local bucket="$1" prefix="$2" out
  out="$(AWS_PROFILE="$AWS_PROFILE" aws --endpoint-url "$AWS_ENDPOINT_URL" \
      s3api list-objects-v2 --bucket "$bucket" --prefix "$prefix" \
      --query 'Contents[].[Key,LastModified,Size]' --output text 2>/dev/null)" || return 1
  [ -n "$out" ] || return 0
  printf '%s\n' "$out" | tr -d '\r' | awk -F'\t' '
    NF >= 3 && $1 ~ /\.bundle$/ &&
    $1 !~ /PROTECTED#/ && $1 !~ /LOCK#/ &&
    index($1, ".zip") == 0 && index($1, "/LOCKS/") == 0 &&
    $1 !~ /\.lock$/ { print }'
}

# repair_duplicate_bundles <url> <ns-name> <ns-dir> <branch> <local-tip> — best
# effort, always returns 0. Prints its own log lines; a transient aws error is a
# log line, not a failed pass. The namespace DIRECTORY is passed separately from
# its NAME because the sha check runs against the local repo.
repair_duplicate_bundles() {
  local url="$1" ns="$2" nsdir="$3" branch="$4" tip="$5"
  local bucket refprefix lines line stale sha qkey size qsize
  local n=0 quarantined=0 shas=""

  _s3_split_url "$url"
  bucket="$_S3_BUCKET"
  if [ -n "$_S3_KEYPREFIX" ]; then
    refprefix="$_S3_KEYPREFIX/refs/heads/$branch/"
  else
    refprefix="refs/heads/$branch/"
  fi

  # A concurrent push can write a THIRD bundle while we prune: stand down.
  helper_running "$url"
  case "$?" in
    0) log "repair $ns: skipped refs/heads/$branch (a git-remote-s3 process is already pushing this namespace — a concurrent push could add another bundle)"; return 0 ;;
    2) log "repair $ns: skipped refs/heads/$branch (cannot check for a running git-remote-s3 process: pgrep unavailable)"; return 0 ;;
  esac

  lines="$(_s3_list_ref_bundles "$bucket" "$refprefix")" \
    || { log "repair $ns: list failed for refs/heads/$branch (continuing)"; return 0; }
  if [ -n "$lines" ]; then n="$(printf '%s\n' "$lines" | grep -c . || true)"; fi
  if [ "$n" -eq 0 ]; then
    log "repair $ns: no bundle under refs/heads/$branch yet (nothing to repair)"
    return 0
  fi
  if [ "$n" -eq 1 ]; then
    log "repair $ns: 1 bundle under refs/heads/$branch (ok, nothing to repair)"
    return 0
  fi

  # keeper = the bundle whose sha IS the local branch tip (the local repo is the
  # source of truth); if none matches, the newest by LastModified.
  keeper=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    sha="$(printf '%s' "$line" | cut -f1)"; sha="${sha##*/}"; sha="${sha%.bundle}"
    if [ "$sha" = "$tip" ]; then keeper="$(printf '%s' "$line" | cut -f1)"; fi
  done <<< "$lines"
  if [ -z "$keeper" ]; then
    keeper="$(printf '%s\n' "$lines" | sort -t"$(printf '\t')" -k2 | tail -n1 | cut -f1)"
    log "repair $ns: no bundle matches the local tip ${tip:0:12} under refs/heads/$branch — keeping the newest (${keeper##*/})"
  fi
  # never prune on a keeper we could not identify: that would delete the ref
  if [ -z "$keeper" ]; then
    log "repair $ns: could not identify a keeper under refs/heads/$branch — nothing deleted"
    return 0
  fi

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    stale="$(printf '%s' "$line" | cut -f1)"
    size="$(printf '%s' "$line" | cut -f3)"
    if [ "$stale" = "$keeper" ]; then continue; fi
    sha="${stale##*/}"; sha="${sha%.bundle}"
    if ! git -C "$nsdir" cat-file -e "${sha}^{commit}" 2>/dev/null; then
      log "repair-skip $ns: stale bundle $sha under refs/heads/$branch is NOT in the local repo — left alone"
      continue
    fi
    qkey="quarantine/git/$ns/$branch/$sha.bundle"
    if ! AWS_PROFILE="$AWS_PROFILE" aws --endpoint-url "$AWS_ENDPOINT_URL" s3 cp \
        "s3://$bucket/$stale" "s3://$bucket/$qkey" >/dev/null 2>&1; then
      log "repair $ns: quarantine copy failed for $sha (continuing, original kept)"
      continue
    fi
    qsize="$(AWS_PROFILE="$AWS_PROFILE" aws --endpoint-url "$AWS_ENDPOINT_URL" \
        s3api head-object --bucket "$bucket" --key "$qkey" \
        --query 'ContentLength' --output text 2>/dev/null)" || qsize=""
    if [ -z "$size" ] || [ -z "$qsize" ] || [ "$qsize" != "$size" ]; then
      log "repair $ns: quarantine size mismatch for $sha (source=${size:-?} copy=${qsize:-?}) — original NOT deleted"
      continue
    fi
    if ! AWS_PROFILE="$AWS_PROFILE" aws --endpoint-url "$AWS_ENDPOINT_URL" s3 rm \
        "s3://$bucket/$stale" >/dev/null 2>&1; then
      log "repair $ns: delete failed for $sha (quarantine copy kept) — continuing"
      continue
    fi
    quarantined=$((quarantined+1)); shas="$shas ${sha:0:12}"
  done <<< "$lines"

  if [ "$quarantined" -gt 0 ]; then
    log "repair $ns: quarantined $quarantined duplicate bundle(s) (${shas# })"
  fi

  # Assert exactly one bundle survives; if not, say so and let the push proceed
  # (it will fail again — that is honest, we do not fabricate success).
  if lines="$(_s3_list_ref_bundles "$bucket" "$refprefix")"; then
    n=0
    if [ -n "$lines" ]; then n="$(printf '%s\n' "$lines" | grep -c . || true)"; fi
    if [ "$n" -ne 1 ]; then
      log "repair $ns: still $n bundles after repair (refs/heads/$branch)"
    fi
  else
    log "repair $ns: re-verify list failed for refs/heads/$branch (continuing)"
  fi
  return 0
}

# repair_ns_refs <url> <ns-name> <ns-dir> — repair the ref of every local branch
# (the push does `--all`). No-op for a non-s3:// URL: zero aws calls.
repair_ns_refs() {
  local url="$1" nsname="$2" nsdir="$3" refname objname
  case "$url" in
    s3://*) : ;;
    *) return 0 ;;
  esac
  while IFS=$'\t' read -r refname objname; do
    if [ -n "${refname:-}" ]; then
      repair_duplicate_bundles "$url" "$nsname" "$nsdir" "${refname#refs/heads/}" "$objname"
    fi
  done < <(git -C "$nsdir" for-each-ref --format=$'%(refname)\t%(objectname)' refs/heads 2>/dev/null)
  return 0
}

if ! command -v git-remote-s3 >/dev/null 2>&1; then
  echo "FAIL: git-remote-s3 not on PATH"; log "FAIL: git-remote-s3 missing"; exit 1
fi
if [ ! -d "$NS_ROOT" ]; then
  echo "FAIL: $NS_ROOT does not exist"; log "FAIL: namespaces dir missing"; exit 1
fi

OK=0; SKIPPED=0; FAILED=0; FAILED_NS=""
# S3-GIT-003 bookkeeping: forced decisions (and why), plus the namespaces the
# pass could not cover (backoff-deferred) so a partial forced pass is visible.
FORCED=0; FORCED_ENV=0; FORCED_AGE=0; DEFERRED=0
FORCED_NS=""; FORCED_ENV_NS=""; FORCED_AGE_NS=""; FORCED_FAILED_NS=""; DEFERRED_NS=""
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

  # a prior attempt failed and its backoff window is still open → defer.
  # A forced pass does NOT override this: the ladder is what keeps one
  # rejecting namespace from consuming the backup budget, and it is unchanged.
  if [ "$fail_count" -gt 0 ] && [ "$next_retry" -gt "$now" ]; then
    SKIPPED=$((SKIPPED+1)); DEFERRED=$((DEFERRED+1)); DEFERRED_NS="$DEFERRED_NS $name"
    log "defer $name (fail_count=$fail_count next_retry=$next_retry retry_in_s=$((next_retry-now)))"
    continue
  fi

  # ---- S3-GIT-003: forced full pass ----------------------------------------
  # Decide BEFORE the up-to-date skip. The age rule deliberately applies only
  # where the ordinary path WOULD skip (no failure outstanding, recorded refs
  # match the current refs) and only to a namespace with a real last_success,
  # so the logged reason is honest and a fresh namespace is never "forced".
  force_reason=""; force_kind=""
  if [ "$FORCE_FULL_ACTIVE" -eq 1 ]; then
    force_reason="DUCKBRAIN_S3_FORCE_FULL=$FORCE_FULL_RAW"; force_kind=env
  elif [ "$FULL_PASS_INTERVAL" -gt 0 ] && [ "$fail_count" -eq 0 ] \
       && [ -n "$last_refs" ] && [ "$last_refs" = "$refs_now" ]; then
    last_success="$(state_get "$sfile" last_success 0)"
    case "$last_success" in ''|*[!0-9]*) last_success=0 ;; esac
    if [ "$last_success" -gt 0 ] \
       && [ $((now - last_success)) -ge "$FULL_PASS_INTERVAL" ]; then
      force_reason="age $((now - last_success))s >= ${FULL_PASS_INTERVAL}s since last_success"
      force_kind=age
    fi
  fi
  if [ -n "$force_reason" ]; then
    FORCED=$((FORCED+1)); FORCED_NS="$FORCED_NS $name"
    if [ "$force_kind" = "env" ]; then
      FORCED_ENV=$((FORCED_ENV+1)); FORCED_ENV_NS="$FORCED_ENV_NS $name"
    else
      FORCED_AGE=$((FORCED_AGE+1)); FORCED_AGE_NS="$FORCED_AGE_NS $name"
    fi
    log "force-push $name ($force_reason)"
  fi

  # last successful push covered exactly these refs, no failure is outstanding
  # and nothing forced a re-push → nothing to do, do not even build the URL
  if [ -z "$force_reason" ] && [ "$fail_count" -eq 0 ] \
     && [ -n "$last_refs" ] && [ "$last_refs" = "$refs_now" ]; then
    SKIPPED=$((SKIPPED+1))
    log "skip $name (up-to-date ${head_sha:0:12})"
    continue
  fi

  url="$(render_url "$URL_TEMPLATE" "$name")"

  # S3-GIT-004 — converge a duplicate-bundle ref collision BEFORE pushing (the
  # push would otherwise be rejected forever). Best effort: errexit is off for
  # the repair, so a transient aws error can never abort the pass; it is a no-op
  # with ZERO aws calls for a non-s3:// URL template.
  if [[ "$url" == s3://* ]]; then
    ( set +e; repair_ns_refs "$url" "$name" "$ns" ) || true
  fi

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
    # a forced re-push that failed must never be rolled up as a clean pass
    if [ -n "$force_reason" ]; then FORCED_FAILED_NS="$FORCED_FAILED_NS $name"; fi
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
# ---- S3-GIT-003: forced-pass bookkeeping -----------------------------------
# Every forced decision is already logged per namespace; these roll-ups make a
# forced pass auditable at a glance and give duckbrain-s3daily.log its periodic
# ("weekly") confirmation line. A forced pass that could not cover everything
# says so instead of degrading into a bare green summary.
if [ "$FORCED" -gt 0 ]; then
  log "forced-full: $FORCED namespace(s) re-pushed despite unchanged refs (env=$FORCED_ENV age=$FORCED_AGE):${FORCED_NS}"
fi
if [ "$FORCED_AGE" -gt 0 ]; then
  log "forced-full-age: periodic full re-push fired for $FORCED_AGE namespace(s) (interval ${FULL_PASS_INTERVAL}s since last_success):${FORCED_AGE_NS}"
fi
if [ "$FORCED" -gt 0 ] && [ "$DEFERRED" -gt 0 ]; then
  log "forced-full: PARTIAL — $DEFERRED namespace(s) in failure backoff were not re-pushed:${DEFERRED_NS}"
fi
if [ -n "$FORCED_FAILED_NS" ]; then
  log "forced-full: FAILED for:${FORCED_FAILED_NS}"
fi

END=$(date +%s); DUR=$((END-START))
log "OK: pushed=$OK skipped=$SKIPPED failed=$FAILED forced=$FORCED remote_repos=$REMOTE_REPOS duration_s=$DUR"
if [ "$FAILED" -gt 0 ]; then
  if [ "$FORCED" -gt 0 ]; then
    echo "duckbrain backup PARTIAL ($SUBPREFIX) — $OK pushed ($FORCED forced), $FAILED FAILED:$FAILED_NS (log: $LOG)"
  else
    echo "duckbrain backup PARTIAL ($SUBPREFIX) — $OK pushed, $FAILED FAILED:$FAILED_NS (log: $LOG)"
  fi
  if [ -n "$FORCED_FAILED_NS" ]; then
    echo "duckbrain backup FORCED-FULL PARTIAL ($SUBPREFIX) — forced re-push FAILED for:$FORCED_FAILED_NS"
  fi
  exit 1
fi
# Green, but a forced pass that skipped namespaces in backoff is NOT a clean
# full pass: say so (exit code stays honest — nothing attempted actually failed).
if [ "$FORCED" -gt 0 ] && [ "$DEFERRED" -gt 0 ]; then
  echo "duckbrain backup NOTICE ($SUBPREFIX) — forced full pass was partial: $DEFERRED namespace(s) in failure backoff were not re-pushed:$DEFERRED_NS"
fi
FORCE_SUFFIX=""
if [ "$FORCED" -gt 0 ]; then FORCE_SUFFIX=", forced full re-push: $FORCED (${FORCED_NS# })"; fi
echo "duckbrain backup OK ($SUBPREFIX) — $OK namespaces pushed (full git history), $SKIPPED skipped (up-to-date/deferred), ${DUR}s, $REMOTE_REPOS repos on S3${FORCE_SUFFIX}"
