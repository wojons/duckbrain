#!/usr/bin/env bash
# check-lockfile-lockstep.sh — HARDEN-DUCKBRAIN-004.
#
# DuckBrain ships two lockfiles because it has two install paths:
#   pnpm-lock.yaml     CI install + local dev  (pnpm install --frozen-lockfile)
#   package-lock.json  Docker build + npm users (npm ci, Dockerfile:8)
# Adding prom-client in OBSDB-001 refreshed only pnpm-lock.yaml, so the
# paired vitest test and then CI went red; the repair was a second commit.
# The npm arm was already gated in CI (SUP-CI-20261020-DB) but nothing
# checked the pnpm arm, and nothing checked either before a commit.
#
# This wrapper runs BOTH arms and is the single command a contributor can
# run in under a second, offline:
#   arm 1/2  scripts/ci/check-lockfile-sync.sh       (package.json ~ package-lock.json)
#   arm 2/2  scripts/ci/check-lockfile-lockstep.mjs  (package.json ~ pnpm-lock.yaml)
# It never installs, resolves, or reaches the network: both arms are
# offline comparisons, so a drift is named in milliseconds instead of
# failing four minutes into the suite.
#
# Usage:
#   bash scripts/ci/check-lockfile-lockstep.sh            both arms, always
#   bash scripts/ci/check-lockfile-lockstep.sh --staged   pre-commit: only when
#                                                         a package.json or a
#                                                         lockfile is staged
#   bash scripts/ci/check-lockfile-lockstep.sh --self-test  both arms' fixture proofs
# Exit: 0 in lockstep (or skipped) | 1 drift | 2 unreadable input.
#
# Seams (env, used by the paired vitest test — real files are never mutated):
#   LOCKFILE_SYNC_MANIFEST / LOCKFILE_SYNC_LOCKFILE  forwarded to arm 1
#   LOCKSTEP_ROOT                                    root for arm 2 (default: repo root)
#   LOCKSTEP_STAGED_FILES                            overrides `git diff --cached`
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

MODE="run"
for arg in "$@"; do
  case "$arg" in
    --staged) MODE="staged" ;;
    --self-test) MODE="self-test" ;;
    -h|--help)
      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "LOCKSTEP: unknown argument \"$arg\"" >&2
      exit 2
      ;;
  esac
done

if [ "$MODE" = "staged" ]; then
  if [ -n "${LOCKSTEP_STAGED_FILES:-}" ]; then
    staged_files="$LOCKSTEP_STAGED_FILES"
  elif command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    staged_files="$(git -C "$ROOT" diff --cached --name-only 2>/dev/null)"
  else
    staged_files=""
  fi
  if ! printf '%s\n' "$staged_files" | grep -Eq '(^|/)(package\.json|pnpm-lock\.yaml|package-lock\.json)$'; then
    echo "LOCKSTEP: skipped (no package manifest or lockfile staged)"
    exit 0
  fi
fi

status=0

echo "== lockstep arm 1/2: package.json vs package-lock.json (Dockerfile / npm ci) =="
if [ "$MODE" = "self-test" ]; then
  bash "$SCRIPT_DIR/check-lockfile-sync.sh" --self-test || status=1
else
  bash "$SCRIPT_DIR/check-lockfile-sync.sh" || status=$?
fi

echo "== lockstep arm 2/2: package.json vs pnpm-lock.yaml (CI install / pnpm) =="
pnm_args=()
if [ -n "${LOCKSTEP_ROOT:-}" ]; then
  pnm_args+=(--root "$LOCKSTEP_ROOT")
fi
if [ "$MODE" = "self-test" ]; then
  pnm_args+=(--self-test)
fi
node "$SCRIPT_DIR/check-lockfile-lockstep.mjs" "${pnm_args[@]}" || {
  rc=$?
  if [ "$status" -eq 0 ]; then status=$rc; fi
}

if [ "$status" -eq 0 ]; then
  echo "LOCKSTEP: OK — both lockfiles agree with package.json"
else
  echo "LOCKSTEP: FAILED ($status) — one or both lockfiles are out of date; fix with:" >&2
  echo "LOCKSTEP:   pnpm install --lockfile-only && npm install --package-lock-only --ignore-scripts" >&2
fi
exit "$status"
