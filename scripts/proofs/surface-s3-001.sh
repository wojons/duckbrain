#!/usr/bin/env bash
# surface-s3-001.sh — SURFACE-S3-001 proof
#
# The row's claim is that an AGENT, holding only an API key, can answer "is
# this namespace pushed?", push it, run the compaction runbook's ghost cleanup
# and (as an admin) destroy a namespace's remote objects — without a shell on
# the host. An in-process route test cannot prove that (it never boots the
# binary), so this script drives the REAL CLI on a scratch daemon against a
# real (local, stub) S3 endpoint:
#
#   1. FIXED TREE, S3 DISABLED: GET status answers 200 with the local counts and
#      an ABSENT remote count; POST sync is 409 S3_DISABLED.
#   2. FIXED TREE, S3 ENABLED (stub bucket): status before (local-ahead), sync
#      (uploaded=N), status after (data objects match, drift in-sync), second
#      sync (uploaded=0 → idempotent).
#   3. GHOSTS: list names a ghost namespace, and the clear is scoped (a sibling
#      ghost survives) and confirm-gated (no confirm → 400).
#   4. DESTRUCTIVE CLEAR: dry run leaves the bucket alone, then confirm+reason
#      empties exactly that prefix while disk survives.
#   5. AUTHZ: no key 401; a token without the namespace grant 403; an analyst
#      can read status but not sync (403); a writer can sync.
#   6. PRE-FIX CONTROL: the same status request against the commit before this
#      change answers 404 ROUTE_NOT_FOUND. A proof whose control also passes
#      proves nothing.
#
# Ports live in 28700-28999, namespaces under a scratch dir; :3000 and the
# production data directory are never touched.
#
# EXIT: 0 = PASS, 1 = FAIL, 2 = usage/precondition.

