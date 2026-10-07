#!/usr/bin/env bash
# test-alert-gate.sh — hermetic regression harness for the S3-ALERT-001
# consecutive-failure alert gate (scripts/s3/s3-alert-gate.sh + its wiring
# into scripts/s3/duckbrain-s3-unified.sh).
#
# It never touches real state, real Telegram, or real S3: every run gets a
# fresh $(mktemp -d) scratch root, the notifier is a mock recording its
# argv via S3_ALERT_COMMAND, and the unified-wrapper arms either skip all
# layers (DUCKBRAIN_S3_SKIP_COMPONENTS=native,git,weekly) or run a stub
# native layer — no real layer script is ever invoked.
#
# Arms:
#   A1  usage errors rejected (missing/bad job, bad exit-code, bad state dir)
#   A2  2 failures then 1 success -> counter resets to 0, no alert ever
#   A3  3 consecutive failures -> EXACTLY one alert; failures 4-7 silent;
#       8th -> second alert (re-alert cadence)
#   A4  alert message carries job name + failure count + last error line
#   A5  delivery failure -> alert appended to fallback log, gate exits 2,
#       counter still advances; next crossing (count 8) fires again
#   A6  independent per-job counters (two jobs, no cross-talk)
#   A7  concurrent invocations (8 parallel gate calls) -> counter integrity
#   A8  threshold/re-alert env knobs honored (threshold=2, re-alert=2)
#   A9  unified wrapper wiring: success -> gate called with rc=0 (counter
#       reset); failure (stub git layer) -> counter advances + alert at
#       threshold; SKIP run (lock contention) -> NO gate call
#   A10 SIGTERM/timeout path: stub native layer that sleeps, wrapper killed
#       by `timeout -s TERM` -> SIGTERM trap records the failure through
#       the gate (counter incremented, alert at threshold)
#   A11 healthy run after failures: counter reset through the real wrapper
#
# Usage: bash scripts/s3/test-alert-gate.sh
#   exit 0 = every assertion PASS, non-zero = at least one FAIL.
# Requires: bash, flock, timeout (all present on this host).
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SELF_DIR/s3-alert-gate.sh"
UNIFIED="$SELF_DIR/duckbrain-s3-unified.sh"
for f in "$GATE" "$UNIFIED"; do
  if [ ! -f "$f" ]; then echo "FAIL: missing $f"; exit 2; fi
done
command -v flock   >/dev/null 2>&1 || { echo "FAIL: flock not on PATH"; exit 2; }
command -v timeout >/dev/null 2>&1 || { echo "FAIL: timeout not on PATH"; exit 2; }

S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT

n_ok=0; n_bad=0
ok() { printf 'PASS: %s\n' "$1"; n_ok=$((n_ok+1)); }
no() { printf 'FAIL: %s\n' "$1"; n_bad=$((n_bad+1)); }
assert_eq() { # <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1 [$3]"; else no "$1 (expected '$2', got '$3')"; fi
}

# Mock notifier: records job/count/error to $MOCK_LOG (exported), exit code
# selectable. The gate invokes it as:
#   bash -c "$S3_ALERT_COMMAND" s3-alert-gate <job> <count> <last-error>
MOCK_LOG="$S/mock-alerts.log"
: > "$MOCK_LOG"
# shellcheck disable=SC2089  # command template — run via `bash -c` by the gate, not by this shell
MOCK_OK="printf '%s\t%s\t%s\n' \"\$1\" \"\$2\" \"\$3\" >> \"\$MOCK_LOG\""
MOCK_FAIL="exit 7"

fresh_state() { mkdir -p "$S/state"; }
gate() { # gate <job> <rc> [state-dir]
  local st="${3:-$S/state}"
  S3_ALERT_COMMAND="$MOCK_OK" MOCK_LOG="$MOCK_LOG" \
    bash "$GATE" "$1" "$2" "$st"
}
alert_lines() { wc -l < "$MOCK_LOG" | tr -d '[:space:]'; }
reset_mock() { : > "$MOCK_LOG"; }

# ---- A1 usage errors ---------------------------------------------------------
fresh_state
out="$(bash "$GATE" "" 1 "$S/state" 2>&1)";    [ $? -eq 64 ] && ok "A1a empty job name -> usage exit 64"    || no "A1a (out=$out)"
out="$(bash "$GATE" "a/b" 1 "$S/state" 2>&1)"; [ $? -eq 64 ] && ok "A1b slash in job name -> usage exit 64" || no "A1b (out=$out)"
out="$(bash "$GATE" "j" "x" "$S/state" 2>&1)"; [ $? -eq 64 ] && ok "A1c non-numeric exit-code -> usage exit 64" || no "A1c (out=$out)"
out="$(bash "$GATE" "j" 1 "" 2>&1)";           [ $? -eq 64 ] && ok "A1d empty state-dir -> usage exit 64" || no "A1d (out=$out)"

