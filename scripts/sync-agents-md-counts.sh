#!/usr/bin/env bash
# sync-agents-md-counts.sh — single extraction path for the committed
# test-counts.json manifest (the test-count gate moved off AGENTS.md in
# DF-2026-13).
#
# Extracts live Vitest totals (Test Files / Tests) from a vitest output file
# and either syncs test-counts.json to them (default) or asserts
# test-counts.json matches (--check).
#
#   scripts/sync-agents-md-counts.sh <vitest-output>        # sync test-counts.json
#   scripts/sync-agents-md-counts.sh --check <vitest-output> # assert match (CI mode)
#
# ci.yml ("Assert test-counts.json matches live suite") consumes --check mode
# against the same /tmp/vitest.out its test step tee'd. Run the sync mode in
# the SAME commit that changes the test tree.
#
# AGENTS.md is a protected agent-instruction file whose write is refused in
# unattended/api_server sessions, so this script MUST NOT read or write it
# (DF-2026-13). The counts live in a generated, non-protected manifest at the
# repo root: test-counts.json. The manifest path can be overridden via the
# DUCKBRAIN_COUNTS_MANIFEST env var — that seam exists so the hermetic Vitest
# test (src/test/sync-agents-md-counts.test.ts) can point the script at a
# temp-file manifest without touching the real one. CI never sets it.
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
MANIFEST=${DUCKBRAIN_COUNTS_MANIFEST:-test-counts.json}

# Same extraction CI used inline before this script existed (ANSI-stripped,
# parenthesized totals — parses both all-pass and partial-failure summaries).
strip_ansi() { sed -r 's/\x1B\[[0-9;]*[mK]//g' "$OUT"; }
SUITES=$(strip_ansi | grep -oP 'Test Files\s+.*\(\K\d+(?=\))' | tail -1 || true)
TESTS=$(strip_ansi | grep -oP 'Tests\s+.*\(\K\d+(?=\))' | tail -1 || true)
[ -n "$SUITES" ] && [ -n "$TESTS" ] || {
  echo "GAP-032: vitest summary unparseable in $OUT"; exit 1;
}

read_manifest_counts() {
  MSUITES=$(grep -oP '"suites":\s*\K\d+' "$MANIFEST" | head -1 || true)
  MTESTS=$(grep -oP '"tests":\s*\K\d+' "$MANIFEST" | head -1 || true)
}

if [ "$MODE" = "--check" ]; then
  [ -f "$MANIFEST" ] || {
    echo "GAP-032: counts manifest not found: $MANIFEST"; exit 1;
  }
  read_manifest_counts
  [ -n "${MSUITES:-}" ] && [ -n "${MTESTS:-}" ] || {
    echo "GAP-032: counts manifest unparseable: $MANIFEST"; exit 1;
  }
  if [ "$MSUITES" != "$SUITES" ] || [ "$MTESTS" != "$TESTS" ]; then
    echo "GAP-012 drift: $MANIFEST (${MSUITES} suites, ${MTESTS} tests) != live (${SUITES} suites, ${TESTS} tests)"
    exit 1
  fi
  echo "$MANIFEST test counts match live suite (${SUITES} suites, ${TESTS} tests)"
  exit 0
fi

# sync mode — write the generated manifest (never AGENTS.md).
if [ -f "$MANIFEST" ]; then
  read_manifest_counts
  if [ "${MSUITES:-}" = "$SUITES" ] && [ "${MTESTS:-}" = "$TESTS" ]; then
    echo "$MANIFEST already matches live suite (${SUITES} suites, ${TESTS} tests) — no change (idempotent)"
    exit 0
  fi
fi
cat > "$MANIFEST" <<EOF
{
  "suites": ${SUITES},
  "tests": ${TESTS},
  "provenance": "Totals extracted from the vitest summary (parenthesized Test Files / Tests totals) by scripts/sync-agents-md-counts.sh. Regenerate and commit in the SAME commit that changes the suite/test counts; CI asserts this manifest against the live suite (DF-2026-13 — the gate moved off the protected agent-instruction file)."
}
EOF
echo "$MANIFEST synced to live suite: ${SUITES} suites, ${TESTS} tests"
