#!/bin/bash
# Red-proof gate: proves tests are NOT phantoms.
#
# A test is "red-proof" if it FAILS when production code is broken.
# This script:
# 1. Mutates production code to introduce a known bug
# 2. Runs the test suite
# 3. Expects FAILURE (if tests pass after mutation, they are phantoms)
# 4. Restores original code
#
# If tests PASS after mutation → the gate FAILS (phantom test detected).
# If tests FAIL after mutation → the gate PASSES (red-proof confirmed).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PROD_FILE="$1"
MUTATION_PATTERN="$2"
MUTANT_REPLACEMENT="$3"

if [ -z "$PROD_FILE" ] || [ -z "$MUTATION_PATTERN" ] || [ -z "$MUTANT_REPLACEMENT" ]; then
    echo "Usage: red-proof-gate.sh <prod-file> <pattern> <replacement>"
    echo "  prod-file: relative path to production file"
    echo "  pattern: grep pattern to find the line to mutate"
    echo "  replacement: what to replace that line with (to introduce a bug)"
    exit 1
fi

PROD_PATH="$REPO_ROOT/$PROD_FILE"

if [ ! -f "$PROD_PATH" ]; then
    echo "ERROR: Production file not found: $PROD_PATH"
    exit 1
fi

# Save original
ORIGINAL=$(cat "$PROD_PATH")
TEMP_ORIG=$(mktemp)
echo "$ORIGINAL" > "$TEMP_ORIG"
trap "cp '$TEMP_ORIG' '$PROD_PATH'; rm -f '$TEMP_ORIG'" EXIT

# Apply mutation: remove the instanceof check from isDurabilityError
MUTATED=$(echo "$ORIGINAL" | sed 's/return target instanceof DurabilityError/return false/g')
echo "$MUTATED" > "$PROD_PATH"

echo "Red-proof gate: testing that suite FAILS when instanceof check is removed"
echo "  Original: return target instanceof DurabilityError"
echo "  Mutant:   return false"
echo ""

# Run the test suite — we EXPECT it to FAIL
TEST_OUTPUT=$(npx vitest run src/test/red-proof-gate.test.ts 2>&1 || true)
EXIT_CODE=$?

echo "$TEST_OUTPUT"

if [ $EXIT_CODE -eq 0 ]; then
    echo ""
    echo "FAIL: Red-proof gate FAILED."
    echo "  Tests PASSED even after production code was broken (instanceof check removed)."
    echo "  This means the tests are PHANTOM — they pass before AND after a fix."
    echo "  A red-proof test MUST fail when production code is broken."
    exit 1
else
    echo ""
    echo "PASS: Red-proof gate works correctly."
    echo "  Tests correctly FAIL when the instanceof check is removed."
    echo "  The suite is red-proof — it catches production code breakage."
    exit 0
fi
