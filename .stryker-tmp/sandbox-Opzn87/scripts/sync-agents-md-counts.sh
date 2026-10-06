#!/usr/bin/env bash
# sync-agents-md-counts.sh — single extraction path for AGENTS.md test counts.
#
# Extracts live Vitest totals (Test Files / Tests) from a vitest output file and
# either syncs AGENTS.md to them (default) or asserts AGENTS.md matches (--check).
#
#   scripts/sync-agents-md-counts.sh <vitest-output>        # sync AGENTS.md
#   scripts/sync-agents-md-counts.sh --check <vitest-output> # assert match (CI mode)
#
# ci.yml ("Assert AGENTS.md test counts match live suite") consumes --check mode
# against the same /tmp/vitest.out its test step tee'd. Run the sync mode in the
# SAME commit that changes the test tree.
#
# Exists because hand-typed literals drifted four times (GAP-006, GAP-008,
# GAP-012, CI-005): one script = one regex pair = one place to fix.
set -euo pipefail

MODE=sync
case "${1:-}" in
  --check) MODE=--check; shift ;;
  sync)    MODE=sync;    shift ;;
esac
OUT=${1:-/tmp/vitest.out}
[ -f "$OUT" ] || { echo "GAP-032: vitest output not found: $OUT"; exit 1; }

# Repo root (script lives in scripts/), so it works from any cwd.
cd "$(dirname "$0")/.."
AGENTS=AGENTS.md
[ -f "$AGENTS" ] || { echo "ERROR: $AGENTS not found at repo root"; exit 1; }

# Same extraction CI used inline before this script existed (ANSI-stripped,
# parenthesized totals — parses both all-pass and partial-failure summaries).
strip_ansi() { sed -r 's/\x1B\[[0-9;]*[mK]//g' "$OUT"; }
SUITES=$(strip_ansi | grep -oP 'Test Files\s+.*\(\K\d+(?=\))' | tail -1 || true)
TESTS=$(strip_ansi | grep -oP 'Tests\s+.*\(\K\d+(?=\))' | tail -1 || true)
[ -n "$SUITES" ] && [ -n "$TESTS" ] || {
  echo "GAP-032: vitest summary unparseable in $OUT"; exit 1;
}

if [ "$MODE" = "--check" ]; then
  grep -q "(${SUITES} suites, ${TESTS} tests)" "$AGENTS" || {
    echo "GAP-012 drift: AGENTS.md Tech Stack count != live (${SUITES} suites, ${TESTS} tests)"; exit 1;
  }
  grep -q "# ${TESTS} tests, ${SUITES} suites" "$AGENTS" || {
    echo "GAP-012 drift: AGENTS.md dev command count != live (${TESTS} tests, ${SUITES} suites)"; exit 1;
  }
  echo "AGENTS.md test counts match live suite (${SUITES} suites, ${TESTS} tests)"
  exit 0
fi

# sync mode — rewrite exactly the two token shapes the CI assertion greps.
before=$(md5sum "$AGENTS" | cut -d' ' -f1)
sed -i -r \
  -e "s/\([0-9]+ suites, [0-9]+ tests\)/(${SUITES} suites, ${TESTS} tests)/g" \
  -e "s/# [0-9]+ tests, [0-9]+ suites/# ${TESTS} tests, ${SUITES} suites/g" \
  "$AGENTS"
after=$(md5sum "$AGENTS" | cut -d' ' -f1)
if [ "$before" = "$after" ]; then
  if grep -q "(${SUITES} suites, ${TESTS} tests)" "$AGENTS" \
     && grep -q "# ${TESTS} tests, ${SUITES} suites" "$AGENTS"; then
    echo "AGENTS.md already matches live suite (${SUITES} suites, ${TESTS} tests) — no change (idempotent)"
  else
    echo "ERROR: AGENTS.md carries no count patterns to sync (expected '(N suites, M tests)' and '# M tests, N suites')"
    exit 1
  fi
else
  echo "AGENTS.md synced to live suite: ${SUITES} suites, ${TESTS} tests"
fi
