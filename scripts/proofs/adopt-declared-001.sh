#!/usr/bin/env bash
# adopt-declared-001.sh — ADOPT-DECLARED-001 proof
#
# The row's claim is that an AGENT can create the table it wants to write to
# without a shell on the box. An in-process route test cannot prove that (it
# never boots the binary), so this script drives the REAL CLI on a scratch
# daemon and then proves the control:
#
#   1. FIXED TREE (this checkout): boot `node bin/duckbrain.js http` on a
#      scratch port, scratch namespaces root, --auth=none.
#        - POST /api/ns/<ns>/tables/<table>/declare        → 201 schema.json
#        - POST /api/ns/<ns>/tables/<table>  (row)         → 201 inserted:1
#        - GET  /api/ns/<ns>/tables/<table>                → 200, the row
#        - GET  /metrics                                   → adoption gauges
#          move (schema.json 1, legacy 0) — the number the row added.
#   2. AUTHZ on the same binary: restart with --auth=apikey and a two-token
#      auth file. No key → 401; a token whose tableGrants do not name the new
#      table → 403 FORBIDDEN and NOTHING on disk; a token that is granted the
#      table → 201.
#   3. PRE-FIX CONTROL: a detached worktree of the commit BEFORE the route
#      (default: d0264bd4^, override with ADOPT_PRE_FIX_REF) boots the same
#      way, and the same declare request answers 404 ROUTE_NOT_FOUND. A proof
#      whose control also passes proves nothing.
#
# Everything runs on ports in 28700-28999 with namespaces under a scratch dir;
# nothing touches :3000 or the production data directory. Daemons are stopped
# through their own pid files on exit.
#
# EXIT: 0 = PASS, 1 = FAIL, 2 = usage/precondition.