# ---- A2 reset path -----------------------------------------------------------
fresh_state
gate j 1 >/dev/null 2>&1
gate j 1 >/dev/null 2>&1
assert_eq "A2a two failures -> count file" "2" "$(cat "$S/state/j.count")"
gate j 0 >/dev/null 2>&1
assert_eq "A2b success resets counter" "0" "$(cat "$S/state/j.count")"
assert_eq "A2c no alerts fired" "0" "$(alert_lines)"
gate j 1 >/dev/null 2>&1
assert_eq "A2d post-reset failure starts at 1" "1" "$(cat "$S/state/j.count")"

# ---- A3 threshold + re-alert cadence ----------------------------------------
fresh_state
reset_mock
gate k 1 >/dev/null 2>&1
assert_eq "A3a count 1 below threshold" "1" "$(cat "$S/state/k.count")"
assert_eq "A3a no alert at count 1" "0" "$(alert_lines)"
gate k 1 >/dev/null 2>&1
assert_eq "A3b count 2 below threshold" "2" "$(cat "$S/state/k.count")"
assert_eq "A3b still no alert" "0" "$(alert_lines)"
gate k 1 "$S/state" >/dev/null 2>&1
assert_eq "A3c count reaches threshold" "3" "$(cat "$S/state/k.count")"
assert_eq "A3c exactly one alert at threshold" "1" "$(alert_lines)"
# re-alert every 8 consecutive failures AFTER the first: alerts at 3, 11, 19
for i in 4 5 6 7 8 9 10; do gate k 1 "$S/state" >/dev/null 2>&1; done
assert_eq "A3d failures 4-10 silent" "1" "$(alert_lines)"
gate k 1 "$S/state" >/dev/null 2>&1
assert_eq "A3e 11th failure -> second alert" "2" "$(alert_lines)"
gate k 1 "$S/state" >/dev/null 2>&1
assert_eq "A3f 12th failure silent again" "2" "$(alert_lines)"

# ---- A4 message content -------------------------------------------------------
fresh_state
reset_mock
for i in 1 2 3; do
  S3_ALERT_LAST_ERROR="sync deadline exceeded after 300s" gate m 1 "$S/state" >/dev/null 2>&1
done
[ "$(alert_lines)" -eq 1 ] || no "A4 precondition: expected 1 alert, got $(alert_lines)"
grep -q $'^m\t3\tsync deadline exceeded after 300s' "$MOCK_LOG" \
  && ok "A4 alert message carries job+count+error" || no "A4 message content mismatch: $(cat "$MOCK_LOG")"

# ---- A5 delivery failure -> fallback + exit 2 --------------------------------
fresh_state
reset_mock
fb="$S/fallback.log"
gate_fail() { # gate_fail <job> <rc> — notifier always fails
  S3_ALERT_COMMAND="$MOCK_FAIL" S3_ALERT_FALLBACK_LOG="$fb" \
    bash "$GATE" "$1" "$2" "$S/state" 2>/dev/null
}
gate_fail f 1 >/dev/null 2>&1
gate_fail f 1 >/dev/null 2>&1
rc=0; gate_fail f 1 >/dev/null 2>&1 || rc=$?
assert_eq "A5a gate exits 2 on failed delivery" "2" "$rc"
grep -q 'ALERT job=f count=3 delivered=no' "$fb" \
  && ok "A5b fallback log got the ALERT line" || no "A5b fallback missing"
assert_eq "A5c counter still advanced" "3" "$(cat "$S/state/f.count")"
for i in 1 2 3 4 5 6 7; do gate_fail f 1 >/dev/null 2>&1; done   # counts 4..10 silent
rc=0; gate_fail f 1 >/dev/null 2>&1 || rc=$?               # count 11 re-alerts
assert_eq "A5d count-11 re-alert also exits 2 via fallback" "2" "$rc"
assert_eq "A5e two fallback lines total" "2" "$(grep -c 'delivered=no' "$fb")"

# ---- A6 independent per-job counters ----------------------------------------
fresh_state
reset_mock
for i in 1 2 3; do gate x 1 >/dev/null 2>&1; done
gate y 1 >/dev/null 2>&1
assert_eq "A6a job x alerting" "1" "$(alert_lines)"
assert_eq "A6b job y unaffected at count 1" "1" "$(cat "$S/state/y.count")"
for i in 1 2; do gate y 1 >/dev/null 2>&1; done
assert_eq "A6c job y alerts on its own schedule" "2" "$(alert_lines)"

