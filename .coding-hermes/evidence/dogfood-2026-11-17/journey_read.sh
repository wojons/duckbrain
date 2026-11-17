#!/usr/bin/env bash
# Dogfood 2026-11-17 — the read journey a new agent session would run (CLI).
# Every command redirected to its own file; rc read on the command line itself.
# Scratch store only (env-isolated): DUCKBRAIN_CONFIG_PATH / DUCKBRAIN_NAMESPACES_PATH.
set -uo pipefail
REPO=/home/kara/duckbrain
EV=/home/kara/.hermes/cache/scratch/dfdb-20261117/evidence
export DUCKBRAIN_CONFIG_PATH=/home/kara/.hermes/cache/scratch/dfdb-20261117/scratch/duckbrain.config.json
export DUCKBRAIN_NAMESPACES_PATH=/home/kara/.hermes/cache/scratch/dfdb-20261117/scratch/namespaces
cd "$REPO" || exit 1

run() { # run <label> <cli args...>
  local label="$1"; shift
  local out="$EV/cli-$label.out" err="$EV/cli-$label.err"
  /usr/bin/time -f "%e" -o "$EV/cli-$label.time" \
    node bin/duckbrain.js "$@" >"$out" 2>"$err"
  local rc=$?
  local line
  line=$(printf '%-28s rc=%-3s wall=%-7s out_lines=%-4s err_lines=%s' \
    "$label" "$rc" "$(tr -d '\n' <"$EV/cli-$label.time" 2>/dev/null)" \
    "$(wc -l <"$out")" "$(wc -l <"$err")")
  printf '%s\n' "$line" | tee -a "$EV/journey-timings.txt"
}

: > "$EV/journey-timings.txt"
run list-keys   list-keys --namespace=alpha
run recall-prefix recall --namespace=alpha --prefix=/team/roster/ --limit=100
run recall-key  recall --namespace=alpha --key=/infra/configs/new-db-host
run recall-attr recall --namespace=alpha --attr=owner=agent-0 --limit=100
run recall-contains recall --namespace=alpha --contains=Postgres --limit=100
run recall-domain  recall --namespace=alpha --domain=config --limit=100
run search-warm  search "Postgres cutover" --namespace=alpha
run search-2     search "zebra alerting" --namespace=alpha
run search-all   search --all-namespaces "standup"
run query-count  query "SELECT count(*) AS n FROM memories" --namespace=alpha
run query-group  query "SELECT domain, count(*) AS n FROM memories GROUP BY domain ORDER BY n DESC" --namespace=alpha
run query-tmpl-pps query --template per-project-status --namespace=alpha
run query-tmpl-cost query --template cost-series --namespace=alpha
run query-tmpl-inc query --template incidents-by-day --namespace=alpha
run status        status --namespace=alpha
echo "---- journey done ----" | tee -a "$EV/journey-timings.txt"
