#!/usr/bin/env bash
# Is the documented `search` verb still aborting the process? 8 consecutive runs.
set -uo pipefail
REPO=/home/kara/duckbrain
EV=/home/kara/.hermes/cache/scratch/dfdb-20261117/evidence
export DUCKBRAIN_CONFIG_PATH=/home/kara/.hermes/cache/scratch/dfdb-20261117/scratch/duckbrain.config.json
export DUCKBRAIN_NAMESPACES_PATH=/home/kara/.hermes/cache/scratch/dfdb-20261117/scratch/namespaces
cd "$REPO" || exit 1
: > "$EV/search-repeat.txt"
for i in $(seq 1 8); do
  s=$(date +%s%N)
  node bin/duckbrain.js search "Postgres cutover" --namespace=alpha >"$EV/search-run-$i.out" 2>"$EV/search-run-$i.err"
  rc=$?
  e=$(date +%s%N)
  ms=$(( (e - s) / 1000000 ))
  signal=""
  grep -qiE 'Fatal glibc|sysmalloc|stack smashing|Aborted' "$EV/search-run-$i.err" && signal="HEAP-ABORT-TEXT"
  printf 'run=%s rc=%-3s ms=%-6s header=%-45s %s\n' "$i" "$rc" "$ms" "$(head -1 "$EV/search-run-$i.out")" "$signal" | tee -a "$EV/search-repeat.txt"
done
echo "--- any abort text in any run:"; grep -ilE 'Fatal glibc|sysmalloc|stack smashing|Aborted' "$EV"/search-run-*.err || echo "none"