set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SCRATCH=${ADOPT_SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/adopt-declared-${STAMP}-XXXXXX")}
PORT=${ADOPT_PORT:-28771}
NS=${ADOPT_NS:-agent-e2e}
TABLE=${ADOPT_TABLE:-readings}
PRE_FIX_REF=${ADOPT_PRE_FIX_REF:-d0264bd4^}
CONTROL_WT="$SCRATCH/pre-fix"

mkdir -p "$SCRATCH"
FAILED=0

say() { printf '%s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; FAILED=1; }

stop_port() {
  local port=$1
  local pidfile="$SCRATCH/data-$port/duckbrain-http-$port.pid"
  if [ -f "$pidfile" ]; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    sleep 1
  fi
}

cleanup() {
  stop_port "$PORT"
  stop_port "$((PORT + 2))"
  if [ -d "$CONTROL_WT" ]; then
    git -C "$ROOT" worktree remove --force "$CONTROL_WT" >/dev/null 2>&1 || rm -rf "$CONTROL_WT"
  fi
}
trap cleanup EXIT

start_daemon() { # <checkout-dir> <port> <extra-args...>
  local dir=$1 port=$2
  shift 2
  mkdir -p "$SCRATCH/namespaces-$port" "$SCRATCH/data-$port"
  ( cd "$dir" && \
    DUCKBRAIN_NAMESPACES_PATH="$SCRATCH/namespaces-$port" \
    DUCKBRAIN_DATA_DIR="$SCRATCH/data-$port" \
    node bin/duckbrain.js http --port "$port" "$@" >"$SCRATCH/daemon-$port.log" 2>&1 & )
  for _ in $(seq 1 80); do
    if curl -sf -o /dev/null "http://127.0.0.1:$port/health"; then
      say "    daemon up: $dir on :$port (log $SCRATCH/daemon-$port.log)"
      return 0
    fi
    sleep 0.5
  done
  tail -20 "$SCRATCH/daemon-$port.log" >&2
  fail "daemon on :$port never became healthy"
  return 1
}

request() { # <method> <url> <body-or-empty> <api-key-or-empty> → "<status>\n<body>" in $SCRATCH/body, status echoed
  local method=$1 url=$2 body=$3 key=${4:-}
  local args=(-s -o "$SCRATCH/body" -w '%{http_code}' -X "$method" "$url")
  [ -n "$key" ] && args+=(-H "x-api-key: $key")
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  curl "${args[@]}"
}

say "ADOPT-DECLARED-001 proof — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "checkout : $ROOT ($(git -C "$ROOT" rev-parse --short HEAD))"
say "scratch  : $SCRATCH"
say ""

# ---------------------------------------------------------------------------
# 1. fixed tree: declare → insert → read
# ---------------------------------------------------------------------------
say "== 1. FIXED TREE: declare, insert, read =="
start_daemon "$ROOT" "$PORT" --auth=none || exit 1
BASE="http://127.0.0.1:$PORT/api/ns/$NS/tables"

status=$(request POST "$BASE/$TABLE/declare" \
  '{"columns":[{"name":"id","type":"integer"},{"name":"device","type":"varchar"},{"name":"temp","type":"double"}],"primary":"id"}')
body=$(cat "$SCRATCH/body")
say "    POST /api/ns/$NS/tables/$TABLE/declare → HTTP $status"
say "    $body"
if [ "$status" = "201" ] && grep -q '"format":"schema.json"' <<<"$body"; then
  pass "declare answered 201 and wrote schema.json"
else
  fail "declare did not answer 201 schema.json"
fi

status=$(request POST "$BASE/$TABLE" '{"id":1,"device":"probe-a","temp":21.5}')
say "    POST /api/ns/$NS/tables/$TABLE → HTTP $status $(cat "$SCRATCH/body")"
[ "$status" = "201" ] && pass "row insert accepted" || fail "row insert not 201"

status=$(request GET "$BASE/$TABLE" '')
rows=$(cat "$SCRATCH/body")
say "    GET  /api/ns/$NS/tables/$TABLE → HTTP $status $rows"
if [ "$status" = "200" ] && grep -q '"device":"probe-a"' <<<"$rows"; then
  pass "the row declared over HTTP is readable over the REST data verbs"
else
  fail "declared row not readable"
fi

metrics=$(curl -s "http://127.0.0.1:$PORT/metrics" | grep '^duckbrain_table_declaration')
say "    GET  /metrics →"
sed 's/^/      /' <<<"$metrics"
if grep -q 'duckbrain_table_declaration_namespaces{format="schema.json"} 1' <<<"$metrics" \
   && grep -q 'duckbrain_table_declaration_namespaces{format="legacy"} 0' <<<"$metrics"; then
  pass "adoption gauge moved with the HTTP declaration (schema.json 1 / legacy 0)"
else
  fail "adoption gauge did not move as expected"
fi
stop_port "$PORT"

# ---------------------------------------------------------------------------
# 2. authz on the same binary
# ---------------------------------------------------------------------------
say ""
say "== 2. AUTHZ: no key 401, ungranted table 403, granted table 201 =="
AUTH_PORT=$((PORT + 1))
mkdir -p "$SCRATCH/auth"
cat >"$SCRATCH/auth/auth.json" <<JSON
{
  "apiKeys": [
    { "key": "proof-writer", "name": "proof-writer", "namespaces": ["$NS"], "roles": ["writer"], "tableGrants": { "draft": "rw" } },
    { "key": "proof-other", "name": "proof-other", "namespaces": ["$NS"], "roles": ["writer"], "tableGrants": { "other_table": "rw" } }
  ]
}
JSON
start_daemon "$ROOT" "$AUTH_PORT" --auth=apikey --auth-file="$SCRATCH/auth/auth.json" || exit 1
ABASE="http://127.0.0.1:$AUTH_PORT/api/ns/$NS/tables"

status=$(request POST "$ABASE/draft/declare" '{"columns":[{"name":"id","type":"integer"}]}')
say "    no api key, declare draft → HTTP $status $(cat "$SCRATCH/body")"
[ "$status" = "401" ] && pass "unauthenticated declare refused (401)" || fail "unauthenticated declare not refused"

status=$(request POST "$ABASE/sneaky/declare" '{"columns":[{"name":"id","type":"integer"}]}' proof-writer)
say "    proof-writer (tableGrants: draft) declares sneaky → HTTP $status $(cat "$SCRATCH/body")"
if [ "$status" = "403" ] && grep -q "no write grant for table 'sneaky'" "$SCRATCH/body"; then
  pass "per-table write grant enforced on declaration (403, names the table)"
else
  fail "per-table write grant not enforced on declaration"
fi

status=$(request POST "$ABASE/draft/declare" '{"columns":[{"name":"id","type":"integer"},{"name":"note","type":"varchar"}]}' proof-writer)
say "    proof-writer declares draft (granted) → HTTP $status $(cat "$SCRATCH/body")"
[ "$status" = "201" ] && pass "granted token can declare its table" || fail "granted token could not declare"

if grep -q '"sneaky"' "$SCRATCH/namespaces-$AUTH_PORT/$NS/schema.json" 2>/dev/null; then
  fail "the refused declaration reached disk"
else
  pass "the refused declaration left nothing on disk"
fi
stop_port "$AUTH_PORT"

# ---------------------------------------------------------------------------
# 3. pre-fix control
# ---------------------------------------------------------------------------
say ""
say "== 3. PRE-FIX CONTROL: same request against $PRE_FIX_REF =="
CONTROL_PORT=$((PORT + 2))
if ! git -C "$ROOT" worktree add --detach "$CONTROL_WT" "$PRE_FIX_REF" >/dev/null 2>&1; then
  fail "could not create the pre-fix worktree for $PRE_FIX_REF"
else
  say "    pre-fix tree: $(git -C "$CONTROL_WT" rev-parse --short HEAD)"
  if ! ( cd "$CONTROL_WT" && pnpm install --frozen-lockfile >/dev/null 2>&1 ); then
    fail "pnpm install failed in the pre-fix worktree"
  fi
  if start_daemon "$CONTROL_WT" "$CONTROL_PORT" --auth=none; then
    status=$(request POST "http://127.0.0.1:$CONTROL_PORT/api/ns/$NS/tables/$TABLE/declare" \
      '{"columns":[{"name":"id","type":"integer"}]}')
    say "    POST declare on the pre-fix daemon → HTTP $status $(cat "$SCRATCH/body")"
    if [ "$status" = "404" ] && grep -q 'ROUTE_NOT_FOUND' "$SCRATCH/body"; then
      pass "control: the route does not exist before this change (404 ROUTE_NOT_FOUND)"
    else
      fail "control did not 404 — the declare route predates this change?"
    fi
    stop_port "$CONTROL_PORT"
  fi
fi

say ""
if [ "$FAILED" -eq 0 ]; then
  say "RESULT: PASS — declare-over-HTTP works end to end on a real daemon, is grant-gated, and the control 404s."
  exit 0
fi
say "RESULT: FAIL — see the FAIL lines above."
exit 1
