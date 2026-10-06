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

# Save original and apply mutation using Python for precision
cp "$PROD" /tmp/de-backup.ts
python3 - "$PROD" << 'PYEOF'
import sys
path = sys.argv[1]
with open(path) as f:
    content = f.read()

old_func = """export function isDurabilityError(error: unknown): error is DurabilityError {
  return (
    error instanceof DurabilityError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: string }).name === "DurabilityError" &&
      typeof (error as { code?: string }).code === "string")
  );
}"""

new_func = """export function isDurabilityError(error: unknown): error is DurabilityError {
  return false;
}"""

if old_func in content:
    content = content.replace(old_func, new_func, 1)
    with open(path, "w") as f:
        f.write(content)
    print("MUTATION applied successfully")
else:
    print("ERROR: could not find function to mutate")
    sys.exit(1)
PYEOF

cd "$REPO_ROOT"

echo "Red-proof gate: MUTATING isDurabilityError → return false"
echo ""

if npx vitest run "$TEST_FILE" 2>&1; then
    echo ""
    echo "FAIL: Red-proof gate FAILED."
    echo "  Tests PASSED even after production code was broken."
    echo "  This means the tests are PHANTOMS."
    cp /tmp/de-backup.ts "$PROD"
    exit 1
else
    echo ""
    echo "PASS: Red-proof gate works correctly."
    echo "  Tests correctly FAIL when isDurabilityError is broken."
    echo "  The suite is red-proof — it catches production code breakage."
    cp /tmp/de-backup.ts "$PROD"
    exit 0
fi
