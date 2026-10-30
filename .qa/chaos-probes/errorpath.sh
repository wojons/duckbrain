#!/usr/bin/env bash
# .qa/chaos-probes/errorpath.sh — project-owned missing-config errorpath probe.
#
# This probe deliberately supplies an isolated, missing auth configuration and
# starts the real tracked CLI from an empty temporary cwd. The expected product
# result is a clean startup failure naming the missing auth store. Exit status:
#   0   expected product error path observed
#   1   product misbehavior or an unexpected command result
#   2   named pre-product environment gap (runtime/dependencies/tooling)
#
# Bounded: the child is wrapped in timeout so a server that unexpectedly starts
# cannot leave the QA battery waiting indefinitely. No npm/npx package manager
# path is used; invoking the tracked bin directly is part of this probe.
set -euo pipefail

say() { printf '%s\n' "$*"; }
env_gap() { say "ERRORPATH_PROBE=SKIPPED (environment gap): $*"; exit 2; }
product_fail() { say "ERRORPATH_PROBE=FAIL (product misbehavior): $*"; exit 1; }

probe_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" \
  || env_gap "could not resolve probe directory"
repo_root="$(cd -- "$probe_dir/../.." && pwd -P)" \
  || env_gap "could not resolve repository root from probe location"
bin_path="$repo_root/bin/duckbrain.js"

say "probe_started=yes"
say "probe_root=$repo_root"

[ -f "$bin_path" ] || env_gap "tracked CLI is missing: $bin_path"
[ -r "$bin_path" ] || env_gap "tracked CLI is unreadable: $bin_path"
command -v node >/dev/null 2>&1 || env_gap "node is not on PATH"
command -v env >/dev/null 2>&1 || env_gap "env utility is not on PATH"
command -v mktemp >/dev/null 2>&1 || env_gap "mktemp utility is not on PATH"
command -v mkdir >/dev/null 2>&1 || env_gap "mkdir utility is not on PATH"
command -v rm >/dev/null 2>&1 || env_gap "rm utility is not on PATH"
command -v timeout >/dev/null 2>&1 || env_gap "timeout utility is not on PATH"
command -v grep >/dev/null 2>&1 || env_gap "grep utility is not on PATH"

state_dir="$(mktemp -d "${TMPDIR:-/tmp}/duckbrain-errorpath.XXXXXX")" \
  || env_gap "could not create isolated temporary state"
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  rm -rf -- "$state_dir" || true
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Keep cwd empty while every runtime-owned path is below state_dir. The missing
# auth file is intentional: it exercises the product's fail-closed config path,
# rather than a shell/npm preflight error.
empty_cwd="$state_dir/cwd"
mkdir -- "$empty_cwd" "$state_dir/home" "$state_dir/config" \
  "$state_dir/cache" "$state_dir/namespaces" "$state_dir/data"
missing_auth="$state_dir/config/missing-auth.json"
log_path="$state_dir/child.log"
cd -- "$empty_cwd"

set +e
env -i \
  PATH="$PATH" \
  HOME="$state_dir/home" \
  XDG_CONFIG_HOME="$state_dir/home/.config" \
  XDG_CACHE_HOME="$state_dir/cache" \
  DUCKBRAIN_CONFIG_PATH="$state_dir/config/missing-duckbrain.config.json" \
  DUCKBRAIN_NAMESPACES_PATH="$state_dir/namespaces" \
  DUCKBRAIN_DATA_DIR="$state_dir/data" \
  DUCKBRAIN_AUTH_FILE="$missing_auth" \
  DUCKBRAIN_WARM_NAMESPACES=0 \
  timeout --kill-after=5s 20s node "$bin_path" http --port 0 >"$log_path" 2>&1
rc=$?
set -e

# Print the first non-empty product line, while omitting the bin's development
# hint. This keeps the evidence useful both for the expected error and for a
# real startup failure without exposing a full, potentially noisy stack trace.
first_message=""
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "${line//[[:space:]]/}" ] || continue
  case "$line" in
    *"no precompiled build found"*|*"tsx fallback failed"*) continue ;;
  esac
  first_message="$line"
  break
done < "$log_path"
[ -n "$first_message" ] || first_message="<no product output>"
say "rc=$rc"
say "probe_message=$first_message"

# A missing module, npm/npx/tsx failure, or ENOENT is a pre-product gap. It is
# never accepted as proof that DuckBrain handled its missing configuration.
if [ "$rc" = 126 ] || [ "$rc" = 127 ] || grep -Eiq \
  'npm ERR!|npx:|tsx/cjs|node_modules|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find (module|package)|spawn (npm|npx|tsx|node) ENOENT|ENOENT' \
  "$log_path"; then
  env_gap "CLI/tooling could not reach product code (rc=$rc): $first_message"
fi

# Product contract: the explicit missing auth store must fail during startup,
# with a non-zero child status and the actionable DB-GAP-043 message. Any
# successful start, timeout, or different error is a product finding.
if [ "$rc" = 1 ] && grep -Eiq -- '--auth-file not found:|explicit auth store' "$log_path"; then
  say "ERRORPATH_PROBE=OK (expected missing-config startup failure)"
  exit 0
fi

product_fail "expected missing-config failure was not observed (rc=$rc): $first_message"
