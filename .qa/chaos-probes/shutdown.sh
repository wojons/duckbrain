#!/usr/bin/env bash
# .qa/chaos-probes/shutdown.sh — project-owned chaos-shutdown probe
# (QA-DUCKBRAIN-009; pattern: QA-HEADING-013).
#
# OPT-IN HOOK: when this file is executable, the QA battery's chaos-shutdown
# cell runs THIS script INSTEAD of its generic compose chain — the same opt-in
# contract as .qa/chaos-probes/corruption.sh / errorpath.sh (bunker-qa.sh:2423):
#   exit 0   -> cell OK   (SIGTERM stop + restart + SIGKILL kill + recovery all
#                          verified by CONTAINER STATE, not by verb rc alone)
#   exit 1   -> cell FAIL (shutdown-chain misbehavior found)
#   exit 2   -> cell INFO (environment gap — shutdown chain NOT exercised)
#   exit 124 -> cell FAIL (HANG: the cycle exceeded its own 120s wrapper)
#
# WHY THIS EXISTS (QA-DUCKBRAIN-009):
# The chaos-shutdown cell failed on the SECOND `docker compose up -d` of the
# battery — UP=1|STOP=0|RESTART=0|KILL=0|KILLRECOVER=0|DOWN=0, i.e. rc=1 before
# any stop/kill leg ran, so no shutdown leg was ever exercised: the cell graded
# the cell, never the behaviour. The cause is battery-internal — the
# docker-deploy leg composes the SAME project minutes earlier
# (`docker compose up -d --build`, bunker-qa.sh:2129) and its best-effort
# `docker compose down` (bunker-qa.sh:2182/2187) can leave the stack, or just
# its published port, behind; the chaos cell then re-runs `up -d` into that
# state, and with every verb's stderr going to /dev/null the log can never say
# why.
#
# THE FIX: NORMALIZE the project before the first `up` — an unconditional
# `docker compose down --remove-orphans`. Containers and networks only, NEVER
# `-v`: the named volume `duckbrain-data` holds the namespaces and must survive
# service restarts; removing it would turn a restart test into data loss.
#
# BUDGET: the harness wraps this probe in `timeout 120` (bunker-qa.sh:2431);
# the cycle below is additionally wrapped in its own `timeout 120` so a hang
# grades 124 with the log intact. Worst case is bounded by the state polls —
# up 20 + stop 8 + restart 12 + kill 8 + kill-recover 12 + up-after-down 15 =
# 75s — plus verb/preflight overhead, inside 120s. The healthy path returns on
# the first poll of each leg (~1s per leg).
set -euo pipefail

PROBE_TIMEOUT_SECONDS=120

say() { printf '%s\n' "$*"; }
die_env() { say "SHUTDOWN_PROBE=SKIPPED (environment gap): $*"; exit 2; }
die_misbehavior() { say "SHUTDOWN_PROBE=FAIL (shutdown-chain misbehavior): $*"; exit 1; }

# Resolve the repo root from this file's location: compose derives its project
# name and file from the CURRENT directory, so a probe launched from anywhere
# else would test an empty project and `down --remove-orphans` would clean
# nothing (the exact state the row's evidence was stuck in).
probe_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(cd "$probe_dir/../.." && pwd)"

# ── 0 · environment gate (no compose lifecycle verb is reached if it fails) ──
[ -f docker-compose.yml ] || [ -f compose.yml ] || die_env "no compose file in $(pwd) — this probe is repo-specific"
command -v docker >/dev/null 2>&1 || die_env "docker not on PATH"
docker compose version >/dev/null 2>&1 || die_env "docker compose unavailable (CLI or plugin missing)"

# ── 1 · preflight: the compose file must parse ──────────────────────────────
if ! config_err="$(docker compose config --quiet 2>&1)"; then
  say "PREFLIGHT: docker compose config INVALID — every compose verb would fail on this before touching the stop/kill chain:"
  printf '%s\n' "$config_err" | head -5 | sed 's/^/  /'
  die_env "compose file does not parse"
fi
say "PREFLIGHT: docker compose config OK"

