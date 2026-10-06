#!/usr/bin/env bash
# duckbrain-ns-repack.sh — weekly hygiene for DuckBrain namespace repos that
# have an S3 remote. Packs loose objects / consolidates packs when a repo has
# drifted, so sizes stay reasonable and the S3 bundle push stays cheap.
#
# Why this exists: namespace repos accumulate append-only JSONL. Git stores a
# NEW FULL BLOB per append, and loose objects are delta-less + individually
# compressed. Git's own auto-gc (gc.auto=6700 loose objects) never trips on
# these repos (they sit around 3k loose objects), so giant blobs pile up
# unpacked and every bundle push has to compress all of them.
#
# Usage:
#   duckbrain-ns-repack.sh                 # sweep all namespaces w/ s3 remote
#   duckbrain-ns-repack.sh --ns scheduler  # one namespace
#   DRY_RUN=1 duckbrain-ns-repack.sh       # report only, change nothing
#
# Thresholds (env-overridable):
#   REPACK_LOOSE_COUNT=500     loose objects above this => repack
#   REPACK_LOOSE_MB=50         loose KiB above this    => repack
#   REPACK_PACKS=3             pack files above this   => repack
#   REPACK_MAX_OBJECT_MB=20    largest loose object above this => repack
set -uo pipefail

NS_ROOT="${DUCKBRAIN_NAMESPACES_DIR:-$HOME/duckbrain/namespaces}"
LOG="${REPACK_LOG:-$HOME/.hermes/state/duckbrain-ns-repack.log}"
LAST_JSON="${REPACK_LAST_JSON:-$HOME/.hermes/state/duckbrain-ns-repack-last.json}"
LOCK="${REPACK_LOCK:-$HOME/.hermes/state/duckbrain-ns-repack.lock}"

LOOSE_COUNT_MAX="${REPACK_LOOSE_COUNT:-500}"
LOOSE_MB_MAX="${REPACK_LOOSE_MB:-50}"
PACKS_MAX="${REPACK_PACKS:-3}"
MAX_OBJ_MB="${REPACK_MAX_OBJECT_MB:-20}"
DRY_RUN="${DRY_RUN:-0}"
PER_REPO_TIMEOUT="${REPACK_TIMEOUT:-1800}"   # 30 min guard per repo

NS_FILTER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ns) NS_FILTER="$2"; shift 2 ;;
    --all) shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "$LOG")" "$(dirname "$LOCK")" 2>/dev/null

# single-flight: never run two sweeps at once (they'd fight over repo locks)
exec 9>"$LOCK" || exit 1
if ! flock -n 9; then
  echo "$(date -Is) SKIP: another repack sweep is running (lock: $LOCK)"
  exit 0
fi

log() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG"; }

log "=== sweep start (root=$NS_ROOT dry_run=$DRY_RUN thresholds: loose>${LOOSE_COUNT_MAX} || loose>${LOOSE_MB_MAX}MB || packs>${PACKS_MAX} || largest>${MAX_OBJ_MB}MB)"

repos_scanned=0; repos_repacked=0; repos_skipped=0; repos_busy=0
freed_kb=0
declare -a JSON_ROWS=()

