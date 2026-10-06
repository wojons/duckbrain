#!/usr/bin/env bash
# wait-for-ui.sh — poll a UI dev server until it answers HTTP.
#
# Context (QA-DUCKBRAIN-008): the qa-audit battery's ui-probe cell probed
# :3111 for 60s and read http=000 while vite was still cold-booting (~18s
# locally, longer on loaded agents) — and the battery harness itself is NOT
# in this repo, so this helper is the in-repo, tested equivalent to copy or
# invoke before probing.
#
# Usage: ops/wait-for-ui.sh [PORT] [TIMEOUT_SECONDS]
#   PORT default 3111 (battery's ui-probe port), TIMEOUT default 120 (>=90s
#   boot budget per QA-DUCKBRAIN-008 AC3). Polls every 1s; exits 0 on any
#   HTTP response (2xx/3xx from vite), 1 on timeout, 2 on bad args.
set -u
PORT="${1:-3111}"
TIMEOUT="${2:-120}"
case "$PORT" in ''|*[!0-9]*) echo "wait-for-ui: bad port '$PORT'" >&2; exit 2;; esac
case "$TIMEOUT" in ''|*[!0-9]*) echo "wait-for-ui: bad timeout '$TIMEOUT'" >&2; exit 2;; esac
URL="http://127.0.0.1:${PORT}/"
deadline=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$URL")
  code=${code//[^0-9]/}
  # 000 = connect failure (curl prints it for refused/timeout); any real
  # HTTP status (200/302/404/426...) means vite is up and reachable
  if [ -n "$code" ] && [ "$code" != "000" ]; then
    echo "wait-for-ui: ${URL} answered HTTP ${code} after $(( TIMEOUT - (deadline - $(date +%s)) ))s"
    exit 0
  fi
  sleep 1
done
echo "wait-for-ui: ${URL} gave no HTTP response within ${TIMEOUT}s" >&2
exit 1
