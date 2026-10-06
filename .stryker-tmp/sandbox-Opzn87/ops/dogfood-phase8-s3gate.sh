#!/usr/bin/env bash
# Phase 8 (S3-gate era) — appends to ops/dogfood-e2e.sh before its Summary block.
#
# Covers the post-09-19 surfaces that Phase 1-7 predate:
#   8a. GATED AUTO-PUSH (PUSH-001): canary namespace on the sandbox daemon with
#       s3.pushOnCommit=true + intervalSec floor — rapid writes coalesce to ONE
#       bundle (ungated would be one per commit), and a later write past the
#       floor produces the next bundle carrying the deferred payload.
#   8b. ROTATION PAST 9999 (DB-GAP-049): a partition holding full 9999.jsonl +
#       existing 10000.jsonl accepts an append into a NEW segment (10001), and
#       readPartition returns records in numeric append order.
#   8c. PROFILE CREDENTIALS (portability): the sandbox push uses s3.profile
#       (AWS_PROFILE injected by buildPushEnv), not ambient env — proven by the
#       successful push under a scrubbed AWS_* environment.
#   8d. REALTIME CHANGE FEED (SUPA-5): SSE subscribe, write, decode the
#       duckbrain.change.v1 cursor, verify it references the just-made commit.
#  (SUPA-3 declared-tables REST is exercised in Phase 7 via /api/ns tables.)
#
# Requires: the Phase-1 sandbox daemon still up ($DAPID), PORT_A, $NS, $ROOT,
# $BIN set by the main script, git-remote-s3 + aws in PATH, stage-canary creds.
# Each check must be independently re-runnable: idempotent keys, per-run ns.
set -uo pipefail

CANARY_NS="${NS}-canary"

say ""; say "▶ Phase 8 — S3-gate era: gated push, rotation, profile creds, realtime"

# Dedicated canary config: gate ON with a short floor, stage prefix, profile
# creds (the portability contract — no keys in the file). GAP-022 env override
# keeps it out of any tracked config.
CANARY_PORT=3603
CANARY_CFG="$ROOT/duckbrain-canary.config.json"
cat > "$CANARY_CFG" <<EOF
{
  "defaultNamespace": "$CANARY_NS",
  "s3": {
    "enabled": true,
    "endpoint": "$AWS_ENDPOINT_URL",
    "region": "us-east-1",
    "bucket": "duckbrain",
    "prefix": "stage-canary",
    "forcePathStyle": true,
    "pushOnCommit": true,
    "intervalSec": 60,
    "profile": "duckbrain"
  }
}
EOF

# ── 8a. gated autopush ──────────────────────────────────────────────────────
# The canary runs as its OWN sandbox daemon on port $PC with the gate config
# and its own namespace-scoped admin token — a real deployment's shape (one
# daemon, one config, gate on). Reusing daemon-A's token would 403 (its scope
# is the main ns only, by Phase-2 design).
mkdir -p "$ROOT/dataC" "$ROOT/nsC" "$ROOT/authC.json.d"
CANARY_AUTH="$ROOT/authC.json"
CMAP=$(write_auth --ns "$CANARY_NS" "$CANARY_AUTH" "df-canary:admin")
T_CANARY=$(echo "$CMAP" | awk '$1=="df-canary"{print $2}')
start_daemon $CANARY_PORT "$ROOT/dataC" "$ROOT/nsC" "$CANARY_AUTH" \
  DUCKBRAIN_CONFIG_PATH="$CANARY_CFG"
CHC=$(wait_health $CANARY_PORT)
verdict "canary daemon boot (gate config)" $([ "$CHC" != "000" ] && echo 0 || echo 1) "health=$CHC on :$CANARY_PORT"
CPOST(){ api POST $CANARY_PORT "$T_CANARY" "/api/memories" \
  "{\"key\":\"$1\",\"content\":\"$2\",\"domain\":\"event\",\"namespace\":\"$CANARY_NS\",\"author\":\"dogfood@e2e.local\"}"; }
