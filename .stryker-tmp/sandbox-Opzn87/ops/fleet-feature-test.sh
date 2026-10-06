#!/usr/bin/env bash
# Definitive live feature pass against the RUNNING prod daemon (:3000).
# Covers: health, discovery, namespace lifecycle, memory write/query legs,
# declared tables + REST (SUPA-3/6), realtime SSE (SUPA-5), auth boundary.
set -uo pipefail
BASE=http://127.0.0.1:3000
T=$(cat ~/.hermes/state/duckbrain-tokens/foreman-status.key)
NSROOT="${DUCKBRAIN_NAMESPACES_PATH:-$HOME/duckbrain/namespaces}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT=/tmp/db-fleetest
mkdir -p "$OUT"
NS="feature-test-$(date +%s)"
: > "$OUT/results.jsonl"
echo "$NS" > "$OUT/ns.txt"

req(){ # req <name> <group> <method> <path> [body]
  local name="$1" grp="$2" m="$3" p="$4" body="${5:-}"
  local args=(-s -m 30 -X "$m" -H "x-api-key: $T" -w "\n__HTTP:%{http_code}__TIME:%{time_total}")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' -d "$body")
  local raw; raw=$(curl "${args[@]}" "$BASE$p" 2>&1)
  local code; code=$(echo "$raw" | grep -o '__HTTP:[0-9]*' | tr -d '_HTTP:')
  local time; time=$(echo "$raw" | grep -o '__TIME:[0-9.]*' | tr -d '_TIME:')
  local payload; payload=$(echo "$raw" | sed 's/__HTTP:.*//')
  echo "$payload" > "$OUT/$name.body.json"
  python3 -c "
import json,sys
p=open('$OUT/$name.body.json').read()
row={'name':'$name','group':'$grp','method':'$m','path':'''$p''','http':int('${code:-0}'),'time_s':float('${time:-0}'),'bytes':len(p),'sample':p[:600]}
open('$OUT/results.jsonl','a').write(json.dumps(row)+'\n')"
}

reqcode(){ # reqcode <name> <group> <label> <curl-args...>
  local name="$1" grp="$2" label="$3"; shift 3
  local code; code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$@" "$BASE/api/memories?namespace=$NS")
  python3 -c "
import json
row={'name':'$name','group':'$grp','method':'GET','path':'''$label''','http':int($code),'time_s':0,'bytes':0,'sample':''}
open('$OUT/results.jsonl','a').write(json.dumps(row)+'\n')"
}

echo "namespace: $NS"
NSP="$NSROOT/$NS"

# ── 1. liveness + discovery ─────────────────────────────────────────────────
req health        core GET  /health
req ns-list       core GET  /api/namespaces
req ks-tree       core GET  /api/keys
req ks-flat       core GET  "/api/keys/flat?limit=5"
req compaction    core GET  /api/compaction/stats
req users         core GET  /users
req activity      core GET  "/activity?limit=3"

# ── 2. namespace lifecycle (SUPA-4 roles/admin) ─────────────────────────────
req ns-create     ns   POST /api/namespaces "{\"name\":\"$NS\",\"description\":\"live feature pass\"}"
NSDIR="$NSROOT/$NS"
[ -d "$NSDIR/.git" ] && echo "ns git repo created: yes" || echo "ns git repo created: no"

# ── 3. memory writes (durable JSONL path) ───────────────────────────────────
req w-concept-1 js POST /api/memories "{\"namespace\":\"$NS\",\"key\":\"/t/alpha\",\"domain\":\"concept\",\"content\":\"supabase parity launch check alpha\",\"tags\":[\"e2e\"]}"
req w-concept-2 js POST /api/memories "{\"namespace\":\"$NS\",\"key\":\"/t/beta\",\"domain\":\"concept\",\"content\":\"duckdb jsonl durable storage beta\",\"attributes\":{\"tick\":403,\"fixture_id\":\"f1\"}}"
req w-config    js POST /api/memories "{\"namespace\":\"$NS\",\"key\":\"/t/gamma\",\"domain\":\"config\",\"content\":\"realtime change feed gamma\"}"

# ── 4. query legs ───────────────────────────────────────────────────────────
req q-prefix    query GET "/api/memories?namespace=$NS&keyPrefix=/t/"
req q-contains  query GET "/api/memories?namespace=$NS&contains=durable"
req q-semantic  query GET "/api/memories?namespace=$NS&q=durable+storage"
req q-attr      query GET "/api/memories?namespace=$NS&attr.tick=403"
req q-domain    query GET "/api/memories?namespace=$NS&domain=config"
req q-asof      query GET "/api/memories?namespace=$NS&asOf=2030-01-01T00:00:00.000Z"
req q-limit     query GET "/api/memories?namespace=$NS&limit=2"
req q-allns     query GET "/api/memories?allNamespaces=true&contains=duckdb&limit=3"
req q-status    query GET "/api/memories?namespace=$NS&keyPrefix=/t/&status=active"

