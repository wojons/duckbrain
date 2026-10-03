#!/usr/bin/env bash
# test-fd-inheritance.sh — hermetic regression harness for S3-GIT-006.
#
# Pins the flock/fd contract of scripts/s3/duckbrain-s3-unified.sh:
#   - the unified wrapper holds its single-instance lock on fd 9, and
#   - every child (layer scripts, node) is spawned with fd 9 CLOSED
#     (`9>&-` per invocation), so a timeout-killed cron can never leave
#     the lock reachable from orphaned node processes;
#   - while the shell's fd holds the flock, a second `flock -n` on the
#     file MUST fail (the close is per-invocation, never top-level:
#     `exec 9>&-` would release the flock — the lock lives on the open
#     file description and dies with its last fd — measured live on this
#     host when the fix was written).
#
# Arms:
#   1  child spawned with `9>&-` has NO fd pointing at the lockfile (the fix)
#   2  control: a child spawned WITHOUT the close DOES inherit (documents
#      the pre-fix bug shape and proves this harness's detector is not
#      vacuous — RED on the pre-fix script)
#   3  while that child is alive, a second `flock -n` on the lockfile fails
#      (the shell still holds the lock)
#   4  semantics pin: the WRONG shape (top-level `exec 9>&-`) RELEASES the
#      lock — a second flock succeeds — so nobody re-introduces it
#   5  end-to-end on the REAL unified script: its running child has no
#      lockfile fd, the wrapper shell does, a concurrent wrapper run is
#      SKIPPED, and the lock is free again after the wrapper exits
#
# Fully hermetic: everything under $(mktemp -d) via the DUCKBRAIN_S3_*
# env overrides; no real S3, no real state dir, no real scripts.
#
# Usage: bash scripts/s3/test-fd-inheritance.sh
#   exit 0 = every assertion PASS, non-zero = at least one FAIL.
# Requires: flock(1), git (only to init the scratch dirs' fixtures).
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIFIED="$SELF_DIR/duckbrain-s3-unified.sh"
[ -f "$UNIFIED" ] || { echo "FAIL: missing $UNIFIED"; exit 2; }
command -v flock >/dev/null 2>&1 || { echo "FAIL: flock(1) not on PATH"; exit 2; }

S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT

n_ok=0; n_bad=0
ok() { printf 'PASS: %s\n' "$1"; n_ok=$((n_ok+1)); }
no() { printf 'FAIL: %s\n' "$1"; n_bad=$((n_bad+1)); }
assert_eq() { # <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1 [$3]"; else no "$1 (expected '$2', got '$3')"; fi
}

