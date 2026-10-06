#!/usr/bin/env bash
# Red-proof gate (TESTQ-001): proves the test suite catches real mutations.
#
# Applies a known mutation to production code, runs the pinned test file,
# and requires it to FAIL. A suite that still passes over broken code is a
# phantom suite, and this gate blocks CI.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROD="$REPO_ROOT/src/storage/durability-errors.ts"
TEST_FILE="src/test/red-proof-gate.test.ts"

if [ ! -f "$PROD" ]; then
    echo "FAIL: production file missing: $PROD"
    exit 1
fi

ORIGINAL=$(cat "$PROD")

# Mutation: replace the instanceof check with `return false`
sed -i 's/return target instanceof DurabilityError/return false/g' "$PROD"

echo "Red-proof gate: testing that tests FAIL when instanceof check is removed"
cd "$REPO_ROOT"

if npx vitest run "$TEST_FILE" 2>&1; then
    echo "FAIL: tests passed on broken code — phantom suite detected"
    echo "$ORIGINAL" > "$PROD"
    exit 1
else
    echo "$ORIGINAL" > "$PROD"
    echo "PASS: tests correctly failed on broken code — suite is red-proof"
    exit 0
fi
