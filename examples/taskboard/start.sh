#!/usr/bin/env bash
# One command: a scratch DuckBrain daemon + the task-board UI on top of it.
#
#   examples/taskboard/start.sh            # first run bootstraps everything
#   examples/taskboard/start.sh --reset    # wipe the scratch namespace first
#
# Everything it creates lives under $TASKBOARD_STATE (default:
# ${TMPDIR:-/tmp}/duckbrain-taskboard). Nothing touches the production
# namespace directory, the production daemon on :3000, or ~/.duckbrain.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
STATE="${TASKBOARD_STATE:-${TMPDIR:-/tmp}/duckbrain-taskboard}"
NS="taskboard"
DAEMON_PORT="${DUCKBRAIN_PORT:-28777}"
UI_PORT="${TASKBOARD_PORT:-8787}"
ADMIN_KEY="${DUCKBRAIN_ADMIN_KEY:-tb-admin-demo-key}"
READER_KEY="${DUCKBRAIN_READER_KEY:-tb-reader-demo-key}"

if [[ "${1:-}" == "--reset" ]]; then
  rm -rf "$STATE"
  echo "[taskboard] reset $STATE"
fi

mkdir -p "$STATE/namespaces"

# Scratch credential store: one admin token, one read-only token. The reader
# holds `writer` role so its refusals come from the TABLE grant (reason
# table_grant) rather than from the role, which is the denial the demo shows.
cat > "$STATE/auth.json" <<JSON
{
  "users": [],
  "apiKeys": [
    {
      "key": "$ADMIN_KEY",
      "name": "taskboard-admin",
      "roles": ["admin"],
      "namespaces": ["$NS"]
    },
    {
      "key": "$READER_KEY",
      "name": "taskboard-reader",
      "roles": ["writer"],
      "namespaces": ["$NS"],
      "tableGrants": { "boards": "read", "columns": "read", "cards": "read" }
    }
  ]
}
JSON

export DUCKBRAIN_NAMESPACES_PATH="$STATE/namespaces"

declare_table() {
  node "$REPO/bin/duckbrain.js" tables declare "$@" >/dev/null
}

# Idempotent: --force replaces this table's declaration, other tables in the
# namespace's schema.json are preserved (the CLI merges into the document).
declare_table taskboard boards \
  --column id=varchar --column name=varchar --column created_at=timestamp \
  --primary id --force
declare_table taskboard columns \
  --column id=varchar --column board_id=varchar --column name=varchar \
  --column position=integer --primary id --force
declare_table taskboard cards \
  --column id=varchar --column board_id=varchar --column column_id=varchar \
  --column title=varchar --column assignee=varchar --column position=integer \
  --column created_at=timestamp --primary id --force

echo "[taskboard] tables declared in $STATE/namespaces/$NS/schema.json"

# A namespace's rows reach the change feed when its git commit lands, and the
# default commit debounce is 30s — correct for durability batching, but it makes
# a live demo look broken ("I moved a card and nothing arrived"). The scratch
# daemon therefore batches for 2s. This is the DEMO's config, not a product
# default: production keeps the 30s window.
cat > "$STATE/duckbrain.config.json" <<JSON
{
  "gitBatching": { "maxLines": 100, "maxSeconds": 2, "enabled": true }
}
JSON
export DUCKBRAIN_CONFIG_PATH="$STATE/duckbrain.config.json"

DUCKBRAIN_EMBEDDING_PROVIDER="${DUCKBRAIN_EMBEDDING_PROVIDER:-none}" \
DUCKBRAIN_NAMESPACES_PATH="$STATE/namespaces" \
  node "$REPO/bin/duckbrain.js" http \
    --port "$DAEMON_PORT" --auth=apikey --auth-file="$STATE/auth.json" \
    >"$STATE/daemon.log" 2>&1 &
DAEMON_PID=$!

cleanup() {
  kill "$DAEMON_PID" 2>/dev/null || true
  wait "$DAEMON_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$DAEMON_PORT/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "[taskboard] daemon exited; see $STATE/daemon.log" >&2
    tail -20 "$STATE/daemon.log" >&2
    exit 1
  fi
  sleep 0.5
done

curl -fsS "http://127.0.0.1:$DAEMON_PORT/health" >/dev/null || {
  echo "[taskboard] daemon did not become healthy on :$DAEMON_PORT" >&2
  tail -20 "$STATE/daemon.log" >&2
  exit 1
}

echo "[taskboard] daemon healthy on :$DAEMON_PORT (ns=$NS, state=$STATE)"
echo "[taskboard] open http://127.0.0.1:$UI_PORT"

DUCKBRAIN_URL="http://127.0.0.1:$DAEMON_PORT" \
DUCKBRAIN_NAMESPACE="$NS" \
DUCKBRAIN_ADMIN_KEY="$ADMIN_KEY" \
DUCKBRAIN_READER_KEY="$READER_KEY" \
TASKBOARD_PORT="$UI_PORT" \
  node "$HERE/serve.mjs"