# has_lockfd <pid> <lockfile> — 0 when some /proc/<pid>/fd link targets lockfile
has_lockfd() {
  local pid="$1" lock="$2" fd target
  [ -d "/proc/$pid/fd" ] || return 1
  for fd in /proc/"$pid"/fd/*; do
    target=$(readlink "$fd" 2>/dev/null) || continue
    if [ "$target" = "$lock" ]; then return 0; fi
  done
  return 1
}

# wait_for_file <path> <timeout_s> — poll until path exists
wait_for_file() {
  local path="$1" timeout="$2" waited=0
  while [ ! -s "$path" ] && [ "$waited" -lt "$timeout" ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  [ -s "$path" ]
}

# A child that lives long enough to be inspected, and reports its own pid.
make_sleeper() { # <dir>
  local dir="$1"
  mkdir -p "$dir"
  printf '#!/usr/bin/env bash\nprintf "%%s" "$$" > "%s/pid"\nsleep 5\n' "$dir" > "$dir/sleeper"
  chmod +x "$dir/sleeper"
}

echo "=== Arms 1-3: the fix shape (flock on fd9, child spawned 9>&-) ==="
LOCK="$S/probe.lock"
exec 9>"$LOCK"
if flock -n 9; then ok "harness shell took the flock on fd 9"; else no "harness shell could not take its own flock"; fi
make_sleeper "$S"

# ---- arm 1: the fix — child gets fd 9 closed for that invocation ----------
"$S/sleeper" 9>&- &
CHILD=$!
wait_for_file "$S/pid" 30 || no "arm1: child pid file never appeared"
CPID="$(cat "$S/pid" 2>/dev/null || echo 0)"
if [ "$CPID" -gt 0 ] 2>/dev/null && ! has_lockfd "$CPID" "$LOCK"; then
  ok "arm1: child (pid $CPID) has NO fd pointing at the lockfile (9>&- worked)"
else
  no "arm1: child (pid $CPID) inherited a lockfile fd (close did not apply)"
fi

# ---- arm 3 (while arm-1's child is ALIVE): shell still holds the lock -----
if flock -n "$LOCK" -c true 2>/dev/null; then
  no "arm3: a second flock SUCCEEDED while the shell's fd9 is open (lock was lost!)"
else
  ok "arm3: second flock refused while child alive — shell still holds the lock"
fi
wait "$CHILD"

# ---- arm 2: control — WITHOUT the close the child inherits (old bug) ------
rm -f "$S/pid"
"$S/sleeper" &
CHILD=$!
wait_for_file "$S/pid" 30 || no "arm2: child pid file never appeared"
CPID="$(cat "$S/pid" 2>/dev/null || echo 0)"
if [ "$CPID" -gt 0 ] 2>/dev/null && has_lockfd "$CPID" "$LOCK"; then
  ok "arm2 control: child spawned WITHOUT 9>&- DID inherit the lockfile fd (pre-fix bug shape; detector is live)"
else
  no "arm2 control: child did NOT inherit (bash fd-inheritance semantics changed — this harness's premise is stale)"
fi
wait "$CHILD"

echo "=== Arm 4: semantics pin — top-level 'exec 9>&-' RELEASES the lock ==="
LOCK2="$S/probe-wrongshape.lock"
(
  exec 9>"$LOCK2"
  flock -n 9 || exit 3
  exec 9>&-
  sleep 2   # alive and "running layers" with the fd already closed
) &
WSHAPE=$!
sleep 0.4   # let it take the lock and close fd 9
if flock -n "$LOCK2" -c true 2>/dev/null; then
  ok "arm4: the wrong shape released the lock MID-RUN (second flock succeeded while the shell was still alive) — pinned so it is never re-introduced"
else
  no "arm4: expected the top-level close to release the lock mid-run (kernel behavior changed?)"
fi
wait "$WSHAPE"

echo "=== Arm 5: end-to-end on the REAL unified script ==="
STATE="$S/state"
mkdir -p "$S/scripts" "$STATE"
make_sleeper "$S/scripts/sleeper-d"
# daily layer = the sleeper (long enough to inspect); native/weekly = inert stubs
printf '#!/usr/bin/env bash\nexec %s/sleeper-d/sleeper\n' "$S/scripts" > "$S/scripts/duckbrain-s3-daily.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$S/scripts/duckbrain-s3-native-sync.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$S/scripts/duckbrain-s3-weekly.sh"
chmod +x "$S/scripts/duckbrain-s3-daily.sh" "$S/scripts/duckbrain-s3-native-sync.sh" "$S/scripts/duckbrain-s3-weekly.sh"
RUNLOCK="$STATE/duckbrain-s3-unified.lock"

DUCKBRAIN_S3_STATE_DIR="$STATE" DUCKBRAIN_S3_SCRIPTS_DIR="$S/scripts" \
  DUCKBRAIN_S3_SKIP_COMPONENTS="native,weekly" \
  "$UNIFIED" > "$S/run5.out" 2>&1 &
WRAPPER=$!
# wait for the DAILY layer's sleeper pid (the git layer runs: no marker yet)
wait_for_file "$S/scripts/sleeper-d/pid" 30 || no "arm5: daily layer never started"
SPID="$(cat "$S/scripts/sleeper-d/pid" 2>/dev/null || echo 0)"

if [ "$SPID" -gt 0 ] 2>/dev/null && ! has_lockfd "$SPID" "$RUNLOCK"; then
  ok "arm5: the wrapper's running child (daily layer, pid $SPID) has NO lockfile fd (S3-GIT-006 fix live)"
else
  no "arm5: the wrapper's child (pid $SPID) inherited the lockfile fd — the fix regressed"
fi

if has_lockfd "$WRAPPER" "$RUNLOCK"; then
  ok "arm5: the wrapper shell itself (pid $WRAPPER) still holds the lock fd"
else
  no "arm5: the wrapper shell no longer lists the lockfile fd — who holds the lock now?"
fi

if flock -n "$RUNLOCK" -c true 2>/dev/null; then
  no "arm5: a foreign flock SUCCEEDED mid-run — the wrapper is not holding its lock"
else
  ok "arm5: the lockfile is locked while the wrapper runs (concurrent runs are excluded)"
fi

# concurrent second wrapper: must SKIP fast, exit 0
rc2=0
DUCKBRAIN_S3_STATE_DIR="$STATE" DUCKBRAIN_S3_SCRIPTS_DIR="$S/scripts" \
  DUCKBRAIN_S3_SKIP_COMPONENTS="native,weekly,git" \
  "$UNIFIED" > "$S/run5b.out" 2>&1 || rc2=$?
assert_eq "arm5: concurrent second wrapper exits 0 (skipped, not failed)" 0 "$rc2"
if grep -q "SKIPPED" "$S/run5b.out"; then
  ok "arm5: concurrent second wrapper printed the SKIPPED line"
else
  no "arm5: concurrent second wrapper did not skip: $(head -c 200 "$S/run5b.out")"
fi

wait "$WRAPPER"
WRC=$?
assert_eq "arm5: wrapper exit code (daily stub succeeds)" 0 "$WRC"

echo "=== Arm 6: concurrent second wrapper is SKIPPED by the live lock ==="
# fresh state so the git layer runs again in a controlled wrapper
STATE6="$S/state6"
mkdir -p "$STATE6" "$S/scripts6"
make_sleeper "$S/scripts6/sleeper-d"
printf '#!/usr/bin/env bash\nexec %s/sleeper-d/sleeper\n' "$S/scripts6" > "$S/scripts6/duckbrain-s3-daily.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$S/scripts6/duckbrain-s3-native-sync.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$S/scripts6/duckbrain-s3-weekly.sh"
chmod +x "$S/scripts6/duckbrain-s3-daily.sh" "$S/scripts6/duckbrain-s3-native-sync.sh" "$S/scripts6/duckbrain-s3-weekly.sh"
RUNLOCK6="$STATE6/duckbrain-s3-unified.lock"
DUCKBRAIN_S3_STATE_DIR="$STATE6" DUCKBRAIN_S3_SCRIPTS_DIR="$S/scripts6" \
  DUCKBRAIN_S3_SKIP_COMPONENTS="native,weekly" \
  "$UNIFIED" > "$S/run6.out" 2>&1 &
WRAP6=$!
wait_for_file "$S/scripts6/sleeper-d/pid" 30 || no "arm6: daily layer never started"
rc6=0
DUCKBRAIN_S3_STATE_DIR="$STATE6" DUCKBRAIN_S3_SCRIPTS_DIR="$S/scripts6" \
  "$UNIFIED" > "$S/run6b.out" 2>&1 || rc6=$?
assert_eq "arm6: concurrent second wrapper exits 0 (lock-skip is not a failure)" 0 "$rc6"
if grep -q "SKIPPED — another run in progress" "$S/run6b.out"; then
  ok "arm6: concurrent second wrapper printed the lock-skip line"
else
  no "arm6: second wrapper did not lock-skip: $(head -c 200 "$S/run6b.out")"
fi
wait "$WRAP6"

if flock -n "$RUNLOCK" -c true 2>/dev/null; then
  ok "arm5: the lock is FREE again after the wrapper exited (no leak, no inherited copy anywhere)"
else
  no "arm5: lockfile still locked after the wrapper exited — an inherited fd survives somewhere"
fi

echo "-----"
echo "fd-inheritance harness: $n_ok passed, $n_bad failed"
if [ "$n_bad" -gt 0 ]; then exit 1; fi
exit 0