for dir in "$NS_ROOT"/*/; do
  [ -d "$dir/.git" ] || continue
  ns="$(basename "$dir")"
  if [ -n "$NS_FILTER" ] && [ "$ns" != "$NS_FILTER" ]; then continue; fi

  # only repos with an S3 remote (the ones whose pushes pay the pack cost)
  if ! git -C "$dir" remote -v 2>/dev/null | grep -q 's3://'; then continue; fi
  repos_scanned=$((repos_scanned+1))

  read -r loose_count loose_kb packs <<<"$(
    git -C "$dir" count-objects -v 2>/dev/null | awk '
      /^count:/     {c=$2}
      /^size:/      {s=$2}
      /^packs:/     {p=$2}
      END {print c+0, s+0, p+0}'
  )"
  largest_kb=$(find "$dir/.git/objects" -type f -not -path '*pack*' -printf '%s\n' 2>/dev/null | sort -rn | head -1)
  [ -n "$largest_kb" ] || largest_kb=0
  largest_mb=$(( largest_kb / 1048576 ))

  reason=""
  [ "$loose_count" -gt "$LOOSE_COUNT_MAX" ] && reason="${reason}loose_count=${loose_count} "
  [ $(( loose_kb / 1024 )) -gt "$LOOSE_MB_MAX" ] && reason="${reason}loose_mb=$(( loose_kb / 1024 )) "
  [ "$packs" -gt "$PACKS_MAX" ] && reason="${reason}packs=${packs} "
  [ "$largest_mb" -gt "$MAX_OBJ_MB" ] && reason="${reason}largest=${largest_mb}MB "

  if [ -z "$reason" ]; then
    repos_skipped=$((repos_skipped+1))
    continue
  fi

  # don't touch a repo with git work in flight (a push/commit mid-repack)
  if pgrep -f "namespaces/$ns( |$)" >/dev/null 2>&1; then
    log "$ns BUSY (git in flight) — needs repack ($reason) — skipping this week"
    repos_busy=$((repos_busy+1)); continue
  fi

  if [ "$DRY_RUN" != "1" ]; then
    before_kb=$(du -sk "$dir/.git" 2>/dev/null | awk '{print $1}')
    nice -n 10 timeout "$PER_REPO_TIMEOUT" git -C "$dir" repack -adf >/dev/null 2>&1
    rc=$?
    if [ $rc -ne 0 ]; then
      log "$ns REPACK FAILED rc=$rc ($reason) — left as-is for next sweep"
      repos_busy=$((repos_busy+1)); continue
    fi
    git -C "$dir" prune-packed >/dev/null 2>&1
    git -C "$dir" rev-parse HEAD >/dev/null 2>&1 || log "$ns WARNING: HEAD unreadable after repack"
    after_kb=$(du -sk "$dir/.git" 2>/dev/null | awk '{print $1}')
    saved_kb=$(( before_kb - after_kb )); [ "$saved_kb" -lt 0 ] && saved_kb=0
    freed_kb=$(( freed_kb + saved_kb ))
    read -r loose_after packs_after <<<"$(git -C "$dir" count-objects -v 2>/dev/null | awk '/^count:/{c=$2} /^packs:/{p=$2} END{print c+0, p+0}')"
    log "$ns REPACKED ($reason) .git $(( before_kb/1024 ))MB -> $(( after_kb/1024 ))MB | loose $loose_count -> $loose_after | packs $packs -> $packs_after"
    JSON_ROWS+=("{\"ns\":\"$ns\",\"action\":\"repacked\",\"reason\":\"${reason% }\",\"git_mb_before\":$(( before_kb/1024 )),\"git_mb_after\":$(( after_kb/1024 )),\"loose_before\":$loose_count,\"loose_after\":$loose_after,\"packs_before\":$packs,\"packs_after\":$packs_after}")
  else
    log "$ns WOULD REPACK ($reason)"
    JSON_ROWS+=("{\"ns\":\"$ns\",\"action\":\"would_repack\",\"reason\":\"${reason% }\"}")
  fi
  repos_repacked=$((repos_repacked+1))
done

if [ "$DRY_RUN" = "1" ]; then
  log "=== sweep done: scanned=$repos_scanned would_repack=$repos_repacked skipped=$repos_skipped busy/failed=$repos_busy (dry run: nothing changed)"
else
  log "=== sweep done: scanned=$repos_scanned repacked=$repos_repacked skipped=$repos_skipped busy/failed=$repos_busy freed=$(( freed_kb/1024 ))MB"
fi

{
  printf '{"ts":"%s","dry_run":%s,"scanned":%d,"repacked":%d,"skipped":%d,"busy_or_failed":%d,"freed_mb":%d,"repos":[%s]}\n' \
    "$(date -Is)" "$( [ "$DRY_RUN" = 1 ] && echo true || echo false )" \
    "$repos_scanned" "$repos_repacked" "$repos_skipped" "$repos_busy" "$(( freed_kb/1024 ))" \
    "$(IFS=,; echo "${JSON_ROWS[*]:-}")"
} > "$LAST_JSON"

exit 0
