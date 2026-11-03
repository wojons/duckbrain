#!/usr/bin/env bash
# Shared per-run scratch, port, and agent ownership primitives for dogfood lanes.

lane_scratch_allocate() {
  local project=$1 lane=$2 tick=$3 agent_id=$4 base=${5:-/tmp}
  local safe tick_safe root run_id
  safe=$(printf '%s-%s' "$project" "$lane" | tr -cs 'A-Za-z0-9._-' '-')
  tick_safe=$(printf '%s' "$tick" | tr -cs 'A-Za-z0-9._-' '-')
  root=$(mktemp -d "$base/${safe}-${tick_safe}-XXXXXXXX")
  run_id=$(basename "$root")
  chmod 700 "$root"
  printf 'run_id=%s\nagent_id=%s\nroot=%s\n' "$run_id" "$agent_id" "$root" > "$root/run.state"
  chmod 600 "$root/run.state"
  printf '%s\n' "$root"
}

lane_scratch_assert_owner() {
  local root=$1 run_id=$2 agent_id=$3 recorded_run recorded_agent
  if [[ ! -f "$root/run.state" ]]; then
    echo "scratch ownership state missing: $root" >&2; return 1
  fi
  recorded_run=$(sed -n 's/^run_id=//p' "$root/run.state")
  recorded_agent=$(sed -n 's/^agent_id=//p' "$root/run.state")
  if [[ "$recorded_run" != "$run_id" || "$recorded_agent" != "$agent_id" ]]; then
    echo "scratch collision: path=$root requested_run=$run_id requested_agent=$agent_id existing_run=${recorded_run:-none} existing_agent=${recorded_agent:-none}" >&2
    return 1
  fi
}

lane_scratch_allocate_port() {
  local root=$1 run_id=$2 agent_id=$3 lock_dir=${LANE_PORT_LOCK_DIR:-/tmp/duckbrain-dogfood-port-locks}
  local port lock
  lane_scratch_assert_owner "$root" "$run_id" "$agent_id"
  mkdir -p "$lock_dir"
  chmod 700 "$lock_dir"
  for port in $(seq 20000 45000); do
    lock="$lock_dir/$port.lock"
    if ( set -o noclobber; printf '%s %s\n' "$run_id" "$root" > "$lock" ) 2>/dev/null; then
      if command -v ss >/dev/null && ss -H -tln "( sport = :$port )" | grep -q .; then
        rm -f "$lock"
        continue
      fi
      printf 'port=%s\n' "$port" >> "$root/run.state"
      printf '%s\n' "$port"
      return 0
    fi
  done
  echo "no free dogfood port available for run=$run_id path=$root" >&2
  return 1
}

lane_scratch_release_ports() {
  local root=$1 run_id=$2 agent_id=$3 port lock_dir=${LANE_PORT_LOCK_DIR:-/tmp/duckbrain-dogfood-port-locks} lock
  lane_scratch_assert_owner "$root" "$run_id" "$agent_id"
  while IFS= read -r port; do
    [[ "$port" =~ ^[0-9]+$ ]] || continue
    lock="$lock_dir/$port.lock"
    if [[ -f "$lock" ]] && grep -qx "$run_id $root" "$lock"; then rm -f -- "$lock"; fi
  done < <(sed -n 's/^port=//p' "$root/run.state")
}

lane_scratch_claim_agent() {
  local root=$1 run_id=$2 agent_id=$3 pid=$4 agent_dir
  agent_dir="$root/agents/$agent_id/$pid"
  lane_scratch_assert_owner "$root" "$run_id" "$agent_id"
  mkdir -p "$agent_dir"
  printf 'run_id=%s\nagent_id=%s\npid=%s\n' "$run_id" "$agent_id" "$pid" > "$agent_dir/ownership.tag"
}

lane_scratch_teardown_agent() {
  local root=$1 run_id=$2 agent_id=$3 pid=$4 agent_dir tag_run tag_agent root_agent
  root_agent=$(sed -n 's/^agent_id=//p' "$root/run.state" 2>/dev/null)
  lane_scratch_assert_owner "$root" "$run_id" "$root_agent"
  agent_dir="$root/agents/$agent_id/$pid"
  if [[ ! -f "$agent_dir/ownership.tag" ]]; then
    local candidate
    for candidate in "$root"/agents/*/"$pid"/ownership.tag; do
      [[ -f "$candidate" ]] || continue
      tag_run=$(sed -n 's/^run_id=//p' "$candidate")
      tag_agent=$(sed -n 's/^agent_id=//p' "$candidate")
      echo "agent teardown refused: path=${candidate%/ownership.tag} requested_run=$run_id requested_agent=$agent_id tagged_run=${tag_run:-none} tagged_agent=${tag_agent:-none}" >&2
      return 1
    done
    echo "agent ownership tag missing: $agent_dir" >&2; return 1
  fi
  tag_run=$(sed -n 's/^run_id=//p' "$agent_dir/ownership.tag")
  tag_agent=$(sed -n 's/^agent_id=//p' "$agent_dir/ownership.tag")
  if [[ "$tag_run" != "$run_id" || "$tag_agent" != "$agent_id" ]]; then
    echo "agent teardown refused: path=$agent_dir requested_run=$run_id requested_agent=$agent_id tagged_run=${tag_run:-none} tagged_agent=${tag_agent:-none}" >&2
    return 1
  fi
  rm -rf -- "$agent_dir"
}