# ---- A7 concurrency ----------------------------------------------------------
fresh_state
reset_mock
# shellcheck disable=SC2034  # i is a pure loop counter
for i in 1 2 3 4 5 6 7 8; do
  gate c 1 "$S/state" >/dev/null 2>&1 &
done
wait
assert_eq "A7a 8 concurrent failures -> exactly 8" "8" "$(cat "$S/state/c.count")"
assert_eq "A7b exactly one alert (at 3; 8 < next re-alert at 11)" "1" "$(alert_lines)"

# ---- A8 env knobs ------------------------------------------------------------
fresh_state
reset_mock
for i in 1 2; do S3_ALERT_THRESHOLD=2 gate t 1 "$S/state" >/dev/null 2>&1; done
assert_eq "A8a threshold=2 alerts on 2nd failure" "1" "$(alert_lines)"
for i in 3 4; do S3_ALERT_THRESHOLD=2 S3_REALERT_EVERY=2 gate t 1 "$S/state" >/dev/null 2>&1; done
assert_eq "A8b re-alert every 2 (count 4)" "2" "$(alert_lines)"
# shellcheck disable=SC2034  # i is a pure loop counter
for i in 5 6; do S3_ALERT_THRESHOLD=2 S3_REALERT_EVERY=2 gate t 1 "$S/state" >/dev/null 2>&1; done
assert_eq "A8c count 6 fires again" "3" "$(alert_lines)"

# ---- A9 unified wrapper wiring ----------------------------------------------
reset_mock
W="$(mktemp -d)"
mkdir -p "$W/state" "$W/scripts"
cp "$GATE" "$W/scripts/s3-alert-gate.sh"
chmod +x "$W/scripts/s3-alert-gate.sh"
# Stub GIT layer used to fail the real wrapper deterministically: the git
# component runs at most once per 24h — seeding its marker to 0 opens the
# window on every run, and a stub exiting 1 makes the wrapper roll up
# "FAILED components: git-push" and exit 1.
cat > "$W/scripts/duckbrain-s3-daily.sh" <<'EOF'
#!/usr/bin/env bash
echo "stub git layer: push rejected (multiple bundles exists on server)" >&2
exit 1
EOF
chmod +x "$W/scripts/duckbrain-s3-daily.sh"
run_wrapper() { # run_wrapper <mode: ok|fail>
  local mode="$1" rc=0
  if [ "$mode" = fail ]; then
    DUCKBRAIN_S3_STATE_DIR="$W/state" DUCKBRAIN_S3_SCRIPTS_DIR="$W/scripts" \
    DUCKBRAIN_S3_SKIP_COMPONENTS="native,weekly" \
    S3_ALERT_COMMAND="$MOCK_OK" MOCK_LOG="$MOCK_LOG" \
      bash "$UNIFIED" >/dev/null 2>&1 || rc=$?
  else
    DUCKBRAIN_S3_STATE_DIR="$W/state" DUCKBRAIN_S3_SCRIPTS_DIR="$W/scripts" \
    DUCKBRAIN_S3_SKIP_COMPONENTS="native,git,weekly" \
    S3_ALERT_COMMAND="$MOCK_OK" MOCK_LOG="$MOCK_LOG" \
      bash "$UNIFIED" >/dev/null 2>&1 || rc=$?
  fi
  return "$rc"
}
run_wrapper ok; assert_eq "A9a wrapper healthy run exits 0" "0" "$?"
assert_eq "A9b success -> gate called with rc=0 (counter file reset)" "0" "$(cat "$W/state/s3-alert-state/duckbrain-s3-unified.count" 2>/dev/null || echo MISSING)"
assert_eq "A9c no alerts after healthy run" "0" "$(alert_lines)"
printf '2\n' > "$W/state/s3-alert-state/duckbrain-s3-unified.count"
run_wrapper fail; assert_eq "A9d wrapper failing run exits 1 (gate masks nothing)" "1" "$?"
assert_eq "A9e pre-seeded 2 + 1 failure -> alert through real wiring" "1" "$(alert_lines)"
assert_eq "A9f counter advanced to 3 through the wrapper" "3" "$(cat "$W/state/s3-alert-state/duckbrain-s3-unified.count")"
grep -q $'^duckbrain-s3-unified\t3\t' "$MOCK_LOG" \
  && ok "A9g alert names the job and count" || no "A9g (mock log: $(cat "$MOCK_LOG"))"