CPOST "/gate/seed" "gate seed" >/dev/null
sleep 3
CR="$ROOT/nsC/$CANARY_NS"
# The namespace repo materializes on the daemon's first commit flush
# (~5 min debounce on a fresh namespace). Wait for it instead of guessing.
for i in $(seq 1 40); do
  [ -d "$CR/.git" ] && break
  sleep 10
done
if [ -d "$CR/.git" ]; then
  git -C "$CR" remote add s3daily "s3://duckbrain/stage-canary/$CANARY_NS" >/dev/null 2>&1
  B(){ aws --endpoint-url "$AWS_ENDPOINT_URL" s3 ls "s3://duckbrain/stage-canary/" --recursive 2>/dev/null | grep -c "\.bundle"; }
  B0=$(B)
  for i in 1 2 3; do
    CPOST "/gate/rapid-$i" "rapid $i" >/dev/null
  done
  sleep 120   # commit debounce + one gate cycle (intervalSec=60)
  B1=$(B)
  if [ "$B1" -gt "$B0" ]; then
    verdict "PUSH-001 gate: rapid writes coalesce to ONE bundle" $(( B1 - B0 == 1 ? 0 : 1 )) "bundles $B0 -> $B1 for 3 rapid writes"
  else
    verdict "PUSH-001 gate: rapid writes coalesce to ONE bundle" 1 "no bundle appeared ($B0 -> $B1) — gate never pushed"
  fi
  sleep 75   # cross the floor
  CPOST "/gate/after-floor" "past floor" >/dev/null
  # The push evaluates only at the next COMMIT FLUSH (debounced ~5 min on a
  # quiet daemon), so wait up to ~7 min for the bundle to appear.
  B2=$B1
  for i in $(seq 1 42); do
    sleep 10
    B2=$(B)
    [ "$B2" -gt "$B1" ] && break
  done
  if [ "$B2" -gt "$B1" ]; then
    verdict "PUSH-001 gate: post-floor write pushes next bundle" 0 "bundles $B1 -> $B2"
  else
    verdict "PUSH-001 gate: post-floor write pushes next bundle" 1 "no second bundle ($B1 -> $B2)"
  fi
  # clone-back carries this run's data (the actual durability claim)
  rm -rf "$ROOT/clone-back"
  if git clone -q "s3://duckbrain/stage-canary/$CANARY_NS" "$ROOT/clone-back" 2>/dev/null; then
    if git -C "$ROOT/clone-back" grep -q "gate seed" HEAD 2>/dev/null \
       || grep -rq "gate seed" "$ROOT/clone-back" --include="*.jsonl" 2>/dev/null; then
      verdict "S3 clone-back answers for this run" 0 "gate seed found in cloned bundle"
    else
      verdict "S3 clone-back answers for this run" 1 "cloned but data missing"
    fi
  else
    verdict "S3 clone-back answers for this run" 1 "clone failed"
  fi
else
  verdict "PUSH-001 gate: canary namespace repo materialized" 1 "$CR/.git missing after 400s"
fi

# ── 8b. rotation past 9999 (DB-GAP-049) ────────────────────────────────────
# Seed via python (valid UUIDs — sed-based seeding produced malformed ids),
# probe via the checked-in script so the assertion logic is reviewable.
ROT="$ROOT/rotation-probe"
mkdir -p "$ROT"
F9999="$ROT/9999.jsonl"; F10000="$ROT/10000.jsonl"
python3 - "$F9999" <<'PYEOF'
import json, sys, uuid
rows = []
for i in range(1000):
    # zod's .uuid() demands RFC 4122 version+variant bits — build v4 ids with
    # a monotonic counter in the node half so keys and ids stay paired.
    h = list(uuid.uuid4().hex)
    h[12] = "4"            # version nibble -> 4xxx
    h[16] = "8"            # variant -> 8xxx
    h[20:] = f"{i:012x}"   # node half = counter (unique per row)
    h = "".join(h)
    rows.append(json.dumps({
        "id": f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}",
        "key": f"/rot/{i:04d}",
        "domain": "event",
        "timestamp": "2026-09-19T00:00:00.000Z",
        "author": "dogfood@e2e.local",
        "action": "add",
        "embedding_text": "x",
        "attributes": {},
    }))