# ── 2 · preflight: images must already be built ─────────────────────────────
# The battery's docker-deploy leg runs `up -d --build` minutes earlier, so the
# images exist there. A plain `up -d` AUTO-BUILDS a missing image, which on a
# cold cache blocks far past this probe's 120s wrapper and would grade a
# fabricated HANG against the shutdown logic. Missing images mean the battery
# composition broke (deploy leg skipped/failed): environment gap, not a finding.
images="$(docker compose config --images 2>/dev/null || true)"
[ -n "$images" ] || die_env "docker compose config --images is empty or unsupported — cannot verify the images are built"
missing_images=""
for image in $images; do
  docker image inspect "$image" >/dev/null 2>&1 || missing_images="$missing_images $image"
done
[ -z "$missing_images" ] || die_env "compose images not built:$missing_images — the docker-deploy leg should have built them minutes earlier; a plain 'up -d' here would auto-build and exceed the probe budget, so the shutdown chain is not exercised"
say "PREFLIGHT: images present ($(printf '%s' "$images" | tr '\n' ' '))"

# ── 3 · normalization + teardown trap (the QA-DUCKBRAIN-009 fix) ────────────
# Installed only AFTER the gates: an environment-gap exit must not run a
# compose lifecycle verb (nothing has been changed yet, and the probe may be
# running against a host whose Docker context it must not touch).
cleanup() {
  local rc=$?
  docker compose down --remove-orphans >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT
# A signal must tear the project down too: bash runs the EXIT trap for every
# `exit`-based termination but NOT for a default signal death, and the harness's
# own `timeout 120` (bunker-qa.sh:2431) reaches us as SIGTERM at the deadline.
# Note bash DEFERS a trap while a foreground child is running, so a signal that
# lands mid-cycle is handled once that leg returns — the cycle's own
# `timeout 120` bounds that wait, and the teardown still happens.
trap 'exit 143' TERM
trap 'exit 130' INT

if ! down_err="$(docker compose down --remove-orphans 2>&1)"; then
  printf '%s\n' "$down_err" | head -5 | sed 's/^/  /'
  die_env "could not normalize a leftover stack from an earlier battery leg ('docker compose down --remove-orphans' failed) — shutdown chain not exercised"
fi
say "NORMALIZED: prior containers/networks removed (named volume duckbrain-data deliberately kept — no -v)"

# ── 4 · state helpers (verb rc is NOT evidence: a verb can exit 0 doing
#        nothing to a dead stack, so every leg is state-verified) ─────────────
running_ids() { docker compose ps --quiet 2>/dev/null || true; }
any_ids() { docker compose ps --all --quiet 2>/dev/null || true; }

wait_running() { # <seconds> — 0 once at least one container is running
  local deadline=$((SECONDS + $1)) ids=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    ids="$(running_ids)"
    if [ -n "$ids" ]; then return 0; fi
    sleep 2
  done
  return 1
}
wait_stopped() { # <seconds> — 0 once nothing is running (stop/kill semantics)
  local deadline=$((SECONDS + $1)) ids=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    ids="$(running_ids)"
    if [ -z "$ids" ]; then return 0; fi
    sleep 2
  done
  return 1
}

# ── 5 · the cycle (runs in a child shell under `timeout`, so the harness gets
#        a real 124 on a hang) ───────────────────────────────────────────────
# Plain `up -d`, never `--build`: the docker-deploy leg built these images, and
# a forced rebuild would blow the probe budget on a cold cache.
run_cycle() {
  if ! up_err="$(docker compose up -d 2>&1)"; then
    say "compose up -d rc!=0 — stderr preserved below (the generic cell discarded exactly this):"
    printf '%s\n' "$up_err" | head -10 | sed 's/^/  /'
    if printf '%s' "$up_err" | grep -qiE 'port is already allocated|address already in use|bind for .* failed'; then
      say "SHUTDOWN_PROBE=SKIPPED (environment gap): 'up -d' collided on a published host port that is NOT a stranded container of this compose project (normalization above already removed those) — a foreign listener owns it, so the shutdown chain is not exercised. See the stderr above for the holder."
      exit 2
    fi
    die_misbehavior "'docker compose up -d' failed after normalization — stderr above names the cause (daemon / image / compose error), unlike the generic cell which discarded it"
  fi
  wait_running 20 || die_misbehavior "'docker compose up -d' returned 0 but no container reached running within 20s"
  say "SIGTERM_TARGET=up (running=$(running_ids | wc -l | tr -d ' '))"

  docker compose stop >/dev/null 2>&1 || die_misbehavior "'docker compose stop' rc!=0"
  wait_stopped 8 || die_misbehavior "'docker compose stop' returned 0 but containers are still running within 8s — SIGTERM stop NOT verified"
  say "SIGTERM_STOP=verified (zero running after stop)"

  docker compose start >/dev/null 2>&1 || die_misbehavior "'docker compose start' (post-stop) rc!=0"
  wait_running 12 || die_misbehavior "'docker compose start' returned 0 but no container reached running within 12s"
  say "RESTART=verified (running after stop -> start)"

  docker compose kill >/dev/null 2>&1 || die_misbehavior "'docker compose kill' rc!=0"
  wait_stopped 8 || die_misbehavior "'docker compose kill' returned 0 but containers are still running within 8s — SIGKILL stop NOT verified"
  say "SIGKILL_STOP=verified (zero running after kill)"

  docker compose start >/dev/null 2>&1 || die_misbehavior "kill-recovery 'docker compose start' rc!=0"
  wait_running 12 || die_misbehavior "kill-recovery start returned 0 but no container reached running within 12s"
  say "KILL_RECOVER=verified (running after kill -> start)"

  docker compose down --remove-orphans >/dev/null 2>&1 || die_misbehavior "'docker compose down --remove-orphans' rc!=0"
  [ -z "$(any_ids)" ] || die_misbehavior "containers remain after down ('docker compose ps --all --quiet' is non-empty)"
  say "DOWN=verified (no containers remain)"

  # The row's own failure mode: a SECOND `up -d` in the same battery. It must
  # work off the normalized/complete-down state, and the data volume must have
  # survived every leg above.
  if ! up2_err="$(docker compose up -d 2>&1)"; then
    printf '%s\n' "$up2_err" | head -10 | sed 's/^/  /'
    die_misbehavior "'docker compose up -d' after a complete shutdown failed (QA-DUCKBRAIN-009 regression) — stderr above"
  fi
  wait_running 15 || die_misbehavior "'up -d' after down returned 0 but no container reached running within 15s"
  docker compose down --remove-orphans >/dev/null 2>&1 || die_misbehavior "final 'docker compose down --remove-orphans' rc!=0"
  [ -z "$(any_ids)" ] || die_misbehavior "containers remain after the second down"
  say "SHUTDOWN_PROBE=OK SIGTERM stop + restart + SIGKILL kill + recovery + re-up after complete down all state-verified; duckbrain-data named volume never removed (-v never used)"
}

# The child shell must run under -e for the same fail-fast semantics this
# script has; `declare -f` carries the helpers and the cycle across.
cycle_src="$(declare -f say die_misbehavior running_ids any_ids wait_running wait_stopped run_cycle)
run_cycle"

if command -v timeout >/dev/null 2>&1; then
  set +e
  timeout "$PROBE_TIMEOUT_SECONDS" bash -euo pipefail -c "$cycle_src"
  rc=$?
  set -e
else
  # No coreutils `timeout` (unusual): the harness's own `timeout 120` wrapper
  # still enforces the HANG contract, so run the cycle inline.
  say "NOTE: coreutils timeout absent — relying on the harness's 120s wrapper for the 124 (HANG) contract"
  set +e
  bash -euo pipefail -c "$cycle_src"
  rc=$?
  set -e
fi

case "$rc" in
  0|1|2) : ;;  # the cycle (or die_misbehavior / the port-collision gap) already reported
  124) say "SHUTDOWN_PROBE=HANG: the shutdown cycle exceeded ${PROBE_TIMEOUT_SECONDS}s" ;;
  *) say "SHUTDOWN_PROBE=FAIL (unexpected rc=$rc) — inspect the cycle output above" ;;
esac
exit "$rc"
