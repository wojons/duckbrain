#!/usr/bin/env bash
# Focused probe: does CLI `recall --prefix=` actually filter? (read-only)
set -uo pipefail
REPO=/home/kara/duckbrain
EV=/home/kara/.hermes/cache/scratch/dfdb-20261117/evidence
export DUCKBRAIN_CONFIG_PATH=/home/kara/.hermes/cache/scratch/dfdb-20261117/scratch/duckbrain.config.json
export DUCKBRAIN_NAMESPACES_PATH=/home/kara/.hermes/cache/scratch/dfdb-20261117/scratch/namespaces
cd "$REPO" || exit 1

p() { # p <label> <args...>
  local label="$1"; shift
  node bin/duckbrain.js "$@" >"$EV/pf-$label.out" 2>"$EV/pf-$label.err"
  local rc=$?
  printf '%-22s rc=%s  header=%-28s distinct_keys=%s\n' "$label" "$rc" \
    "$(head -1 "$EV/pf-$label.out")" \
    "$(grep -c '"key":' "$EV/pf-$label.out")" | tee -a "$EV/prefix-probe.txt"
}

: > "$EV/prefix-probe.txt"
p roster-space  recall --namespace=alpha --prefix /team/roster/ --limit=100
p roster-eq     recall --namespace=alpha --prefix=/team/roster/ --limit=100
p roster-default recall --namespace=alpha --prefix=/team/roster/
p sprint-dec    recall --namespace=alpha --prefix=/sprint/decisions/ --limit=100
p nonexistent   recall --namespace=alpha --prefix=/definitely/not/here/ --limit=100
p key-exact     recall --namespace=alpha --key=/team/roster/lead
echo "--- keys seen in roster-eq ---"
grep -o '"key": "[^"]*"' "$EV/pf-roster-eq.out" | sort -u | head -20
echo "--- keys seen in nonexistent ---"
grep -o '"key": "[^"]*"' "$EV/pf-nonexistent.out" | sort -u | head -20
