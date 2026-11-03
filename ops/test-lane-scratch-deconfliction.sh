#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
source "$REPO/ops/lane-scratch.sh"
EVIDENCE=${1:-$REPO/.coding-hermes/evidence/DF-2026-7-two-lane-dry-run.txt}
mkdir -p "$(dirname "$EVIDENCE")"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/duckbrain-df-2026-7-dryrun-XXXXXXXX")
export LANE_PORT_LOCK_DIR="$TMP/port-locks"
cleanup() {
  local root run agent port
  for root in "$TMP"/duckbrain-dogfood-*; do
    [[ -d "$root" ]] || continue
    run=$(basename "$root")
    agent=$(sed -n 's/^agent_id=//p' "$root/run.state")
    lane_scratch_release_ports "$root" "$run" "$agent"
  done
  rm -rf -- "$TMP"
}
trap cleanup EXIT
{
  echo "Two-lane dry run: $(date -Is)"
  A=$(lane_scratch_allocate duckbrain dogfood "dryrun-$$-lane-A" lane-A-agent "$TMP")
  AR=$(basename "$A"); AA=lane-A-agent
  AP=$(lane_scratch_allocate_port "$A" "$AR" "$AA")
  lane_scratch_claim_agent "$A" "$AR" "$AA" 51001
  printf 'lane A allocates root=%s port=%s run_id=%s agent_id=%s\n' "$A" "$AP" "$AR" "$AA"
  printf 'lane A evidence remains intact\n' > "$A/evidence.txt"
  echo "lane A wrote evidence file=$A/evidence.txt"

  B=$(lane_scratch_allocate duckbrain dogfood "dryrun-$$-lane-B" lane-B-agent "$TMP")
  BR=$(basename "$B"); BA=lane-B-agent
  BP=$(lane_scratch_allocate_port "$B" "$BR" "$BA")
  printf 'lane B fresh allocation root=%s port=%s run_id=%s agent_id=%s\n' "$B" "$BP" "$BR" "$BA"
  [[ "$A" != "$B" && "$AP" != "$BP" ]] || { echo 'fresh allocation was not unique'; exit 1; }

  echo "lane B forced collision probe against lane A:"
  if lane_scratch_assert_owner "$A" "$BR" "$BA" 2>"$TMP/collision.txt"; then
    echo 'ERROR: collision unexpectedly accepted'; exit 1
  else
    cat "$TMP/collision.txt"
  fi
  [[ "$(cat "$A/evidence.txt")" == 'lane A evidence remains intact' ]] || { echo 'lane A evidence was damaged'; exit 1; }
  echo "lane A evidence intact after lane B: $A/evidence.txt"
} | tee "$EVIDENCE"
printf 'Evidence saved: %s\n' "$EVIDENCE"
