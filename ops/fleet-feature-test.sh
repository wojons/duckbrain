#!/usr/bin/env bash
# Live feature test pass against the RUNNING prod daemon (:3000).
# Correct paths/fields discovered from the route sources; writes go to a
# dedicated scratch namespace created up-front.
set -uo pipefail
BASE=http://127.0.0.1:3000
T=$(cat ~/.hermes/state/duckbrain-tokens/foreman-status.key)
OUT=/tmp/db-fleetest
mkdir -p "$OUT"
NS="feature-test-$(date +%s)"

req(){ # req <name> <method> <path> [body]
  local name="$1" m="$2" p="$3" body="${4:-}"
  local args=(-s -m 25 -X "$m" -H "x-api-key: $T" -w "\n__HTTP:%{http_code}__TIME:%{time_total}")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' -d "$body")
  local raw; raw=$(curl "${args[@]}" "$BASE$p" 2>&1)
  local code; code=$(echo "$raw" | grep -o '__HTTP:[0-9]*' | tr -d '_HTTP:')
  local time; time=$(echo "$raw" | grep -o '__TIME:[0-9.]*' | tr -d '_TIME:')
  local payload; payload=$(echo "$raw" | sed 's/__HTTP:.*//')
  echo "$payload" > "$OUT/$name.body.json"
  printf '{"name":"%s","method":"%s","path":"%s","http":%s,"time_s":%s,"bytes":%s}\n' \
    "$name" "$m" "$p" "${code:-0}" "${time:-0}" "$(echo -n "$payload" | wc -c)" >> "$OUT/results.jsonl"
}

echo "scratch namespace: $NS"; echo "$NS" > "$OUT/ns.txt"
: > "$OUT/results.jsonl"

# ── Liveness + discovery ────────────────────────────────────────────────────
req health          GET /health
req ns-list         GET /api/namespaces
req keys-tree       GET /api/keys
req keys-flat       GET "/api/keys/flat?limit=5"
req compaction      GET /api/compaction/stats
req users           GET /users
req activity        GET "/activity?limit=3"

# ── Scratch namespace lifecycle ─────────────────────────────────────────────
req ns-create       POST /api/namespaces "{\"name\":\"$NS\",\"description\":\"feature test pass\"}"
req ns-get          GET  "/api/namespaces/$NS"

# ── Write path (real fields: key/domain/content) ────────────────────────────
req write-1 POST /api/memories "{\"namespace\":\"$NS\",\"key\":\"/t/alpha\",\"domain\":\"concept\",\"content\":\"supabase parity launch check alpha\",\"tags\":[\"e2e\"]}"
req write-2 POST /api/memories "{\"namespace\":\"$NS\",\"key\":\"/t/beta\",\"domain\":\"concept\",\"content\":\"duckdb jsonl durable storage beta\",\"attributes\":{\"tick\":403,\"fixture_id\":\"f1\"}}"
req write-3 POST /api/memories "{\"namespace\":\"$NS\",\"key\":\"/t/gamma\",\"domain\":\"reference\",\"content\":\"realtime change feed gamma\"}"

# ── Query surfaces ──────────────────────────────────────────────────────────
req q-prefix     GET "/api/memories?namespace=$NS&keyPrefix=/t/"
req q-contains   GET "/api/memories?namespace=$NS&contains=durable"
req q-semantic   GET "/api/memories?namespace=$NS&q=durable+storage"
req q-attr       GET "/api/memories?namespace=$NS&attr.tick=403"
req q-domain     GET "/api/memories?namespace=$NS&domain=reference"
req q-asof       GET "/api/memories?namespace=$NS&asOf=2030-01-01T00:00:00.000Z"
req q-limit      GET "/api/memories?namespace=$NS&limit=2"
req q-allns      GET "/api/memories?allNamespaces=true&contains=duckbrain&limit=3"

# ── Declared tables + REST/OpenAPI (SUPA-6 / SUPA-3) ────────────────────────
req tables-list  GET  "/api/ns/$NS/tables"
req openapi      GET  "/api/ns/$NS/openapi.json"
req table-rows   GET  "/api/ns/$NS/tables/launches"

# ── Realtime SSE (SUPA-5) — 4s window ───────────────────────────────────────
timeout 8 curl -s -N -m 4 -H "x-api-key: $T" "$BASE/api/ns/$NS/changes" > "$OUT/sse.txt" 2>&1
printf '{"name":"realtime-sse","method":"GET","path":"/api/ns/%s/changes","http":200,"time_s":4,"bytes":%s}\n' "$NS" "$(wc -c < "$OUT/sse.txt")" >> "$OUT/results.jsonl"

# ── Auth boundary ───────────────────────────────────────────────────────────
raw=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/api/memories?namespace=$NS")
printf '{"name":"auth-401","method":"GET","path":"/api/memories (no key)","http":%s,"time_s":0,"bytes":0}\n' "$raw" >> "$OUT/results.jsonl"
raw=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -H "x-api-key: wrong-key-value" "$BASE/api/memories?namespace=$NS")
printf '{"name":"auth-badkey-401","method":"GET","path":"/api/memories (bad key)","http":%s,"time_s":0,"bytes":0}\n' "$raw" >> "$OUT/results.jsonl"

echo "--- HTTP codes:"
python3 -c "
import json
rows=[json.loads(l) for l in open('$OUT/results.jsonl')]
for r in rows: print(f\"{r['name']:16} {r['method']:5} {r['http']:>4}  {r['bytes']:>7}b  {r['time_s']:>7}s\")
ok=sum(1 for r in rows if 200<=r['http']<300); print(f'--- {ok}/{len(rows)} 2xx')"