set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SCRATCH=${S3PROOF_SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/surface-s3-${STAMP}-XXXXXX")}
BASE_PORT=${S3PROOF_PORT:-28780}
STUB_PORT=${S3PROOF_STUB_PORT:-28790}
NS=${S3PROOF_NS:-proof-ns}
PRE_FIX_REF=${S3PROOF_PRE_FIX_REF:-1c589ef5}
CONTROL_WT="$SCRATCH/pre-fix"

mkdir -p "$SCRATCH"
FAILED=0
STUB_PID=""

say() { printf '%s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; FAILED=1; }

stop_daemon() {
  local port=$1
  local pidfile="$SCRATCH/data-$port/duckbrain-http-$port.pid"
  if [ -f "$pidfile" ]; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    sleep 1
  fi
}

cleanup() {
  stop_daemon "$BASE_PORT"
  stop_daemon "$AUTH_PORT"
  stop_daemon "$CONTROL_PORT"
  if [ -n "$STUB_PID" ]; then kill "$STUB_PID" 2>/dev/null || true; fi
  if [ -d "$CONTROL_WT" ]; then
    git -C "$ROOT" worktree remove --force "$CONTROL_WT" >/dev/null 2>&1 || rm -rf "$CONTROL_WT"
  fi
}
trap cleanup EXIT
AUTH_PORT=$((BASE_PORT + 1))
CONTROL_PORT=$((BASE_PORT + 2))

write_config() { # <port> <s3-json-or-empty>
  local port=$1 s3=${2:-}
  local dir="$SCRATCH/cfg-$port"
  mkdir -p "$dir" "$SCRATCH/namespaces-$port" "$SCRATCH/data-$port"
  if [ -n "$s3" ]; then
    cat >"$dir/duckbrain.config.json" <<JSON
{ "namespacesPath": "$SCRATCH/namespaces-$port", "defaultNamespace": "$NS", "s3": $s3 }
JSON
  else
    cat >"$dir/duckbrain.config.json" <<JSON
{ "namespacesPath": "$SCRATCH/namespaces-$port", "defaultNamespace": "$NS" }
JSON
  fi
  echo "$dir/duckbrain.config.json"
}

start_daemon() { # <checkout-dir> <port> <config-path> <extra-args...>
  local dir=$1 port=$2 cfg=$3
  shift 3
  ( cd "$dir" && \
    DUCKBRAIN_CONFIG_PATH="$cfg" \
    DUCKBRAIN_DATA_DIR="$SCRATCH/data-$port" \
    AWS_ACCESS_KEY_ID="proof-key" \
    AWS_SECRET_ACCESS_KEY="proof-secret" \
    AWS_REGION="us-east-1" \
    node bin/duckbrain.js http --port "$port" "$@" >"$SCRATCH/daemon-$port.log" 2>&1 & )
  for _ in $(seq 1 100); do
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

request() { # <method> <url> <body-or-empty> <api-key-or-empty>  → status on stdout, body in $SCRATCH/body
  local method=$1 url=$2 body=$3 key=${4:-}
  local args=(-s -o "$SCRATCH/body" -w '%{http_code}' -X "$method" "$url")
  [ -n "$key" ] && args+=(-H "x-api-key: $key")
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  curl "${args[@]}"
}

# jf <dotted.path> — read a field out of the last response body in $SCRATCH/body
jf() {
  python3 - "$SCRATCH/body" "$1" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    d = d[int(key)] if isinstance(d, list) else d[key]
print(d)
PY
}

seed_namespace() { # <namespaces-root>
  local root=$1
  mkdir -p "$root/$NS/event/2026-11"
  printf '{"id":"r1"}\n{"id":"r2"}\n' >"$root/$NS/event/2026-11/current.jsonl"
  printf '{"partitions":["event/2026-11"]}\n' >"$root/$NS/manifest.json"
}

seed_ghost() { # <namespaces-root> <name>
  local root=$1 name=$2
  mkdir -p "$root/.s3state"
  printf '{"version":1,"ns":"%s","lastSyncAt":"2026-11-01T00:00:00Z","files":{}}\n' "$name" \
    >"$root/.s3state/$name.json"
}

say "SURFACE-S3-001 proof — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "checkout : $ROOT ($(git -C "$ROOT" rev-parse --short HEAD))"
say "scratch  : $SCRATCH"
say ""

# stub bucket (the daemon talks to it through s3.endpoint, path style)
node "$ROOT/scripts/proofs/surface-s3-001-stub.mjs" "$STUB_PORT" duckbrain >"$SCRATCH/stub.log" 2>&1 &
STUB_PID=$!
for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "http://127.0.0.1:$STUB_PORT/duckbrain?list-type=2"; then break; fi
  sleep 0.25
done
S3_JSON=$(printf '{"enabled":true,"endpoint":"http://127.0.0.1:%s","bucket":"duckbrain","prefix":"proj","forcePathStyle":true,"region":"us-east-1"}' "$STUB_PORT")
say "stub bucket: 127.0.0.1:$STUB_PORT (bucket duckbrain, prefix proj)"

# ---------------------------------------------------------------------------
# 1. S3 disabled: status still answers, sync refuses
# ---------------------------------------------------------------------------
say ""
say "== 1. S3 DISABLED: status answers, sync refuses =="
CFG_OFF=$(write_config "$BASE_PORT")
seed_namespace "$SCRATCH/namespaces-$BASE_PORT"
start_daemon "$ROOT" "$BASE_PORT" "$CFG_OFF" --auth=none || exit 1
BASE="http://127.0.0.1:$BASE_PORT/api/ns/$NS/s3"

status=$(request GET "$BASE" '' '')
body=$(cat "$SCRATCH/body")
say "    GET  /api/ns/$NS/s3 → HTTP $status"
say "    $body"
if [ "$status" = "200" ] && grep -q '"enabled":false' <<<"$body" && grep -q '"remote":null' <<<"$body"; then
  pass "disabled store: status answers local counts with an ABSENT remote count"
else
  fail "disabled store status shape is wrong"
fi

status=$(request POST "$BASE/sync" '{}' '')
say "    POST /api/ns/$NS/s3/sync → HTTP $status $(cat "$SCRATCH/body")"
if [ "$status" = "409" ] && grep -q 'S3_DISABLED' "$SCRATCH/body"; then
  pass "disabled store: sync is 409 S3_DISABLED"
else
  fail "disabled sync did not answer 409 S3_DISABLED"
fi
stop_daemon "$BASE_PORT"

# ---------------------------------------------------------------------------
# 2. S3 enabled: status → sync → status → sync (idempotence)
# ---------------------------------------------------------------------------
say ""
say "== 2. S3 ENABLED: status, sync, status, second sync =="
CFG_ON=$(write_config "$BASE_PORT" "$S3_JSON")
start_daemon "$ROOT" "$BASE_PORT" "$CFG_ON" --auth=none || exit 1

status=$(request GET "$BASE" '' '')
body=$(cat "$SCRATCH/body")
say "    status before → HTTP $status"
say "    $body"
if [ "$status" = "200" ] && grep -q '"state":"local-ahead"' <<<"$body"; then
  pass "status before: drift local-ahead against an empty bucket"
else
  fail "status before did not report local-ahead"
fi

LOCAL_BEFORE=$(jf objects.local)
status=$(request POST "$BASE/sync" '{"direction":"push"}' '')
body=$(cat "$SCRATCH/body")
say "    sync → HTTP $status"
say "    $body"
UPLOADED=$(jf uploaded)
FAILED_OBJ=$(jf failed)
if [ "$status" = "200" ] && [ "$UPLOADED" = "$LOCAL_BEFORE" ] && [ "$FAILED_OBJ" = "0" ]; then
  pass "sync pushed every local object ($UPLOADED of $LOCAL_BEFORE) and answered the CLI's counts"
else
  fail "sync did not answer the expected counts (uploaded=$UPLOADED local=$LOCAL_BEFORE)"
fi
SUMMARY=$(jf summary)
say "    summary line: $SUMMARY"

status=$(request GET "$BASE" '' '')
body=$(cat "$SCRATCH/body")
say "    status after → HTTP $status"
say "    $body"
DATA=$(jf objects.data)
BOOK=$(jf objects.bookkeeping)
STATE=$(jf drift.state)
if [ "$status" = "200" ] && [ "$DATA" = "$UPLOADED" ] && [ "$BOOK" = "1" ] && [ "$STATE" = "in-sync" ]; then
  pass "status after: $DATA data objects remotely (ledger counted separately as bookkeeping), drift in-sync"
else
  fail "status after did not report in-sync (data=$DATA bookkeeping=$BOOK state=$STATE)"
fi
if grep -q '"lastPushAt":"2' <<<"$body"; then
  pass "status after carries the last push time"
else
  fail "status after has no lastPushAt"
fi

status=$(request POST "$BASE/sync" '{"direction":"push"}' '')
body=$(cat "$SCRATCH/body")
say "    second sync → HTTP $status $(cat "$SCRATCH/body")"
if [ "$status" = "200" ] && grep -q '"uploaded":0' <<<"$body"; then
  pass "second sync uploaded 0 objects (idempotent)"
else
  fail "second sync was not idempotent"
fi

# ---------------------------------------------------------------------------
# 3. ghosts: list + scoped, confirm-gated clear
# ---------------------------------------------------------------------------
say ""
say "== 3. GHOST SYNC STATE: list, scoped clear =="
seed_ghost "$SCRATCH/namespaces-$BASE_PORT" "dead-x"
seed_ghost "$SCRATCH/namespaces-$BASE_PORT" "dead-y"
status=$(request GET "http://127.0.0.1:$BASE_PORT/api/ns/dead-x/s3/ghosts" '' '')
body=$(cat "$SCRATCH/body")
say "    GET ghosts dead-x → HTTP $status"
say "    $body"
if [ "$status" = "200" ] && grep -q '"isGhost":true' <<<"$body" && grep -q '"total":2' <<<"$body"; then
  pass "ghost listing names the namespace and reports the whole plan"
else
  fail "ghost listing shape is wrong"
fi

status=$(request POST "http://127.0.0.1:$BASE_PORT/api/ns/dead-x/s3/ghosts/clear" '{}' '')
say "    clear without confirm → HTTP $status $(cat "$SCRATCH/body")"
if [ "$status" = "400" ] && grep -q 'CONFIRMATION_REQUIRED' "$SCRATCH/body"; then
  pass "ghost clear refuses without confirm"
else
  fail "ghost clear was not confirm-gated"
fi

status=$(request POST "http://127.0.0.1:$BASE_PORT/api/ns/dead-x/s3/ghosts/clear" '{"confirm":true,"reason":"compaction runbook"}' '')
say "    clear dead-x confirmed → HTTP $status $(cat "$SCRATCH/body")"
if [ "$status" = "200" ] && [ ! -f "$SCRATCH/namespaces-$BASE_PORT/.s3state/dead-x.json" ] \
   && [ -f "$SCRATCH/namespaces-$BASE_PORT/.s3state/dead-y.json" ]; then
  pass "ghost clear pruned dead-x and left the sibling dead-y alone"
else
  fail "ghost clear scope is wrong"
fi

# ---------------------------------------------------------------------------
# 4. destructive clear: dry run, then confirm + reason
# ---------------------------------------------------------------------------
say ""
say "== 4. DESTRUCTIVE CLEAR: dry run, then confirmed =="
status=$(request POST "$BASE/clear" '{}' '')
body=$(cat "$SCRATCH/body")
say "    clear (default) → HTTP $status $(cat "$SCRATCH/body")"
REMOTE_BEFORE=$(curl -s "http://127.0.0.1:$STUB_PORT/duckbrain?list-type=2&prefix=proj/$NS/" | grep -o '<Key>' | wc -l | tr -d ' ')
PLANNED=$(jf plan.objectCount)
if [ "$status" = "200" ] && grep -q '"dryRun":true' <<<"$body"; then
  REMOTE_AFTER=$(curl -s "http://127.0.0.1:$STUB_PORT/duckbrain?list-type=2&prefix=proj/$NS/" | grep -o '<Key>' | wc -l | tr -d ' ')
  if [ "$REMOTE_AFTER" = "$REMOTE_BEFORE" ] && [ "$PLANNED" = "$REMOTE_BEFORE" ]; then
    pass "clear defaults to a dry run: it announced exactly the $REMOTE_BEFORE remote objects and deleted none"
  else
    fail "dry run changed the bucket (before=$REMOTE_BEFORE after=$REMOTE_AFTER planned=$PLANNED)"
  fi
else
  fail "clear did not default to a dry run"
fi

status=$(request POST "$BASE/clear" '{"dryRun":false,"confirm":true}' '')
if [ "$status" = "400" ] && grep -q 'reason is required' "$SCRATCH/body"; then
  pass "confirmed clear still demands a reason"
else
  fail "clear did not demand a reason"
fi

status=$(request POST "$BASE/clear" '{"dryRun":false,"confirm":true,"reason":"proof teardown"}' '')
body=$(cat "$SCRATCH/body")
say "    clear confirmed → HTTP $status"
say "    $body"
REMOTE_AFTER=$(curl -s "http://127.0.0.1:$STUB_PORT/duckbrain?list-type=2&prefix=proj/$NS/" | grep -o '<Key>' | wc -l | tr -d ' ')
if [ "$status" = "200" ] && [ "$REMOTE_AFTER" = "0" ] && [ -f "$SCRATCH/namespaces-$BASE_PORT/$NS/manifest.json" ]; then
  pass "confirmed clear emptied the remote prefix and left disk untouched"
else
  fail "confirmed clear did not behave (remote=$REMOTE_AFTER)"
fi
stop_daemon "$BASE_PORT"

# ---------------------------------------------------------------------------
# 5. authz on a token daemon
# ---------------------------------------------------------------------------
say ""
say "== 5. AUTHZ: 401 / 403 grant / 403 role / 200 writer =="
mkdir -p "$SCRATCH/auth"
cat >"$SCRATCH/auth/auth.json" <<JSON
{
  "apiKeys": [
    { "key": "proof-writer", "name": "proof-writer", "namespaces": ["$NS"], "roles": ["writer"] },
    { "key": "proof-analyst", "name": "proof-analyst", "namespaces": ["$NS"], "roles": ["analyst"] },
    { "key": "proof-outsider", "name": "proof-outsider", "namespaces": ["other-ns"], "roles": ["writer"] }
  ]
}
JSON
CFG_AUTH=$(write_config "$AUTH_PORT" "$S3_JSON")
seed_namespace "$SCRATCH/namespaces-$AUTH_PORT"
start_daemon "$ROOT" "$AUTH_PORT" "$CFG_AUTH" --auth=apikey --auth-file="$SCRATCH/auth/auth.json" || exit 1
ABASE="http://127.0.0.1:$AUTH_PORT/api/ns/$NS/s3"

status=$(request GET "$ABASE" '' '')
say "    no key → HTTP $status $(cat "$SCRATCH/body")"
[ "$status" = "401" ] && pass "unauthenticated status refused (401)" || fail "unauthenticated status not refused"

status=$(request GET "$ABASE" '' 'proof-outsider')
say "    token without the namespace grant → HTTP $status $(cat "$SCRATCH/body")"
if [ "$status" = "403" ] && grep -q "no grant for namespace" "$SCRATCH/body"; then
  pass "namespace grant is the outer scope (403 names the namespace)"
else
  fail "namespace grant not enforced"
fi

status=$(request POST "$ABASE/sync" '{}' 'proof-analyst')
say "    analyst sync → HTTP $status $(cat "$SCRATCH/body")"
if [ "$status" = "403" ] && grep -q 'FORBIDDEN' "$SCRATCH/body"; then
  pass "analyst may read status but cannot trigger a sync (403)"
else
  fail "analyst was able to sync"
fi

status=$(request GET "$ABASE" '' 'proof-analyst')
[ "$status" = "200" ] && pass "analyst status read allowed (200)" || fail "analyst status read refused"

status=$(request POST "$ABASE/sync" '{}' 'proof-writer')
say "    writer sync → HTTP $status $(cat "$SCRATCH/body")"
W_UPLOADED=$(jf uploaded)
if [ "$status" = "200" ] && [ "$W_UPLOADED" -ge 1 ]; then
  pass "writer scoped to the namespace can sync it (uploaded=$W_UPLOADED)"
else
  fail "writer could not sync"
fi
stop_daemon "$AUTH_PORT"

# ---------------------------------------------------------------------------
# 6. pre-fix control
# ---------------------------------------------------------------------------
say ""
say "== 6. PRE-FIX CONTROL: same request against $PRE_FIX_REF =="
if ! git -C "$ROOT" worktree add --detach "$CONTROL_WT" "$PRE_FIX_REF" >/dev/null 2>&1; then
  fail "could not create the pre-fix worktree for $PRE_FIX_REF"
else
  say "    pre-fix tree: $(git -C "$CONTROL_WT" rev-parse --short HEAD)"
  if ! ( cd "$CONTROL_WT" && pnpm install --frozen-lockfile >/dev/null 2>&1 && pnpm build:cli >/dev/null 2>&1 ); then
    fail "could not prepare the pre-fix worktree"
  else
    CFG_PRE=$(write_config "$CONTROL_PORT")
    seed_namespace "$SCRATCH/namespaces-$CONTROL_PORT"
    if start_daemon "$CONTROL_WT" "$CONTROL_PORT" "$CFG_PRE" --auth=none; then
      status=$(request GET "http://127.0.0.1:$CONTROL_PORT/api/ns/$NS/s3" '' '')
      say "    GET status on the pre-fix daemon → HTTP $status $(cat "$SCRATCH/body")"
      if [ "$status" = "404" ] && grep -q 'ROUTE_NOT_FOUND' "$SCRATCH/body"; then
        pass "control: the route does not exist before this change (404 ROUTE_NOT_FOUND)"
      else
        fail "control did not 404 — the s3 route predates this change?"
      fi
      stop_daemon "$CONTROL_PORT"
    fi
  fi
fi

say ""
if [ "$FAILED" -eq 0 ]; then
  say "RESULT: PASS — the s3 verbs are reachable over HTTP end to end on a real daemon, the counts are the engine's own, the destructive verbs are gated and scoped, and the control 404s."
  exit 0
fi
say "RESULT: FAIL — see the FAIL lines above."
exit 1
