#!/bin/bash
# duckbrain-ns-litter-reap.sh — reap orphaned TEST namespaces from a DuckBrain store.
#
# WHY: per-run test namespaces (auger-pytest-*, auger-smoke-*, feature-test-*)
# accumulate on disk because namespace deletion and registry deletion are
# independent (DOGFOOD-004 / REG-GONE-001). They carry no owner and no value,
# but they inflate namespace counts and sweep times.
#
# SAFETY — every gate is a hard skip, never a warning:
#   1. Allowlist only. A directory must match a known test prefix. Nothing else
#      is ever a candidate, whatever else is on disk.
#   2. Dirty worktree -> SKIP. Uncommitted files mean something was mid-write.
#   3. Has a remote AND unpushed commits -> SKIP. That content is not backed up
#      anywhere. (A repo with NO remote is local-only scratch, so its commits do
#      not count against it — otherwise no litter would ever be reapable.)
#   4. Modified within --min-age seconds -> SKIP. A test suite may be running
#      right now; reaping its namespace mid-run would corrupt the test.
#   5. Removal requires --apply. The default is always a dry run.
#
# Usage:
#   duckbrain-ns-litter-reap.sh [--apply] [--root DIR] [--min-age SECONDS] [--json]
# Env:
#   DUCKBRAIN_NAMESPACES_PATH   store root (default: $HOME/duckbrain/namespaces)
#
# Exit codes: 0 ok, 2 usage error, 3 root missing.

set -u

ROOT="${DUCKBRAIN_NAMESPACES_PATH:-$HOME/duckbrain/namespaces}"
APPLY=0
JSON=0
ALLOW_SCAFFOLD=0
MIN_AGE="${DUCKBRAIN_LITTER_MIN_AGE:-1800}"

PATTERNS=(
  'auger-pytest-*'
  'auger-smoke-*'
  'feature-test-*'
  'drift-verify-*'
  'scratch-repack-*'
)

while [ $# -gt 0 ]; do
  case "$1" in
    --apply)   APPLY=1 ;;
    --json)    JSON=1 ;;
    --allow-uncommitted-scaffold) ALLOW_SCAFFOLD=1 ;;
    --root)    shift; ROOT="${1:-}" ;;
    --min-age) shift; MIN_AGE="${1:-1800}" ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -d "$ROOT" ] || { echo "store root not found: $ROOT" >&2; exit 3; }

now=$(date +%s)
candidates=0; total_kb=0
skipped_dirty=0; skipped_unpushed=0; skipped_recent=0; scaffold=0
reaped_kb=0
declare -a REAPED=() SKIPPED=()

for pat in "${PATTERNS[@]}"; do
  # shellcheck disable=SC2086
  for d in "$ROOT"/$pat; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    candidates=$((candidates + 1))

    kb=$(du -sk "$d" 2>/dev/null | cut -f1); kb=${kb:-0}
    total_kb=$((total_kb + kb))

    reason=""

    # gate 2/3 — worktree state
    if [ -d "$d/.git" ]; then
      dirty=$(git -C "$d" status --porcelain 2>/dev/null | wc -l)
      if [ "$dirty" -gt 0 ]; then
        # A directory with ZERO commits and NO remote is abandoned scaffolding:
        # a test created it and died before its first commit. There is no
        # history to lose, only the untracked files themselves — and the
        # recency gate still protects anything being created right now.
        commits=$(git -C "$d" rev-list --count HEAD 2>/dev/null)
        has_remote=$(git -C "$d" remote 2>/dev/null)
        if [ "$ALLOW_SCAFFOLD" -eq 1 ] && [ -z "${commits:-}" ] && [ -z "$has_remote" ]; then
          scaffold=$((scaffold + 1))
        else
          reason="dirty worktree ($dirty files)"
          skipped_dirty=$((skipped_dirty + 1))
        fi
      elif [ -n "$(git -C "$d" remote 2>/dev/null)" ]; then
        up=$(git -C "$d" rev-list --count @{u}..HEAD 2>/dev/null) || up=""
        if [ -z "$up" ]; then
          up=$(git -C "$d" log --branches --not --remotes --oneline 2>/dev/null | wc -l)
        fi
        if [ "${up:-0}" -gt 0 ]; then
          reason="has remote + $up unpushed commit(s)"
          skipped_unpushed=$((skipped_unpushed + 1))
        fi
      fi
    fi

    # gate 4 — recency (only if not already skipped). Measured on DATA files:
    # a namespace's .git internals are rewritten by every gc/commit, so they
    # always look fresh and would mask the real "is anyone writing this" signal.
    if [ -z "$reason" ]; then
      newest=$(find "$d" -type f -not -path '*/.git/*' -printf '%T@\n' 2>/dev/null \
               | sort -rn | head -1 | cut -d. -f1)
      if [ -n "${newest:-}" ]; then
        age=$((now - newest))
        if [ "$age" -lt "$MIN_AGE" ]; then
          reason="modified ${age}s ago (< ${MIN_AGE}s)"
          skipped_recent=$((skipped_recent + 1))
        fi
      fi
    fi

    if [ -n "$reason" ]; then
      SKIPPED+=("$name|$reason|$kb")
      continue
    fi

    REAPED+=("$name|$kb")
    reaped_kb=$((reaped_kb + kb))
    [ "$APPLY" -eq 1 ] && rm -rf -- "$d"
  done
done

if [ "$JSON" -eq 1 ]; then
  printf '{"root":"%s","apply":%d,"min_age":%d,"candidates":%d,"reapable":%d,' \
    "$ROOT" "$APPLY" "$MIN_AGE" "$candidates" "${#REAPED[@]}"
  printf '"skipped_dirty":%d,"skipped_unpushed":%d,"skipped_recent":%d,"uncommitted_scaffold":%d,"reapable_kb":%d}\n' \
    "$skipped_dirty" "$skipped_unpushed" "$skipped_recent" "$scaffold" "$reaped_kb"
  exit 0
fi

mode=$([ "$APPLY" -eq 1 ] && echo "APPLY" || echo "DRY RUN")

fmt_kb() {  # human size from KB, without rounding a real value to zero
  if [ "$1" -lt 1024 ]; then printf '%s KB' "$1"; else printf '%s MB' "$(($1 / 1024))"; fi
}

echo "namespace litter reclaim — $mode"
echo "  root:       $ROOT"
echo "  min age:    ${MIN_AGE}s"
echo "  candidates: $candidates matching the test-prefix allowlist"
echo

if [ ${#REAPED[@]} -gt 0 ]; then
  verb=$([ "$APPLY" -eq 1 ] && echo "reaped" || echo "would reap")
  echo "  $verb ${#REAPED[@]} namespace(s), $(fmt_kb "$reaped_kb"):"
  for row in "${REAPED[@]}"; do
    printf '    %-42s %7s KB\n' "${row%%|*}" "${row##*|}"
  done
  echo
fi

if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo "  SKIPPED ${#SKIPPED[@]} namespace(s) — data present, not litter:"
  for row in "${SKIPPED[@]}"; do
    name=${row%%|*}; rest=${row#*|}; why=${rest%%|*}; kb=${rest##*|}
    printf '    %-42s %7s KB   %s\n' "$name" "$kb" "$why"
  done
  echo
fi

if [ "$APPLY" -eq 0 ]; then
  echo "  nothing was removed (dry run). re-run with --apply to remove the reapable set."
fi