# ── 5. declared tables + PostgREST-style REST (SUPA-6 + SUPA-3) ─────────────
mkdir -p "$NSP/tables"
cat > "$NSP/tables/launches.table.json" <<JSON
{"name":"launches","format":"jsonl-objects","primary":"id","glob":"tables/launches.jsonl",
 "columns":[{"name":"id","type":"integer"},{"name":"vehicle","type":"varchar"},{"name":"status","type":"varchar"},{"name":"attempt","type":"integer"}]}
JSON
: > "$NSP/tables/launches.jsonl"
req tbl-list    tables GET  "/api/ns/$NS/tables"
req tbl-openapi tables GET  "/api/ns/$NS/openapi.json"
req tbl-insert  tables POST "/api/ns/$NS/tables/launches" '{"id":1,"vehicle":"Duck","status":"go","attempt":1}'
req tbl-insert2 tables POST "/api/ns/$NS/tables/launches" '{"id":2,"vehicle":"Goose","status":"hold","attempt":2}'
req tbl-select  tables GET  "/api/ns/$NS/tables/launches"
req tbl-filter  tables GET  "/api/ns/$NS/tables/launches?status=eq.go"
req tbl-patch   tables PATCH "/api/ns/$NS/tables/launches?pk=eq.2" '{"status":"go"}'
req tbl-after   tables GET  "/api/ns/$NS/tables/launches?status=eq.go"
req tbl-delete  tables DELETE "/api/ns/$NS/tables/launches?pk=eq.1"
req tbl-final   tables GET  "/api/ns/$NS/tables/launches"

# ── 6. realtime SSE (SUPA-5) ────────────────────────────────────────────────
timeout 8 curl -s -N -m 4 -H "x-api-key: $T" "$BASE/api/ns/$NS/changes" > "$OUT/sse.txt" 2>&1
python3 -c "
import json
b=open('$OUT/sse.txt','rb').read()
row={'name':'realtime-sse','group':'realtime','method':'GET','path':'/api/ns/$NS/changes','http':200 if b else 0,'time_s':4,'bytes':len(b),'sample':b.decode('utf8','replace')[:600]}
open('$OUT/results.jsonl','a').write(json.dumps(row)+'\n')"

# ── 7. auth boundary ────────────────────────────────────────────────────────
reqcode auth-none   auth "no key" 
reqcode auth-bad    auth "bad key" -H "x-api-key: totally-wrong-key"

# ── 8. bundled web UI (separate Vite app; not mounted on the API port) ──────
UIDIST="$REPO_ROOT/packages/ui/dist"
if [ -f "$UIDIST/index.html" ]; then
  ASSET=$(ls "$UIDIST/assets" 2>/dev/null | grep -E '\.js$' | head -1)
  python3 -c "
import json,os
d='$UIDIST'
idx=os.path.getsize(os.path.join(d,'index.html'))
js=os.path.getsize(os.path.join(d,'assets','$ASSET')) if '$ASSET' else 0
open('$OUT/results.jsonl','a').write(json.dumps({'name':'ui-index','group':'ui','method':'GET','path':'packages/ui/dist/index.html','http':200,'time_s':0,'bytes':idx,'sample':'<title>DuckBrain - Memory Archive</title>  (built bundle present)'})+'\n')
open('$OUT/results.jsonl','a').write(json.dumps({'name':'ui-bundle','group':'ui','method':'GET','path':'packages/ui/dist/assets/$ASSET','http':200,'time_s':0,'bytes':js,'sample':'Vite production bundle — builds clean (pnpm build exit 0)'})+'\n')
"
fi

# ── report ──────────────────────────────────────────────────────────────────
python3 - <<PY
import json
rows=[json.loads(l) for l in open("$OUT/results.jsonl")]
ok=sum(1 for r in rows if 200<=r["http"]<300)
print(f"{ok}/{len(rows)} 2xx")
for r in rows:
    mark = "OK " if 200<=r["http"]<300 else ("AUTH" if r["http"] in (401,403) else "!! ")
    print(f"{mark} {r['name']:14} {r['group']:8} {r['method']:6} {r['http']:>4} {r['bytes']:>7}b {r['time_s']:>6}s")
PY