#!/usr/bin/env bash
# test-component-completeness.sh — every script the unified wrapper invokes must exist
# IN THE REPO, not only in the deployed scripts dir.
#
# Why this exists (S3-GIT-007, 2026-10-03): duckbrain-s3-unified.sh resolves its three
# components as $SCRIPTS_DIR/{native-sync,daily,weekly}.sh. Two of the three lived ONLY in
# ~/.hermes/scripts and were never committed, so the repo's stated role ("the reviewable,
# versioned source of the ops crons") was false for exactly the layer that then stalled and
# wedged the whole backup for 3 days. An unversioned component cannot be reviewed, tested,
# or rolled back.
#
# Hermetic: reads files, runs nothing, touches no S3.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$SELF_DIR/duckbrain-s3-unified.sh"
DEPLOYED_DIR="${DUCKBRAIN_S3_SCRIPTS_DIR:-$HOME/.hermes/scripts}"

pass=0; fail=0
ok()   { echo "  PASS: $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL: $*"; fail=$((fail+1)); }

echo "=== component completeness (S3-GIT-007)"
if [ ! -f "$WRAPPER" ]; then
  bad "wrapper not found at $WRAPPER"; echo; echo "completeness harness: $pass passed, $fail failed"; exit 1
fi

# 1. every component the wrapper resolves must exist in the repo
mapfile -t refs < <(grep -oE '\$SCRIPTS_DIR/[A-Za-z0-9._-]+\.sh' "$WRAPPER" | sed 's|\$SCRIPTS_DIR/||' | sort -u)
if [ "${#refs[@]}" -eq 0 ]; then
  bad "the wrapper references no \$SCRIPTS_DIR/*.sh component (parser drift? update this harness)"
else
  echo "  wrapper resolves ${#refs[@]} component(s): ${refs[*]}"
fi

for c in "${refs[@]:-}"; do
  [ -n "$c" ] || continue
  if [ -f "$SELF_DIR/$c" ]; then
    ok "tracked in repo: $c"
  else
    bad "MISSING from the repo: $c  (the wrapper calls it; it exists only in $DEPLOYED_DIR)"
  fi
done

# 2. every tracked .sh in this dir that the wrapper can call must be executable
for c in "${refs[@]:-}"; do
  [ -n "$c" ] || continue
  f="$SELF_DIR/$c"
  if [ -f "$f" ] && [ ! -x "$f" ]; then
    bad "not executable: $c (the wrapper invokes it directly)"
  fi
done

# 3. inverse check: no *-sync/daily/weekly component exists in the deployed dir that the
#    repo lacks. Catches the drift from the other side (new layer added, never committed).
if [ -d "$DEPLOYED_DIR" ]; then
  for f in "$DEPLOYED_DIR"/duckbrain-s3-*.sh; do
    [ -f "$f" ] || continue
    b="$(basename "$f")"
    case "$b" in
      *.bak-*) continue ;;
    esac
    if [ -f "$SELF_DIR/$b" ]; then
      ok "deployed+tracked: $b"
    else
      bad "deployed but UNTRACKED: $b  (commit it into scripts/s3/ or document why it is out of scope)"
    fi
  done
fi

# 4. README table must name every component (the docs are the lookup path)
README="$SELF_DIR/README.md"
if [ -f "$README" ]; then
  for c in "${refs[@]:-}"; do
    [ -n "$c" ] || continue
    if grep -q "\`$c\`" "$README"; then
      ok "README lists: $c"
    else
      bad "README table does not list: $c"
    fi
  done
fi

echo "  -----"
echo "completeness harness: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