# SKIP run (lock contention) must NOT touch the gate
printf '9\n' > "$W/state/s3-alert-state/duckbrain-s3-unified.count"
reset_mock
flock "$W/state/duckbrain-s3-unified.lock" -c 'sleep 3' &
LOCKPID=$!
sleep 0.3
run_wrapper ok; assert_eq "A9h SKIP run exits 0" "0" "$?"
assert_eq "A9i SKIP run does NOT call the gate (counter untouched)" "9" "$(cat "$W/state/s3-alert-state/duckbrain-s3-unified.count")"
assert_eq "A9j no alert from the SKIP run" "0" "$(alert_lines)"
wait "$LOCKPID" 2>/dev/null
rm -rf "$W"

# ---- A10 SIGTERM/timeout path through the REAL wrapper ----------------------
reset_mock
T="$(mktemp -d)"
mkdir -p "$T/state" "$T/scripts"
cp "$GATE" "$T/scripts/s3-alert-gate.sh"
chmod +x "$T/scripts/s3-alert-gate.sh"
# The wrapper's git leg opens its 24h window (fresh state) and will look for
# duckbrain-s3-daily.sh — provide a healthy stub so the ONLY failure source
# is the killed native leg (keeps the A10e expected error line deterministic).
printf '#!/usr/bin/env bash\nexit 0\n' > "$T/scripts/duckbrain-s3-daily.sh"
chmod +x "$T/scripts/duckbrain-s3-daily.sh"
# Stub native layer: prints an error line, then sleeps — the wrapper runs it
# (native NOT skipped). `timeout -s TERM 2` delivers TERM to the WRAPPER at
# t=2s; its signal trap records the kill (GATE_RC=143). The stub exits on its
# own at t=5s so the wrapper resumes, finishes, and its EXIT trap calls the
# gate with a failure — exactly the production shape of a timeout-killed cron
# (the layer's 300s deadline kill) without a 2h wait.
cat > "$T/scripts/duckbrain-s3-native-sync.sh" <<'EOF'
#!/usr/bin/env bash
echo "stub native layer: sync deadline exceeded" >&2
sleep 5
exit 1
EOF
chmod +x "$T/scripts/duckbrain-s3-native-sync.sh"
# shellcheck disable=SC2090  # same command-template pattern as MOCK_OK above
export MOCK_LOG S3_ALERT_COMMAND="$MOCK_OK" MOCK_OK
killed_run() { # one timeout-killed wrapper run; stdout to /dev/null
  DUCKBRAIN_S3_STATE_DIR="$T/state" DUCKBRAIN_S3_SCRIPTS_DIR="$T/scripts" \
    timeout -s TERM 2 bash "$UNIFIED" >/dev/null 2>&1
  return 0 # the run's own rc is irrelevant; the gate records the kill
}
killed_run
assert_eq "A10a killed run still recorded a failure (count=1)" "1" "$(cat "$T/state/s3-alert-state/duckbrain-s3-unified.count" 2>/dev/null || echo MISSING)"
assert_eq "A10b first killed run alone stays silent (threshold 3)" "0" "$(alert_lines)"
killed_run
killed_run
assert_eq "A10c third killed run -> threshold alert fired" "1" "$(alert_lines)"
assert_eq "A10d counter 3 after three killed runs" "3" "$(cat "$T/state/s3-alert-state/duckbrain-s3-unified.count")"
grep -q $'^duckbrain-s3-unified\t3\tstub native layer: sync deadline exceeded$' "$MOCK_LOG" \
  && ok "A10e alert carries the killed run's last error line" || no "A10e (mock log: $(head -2 "$MOCK_LOG" 2>/dev/null))"
rm -rf "$T"

# ---- A11 reset through the real wrapper --------------------------------------
reset_mock
V="$(mktemp -d)"
mkdir -p "$V/state" "$V/scripts"
cp "$GATE" "$V/scripts/s3-alert-gate.sh"
chmod +x "$V/scripts/s3-alert-gate.sh"
mkdir -p "$V/state/s3-alert-state"
printf '5\n' > "$V/state/s3-alert-state/duckbrain-s3-unified.count"
DUCKBRAIN_S3_STATE_DIR="$V/state" DUCKBRAIN_S3_SCRIPTS_DIR="$V/scripts" \
DUCKBRAIN_S3_SKIP_COMPONENTS="native,git,weekly" \
S3_ALERT_COMMAND="$MOCK_OK" MOCK_LOG="$MOCK_LOG" \
  bash "$UNIFIED" >/dev/null 2>&1
assert_eq "A11 healthy run after failures resets counter to 0" "0" "$(cat "$V/state/s3-alert-state/duckbrain-s3-unified.count")"
rm -rf "$V"

# ---- summary -----------------------------------------------------------------
printf '\n===== test-alert-gate: %s passed, %s failed =====\n' "$n_ok" "$n_bad"
[ "$n_bad" -eq 0 ] || exit 1
exit 0
