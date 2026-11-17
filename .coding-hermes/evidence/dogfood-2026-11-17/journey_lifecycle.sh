#!/usr/bin/env bash
# Day-2 lifecycle as a real operator would run it: forget one fact, prove the views
# agree, then compact (squash) and prove recall still answers.
set -uo pipefail
REPO=/home/kara/duckbrain
EV=/home/kara/.hermes/cache/scratch/dfdb-20261117/evidence
NS=alpha
export DUCKBRAIN_CONFIG_PATH=/home/kara/.hermes/cache/scratch/dfdb-20261117/scratch/duckbrain.config.json
export DUCKBRAIN_NAMESPACES_PATH=/home/kara/.hermes/cache/scratch/dfdb-20261117/scratch/namespaces
cd "$REPO" || exit 1
NSDIR="$DUCKBRAIN_NAMESPACES_PATH/$NS"

echo "=== namespace repo state (auto-commit landed?) ==="
git -C "$NSDIR" log --format='%h %cI %s' 2>&1 | head -5
echo "commits=$(git -C "$NSDIR" rev-list --count HEAD 2>/dev/null)"
echo "size_before=$(du -sm "$NSDIR" 2>/dev/null | cut -f1)MB files=$(find "$NSDIR" -type f | wc -l)"

echo
echo "=== forget one fact (documented: forget <id> --namespace=<ns>) ==="
ID=$(grep -o '"id": "[^"]*"' "$EV/cli-recall-key.out" | head -1 | sed 's/.*: "//; s/"//')
echo "target id=$ID"
/usr/bin/time -f 'forget_wall=%es' node bin/duckbrain.js forget "$ID" --namespace=$NS >"$EV/life-forget.out" 2>"$EV/life-forget.err"
echo "rc=$?"
cat "$EV/life-forget.out"; grep -v ExperimentalWarning "$EV/life-forget.err" | grep -v 'trace-warnings' | tail -3

echo
echo "=== views after forget ==="
node bin/duckbrain.js recall --namespace=$NS --limit=200 >"$EV/life-after-current.out" 2>"$EV/life-after-current.err"
echo "current: $(head -1 "$EV/life-after-current.out")"
node bin/duckbrain.js recall --namespace=$NS --limit=200 --historical >"$EV/life-after-hist.out" 2>"$EV/life-after-hist.err"
echo "historical: $(head -1 "$EV/life-after-hist.out")"
echo "forgotten key still present? $(grep -c 'new-db-host' "$EV/life-after-current.out") current / $(grep -c 'new-db-host' "$EV/life-after-hist.out") historical"

echo
echo "=== time travel: as-of the commit that held the forgotten row ==="
SHA=$(git -C "$NSDIR" log --format='%h' | head -1)
echo "as_of=$SHA"
/usr/bin/time -f 'asof_wall=%es' node bin/duckbrain.js recall --namespace=$NS --as-of="$SHA" --limit=200 >"$EV/life-asof.out" 2>"$EV/life-asof.err"
echo "rc=$? header=$(head -1 "$EV/life-asof.out")"
echo "forgotten key recovered? $(grep -c 'new-db-host' "$EV/life-asof.out")"

echo
echo "=== squash (weekly maintenance) ==="
node bin/duckbrain.js squash --help >"$EV/life-squash-help.out" 2>&1
echo "squash --help rc=$? first_line=$(head -1 "$EV/life-squash-help.out")"
/usr/bin/time -f 'squash_wall=%es' node bin/duckbrain.js squash --namespace=$NS >"$EV/life-squash.out" 2>"$EV/life-squash.err"
echo "squash rc=$?"
cat "$EV/life-squash.out"
echo "--- squash stderr (filtered):"; grep -viE 'ExperimentalWarning|trace-warnings|Cleared stale' "$EV/life-squash.err" | tail -5

echo
echo "=== receipts after squash ==="
node bin/duckbrain.js recall --namespace=$NS --limit=200 >"$EV/life-post-squash.out" 2>&1
echo "current: $(head -1 "$EV/life-post-squash.out")"
node bin/duckbrain.js query "SELECT count(*) AS n FROM memories" --namespace=$NS 2>/dev/null | tail -2
echo "size_after=$(du -sm "$NSDIR" 2>/dev/null | cut -f1)MB files=$(find "$NSDIR" -type f | wc -l)"
echo "commits_after=$(git -C "$NSDIR" rev-list --count HEAD 2>/dev/null)"