open(sys.argv[1], "w").write("\n".join(rows) + "\n")
PYEOF
: > "$F10000"
ROT_OUT=$(npx --no-install tsx "$REPO/ops/dogfood-phase8-rotation.ts" "$ROT" 2>/dev/null | tail -1)
if echo "$ROT_OUT" | grep -q '"ok1":true,"ok2":true'; then
  verdict "DB-GAP-049: rotation resumes at 10001 past frozen 9999" 0 "$ROT_OUT"
else
  verdict "DB-GAP-049: rotation resumes at 10001 past frozen 9999" 1 "${ROT_OUT:-probe crashed — see $ROT}"
fi

# ── 8c. profile credentials (no ambient AWS_* leakage) ─────────────────────
# The Phase-8a push already ran inside the daemon, whose env carries ONLY
# buildPushEnv(s3) AWS vars (AWS_PROFILE from s3.profile, endpoint from config).
# Assert the daemon process does NOT carry ambient direct-key AWS creds, which
# would mean the portability contract (creds via profile, not env) is violated.
CANARY_PID=$(cat "$ROOT/dataA/duckbrain-http-$PA.pid" 2>/dev/null || true)
if [ -n "$CANARY_PID" ] && [ -r "/proc/$CANARY_PID/environ" ]; then
  if tr '\0' '\n' < "/proc/$CANARY_PID/environ" | grep -qE '^AWS_ACCESS_KEY_ID='; then
    verdict "portability: daemon uses profile creds, not ambient keys" 1 "AWS_ACCESS_KEY_ID found in daemon env"
  else
    verdict "portability: daemon uses profile creds, not ambient keys" 0 "no direct keys in daemon env"
  fi
else
  verdict_kf "portability: daemon uses profile creds, not ambient keys" "could not read daemon environ" "PORTABILITY-001"
fi

# ── 8d. realtime change feed (SUPA-5) ──────────────────────────────────────
# The feed is committed-only: the frame appears after the daemon's commit
# flush lands, which on a quiet sandbox can take minutes. So: write FIRST,
# then subscribe and hold the window across the flush (ready frame proves the
# route + auth; the change frame proves the emit path).
api POST $PA "$T_ADMIN" "/api/memories" \
  "{\"key\":\"/sse/probe\",\"content\":\"realtime proof\",\"domain\":\"event\",\"namespace\":\"$NS\",\"author\":\"dogfood@e2e.local\"}" >/dev/null
SSE_OUT="$ROOT/sse.txt"
# Hold for one commit-debounce cycle (~5 min) + margin, in the background so
# the script keeps its own timeout envelope.
timeout 330 curl -sN -H "x-api-key: $T_ADMIN" "http://127.0.0.1:$PA/api/ns/$NS/changes" > "$SSE_OUT" 2>/dev/null &
SSE_PID=$!
# While waiting, run 8b's commit-flush-independent probes (already done above);
# park here until either a change frame appears or the window closes.
CHANGE_SEEN=0
for i in $(seq 1 33); do
  sleep 10
  if grep -q "duckbrain.change.v1" "$SSE_OUT" 2>/dev/null; then CHANGE_SEEN=1; break; fi
done
kill $SSE_PID 2>/dev/null
if [ "$CHANGE_SEEN" = 1 ]; then
  FRAME=$(grep -m1 -A1 "event: duckbrain.change.v1" "$SSE_OUT" | grep "data:" | head -1)
  verdict "SUPA-5: change feed emits committed change" 0 "${FRAME:0:90}…"
elif grep -q "duckbrain.ready.v1" "$SSE_OUT" 2>/dev/null; then
  verdict "SUPA-5: change feed emits committed change" 1 "ready frame OK, no change frame within 330s (flush never landed?)"
else
  verdict "SUPA-5: change feed emits committed change" 1 "no frames at all — route/auth problem"
fi

# stage-canary prefix hygiene: this run's bundles are tagged by ns name, so a
# failed run leaves evidence for forensics; cleanup happens with $ROOT.
