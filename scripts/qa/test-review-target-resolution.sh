#!/usr/bin/env bash
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
HARNESS=${BUNKER_QA_SCRIPT:-/home/kara/.hermes/scripts/bunker-qa.sh}
STANDIN=/home/kara/.hermes/stand-in/review/duckbrain
PARENT=$(dirname -- "$ROOT")
TMPDIR_LOCAL=$(mktemp -d "${TMPDIR:-/tmp}/duckbrain-review-target.XXXXXX")
trap 'rm -rf "$TMPDIR_LOCAL"' EXIT HUP INT TERM

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
[ -x "$HARNESS" ] || fail "harness is not executable: $HARNESS"
[ -d "$STANDIN" ] || fail "review stand-in is missing: $STANDIN"
BOARD_LINK="$STANDIN/.coding-hermes/board"
[ -L "$BOARD_LINK" ] || fail "review stand-in board link is missing: $BOARD_LINK"
PRODUCT_DIR=$(dirname -- "$(realpath "$BOARD_LINK")") || fail "cannot resolve product board target"
EXPECTED=$(git -C "$PRODUCT_DIR" rev-parse --show-toplevel 2>/dev/null) || fail "product board target is not a Git root"
EXPECTED=$(realpath "$EXPECTED") || fail "cannot resolve product root"
[ "$EXPECTED" != "$PARENT" ] || fail "product root is the parent repository '$PARENT'"

run_resolve() {
  local name=$1
  shift
  set +e
  "$@" >"$TMPDIR_LOCAL/$name.out" 2>"$TMPDIR_LOCAL/$name.err"
  local rc=$?
  set -e
  printf '%s\n' "--- $name stdout ---"
  cat "$TMPDIR_LOCAL/$name.out"
  printf '%s\n' "--- $name stderr ---"
  cat "$TMPDIR_LOCAL/$name.err"
  return "$rc"
}

set -e
run_resolve resolved "$HARNESS" resolve "$STANDIN" || fail "stand-in resolution refused"
ACTUAL=$(tr -d '\r' <"$TMPDIR_LOCAL/resolved.out" | tail -n 1)
[ "$ACTUAL" = "$EXPECTED" ] || fail "resolved root '$ACTUAL' does not equal checkout '$EXPECTED'"
[ "$ACTUAL" != "$PARENT" ] || fail "resolved to parent repository '$PARENT'"

set +e
BUNKER_QA_SUBDIR=. run_resolve scoped "$HARNESS" resolve "$STANDIN"
SCOPED_RC=$?
set -e
SCOPED=$(tr -d '\r' <"$TMPDIR_LOCAL/scoped.out" | tail -n 1)
[ "$SCOPED" != "$PARENT" ] || fail "explicit scope claimed parent repository '$PARENT'"
[ "$SCOPED_RC" -eq 0 ] || fail "explicit scope control refused unexpectedly (rc=$SCOPED_RC)"

printf 'PASS: review stand-in resolves to %s, not parent %s; explicit scope control is non-parent\n' "$EXPECTED" "$PARENT"
