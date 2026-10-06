#!/usr/bin/env bash
# test-push-backoff.sh — hermetic regression harness for the DuckBrain → S3
# git-history layer (S3-GIT-002 backoff/state, S3-GIT-003 forced full pass).
#
# It never touches real S3, the real state dir, the real log, or the real
# namespaces root: everything runs under $(mktemp -d) through the
# DUCKBRAIN_S3_* env overrides, and the push script's `aws list-objects` remote
# count is skipped because the URL template is not an s3:// URL.
#
# Real pushes, no mocks: 3 scratch namespace repos are pushed to file:// bare
# remotes. Two of them have a remote (they push), the third does not (its push
# fails for real) — that is the "one rejecting namespace" the hardening is for.
#
# Runs:
#   1  cold start: 2 push, 1 fails for real; backoff started; stamp written
#   2  healthy namespaces skipped WITHOUT a push; failing one deferred
#   3  backoff window forced open: only the failing namespace is retried
#   4  unified wrapper: 24h marker advances, the failure stays loud
#   5  inside the marker window the git layer must not re-run at all
#   6  S3-GIT-003 gap: a remote-side wipe is NOT repaired by an ordinary run
#   7  forced full pass (DUCKBRAIN_S3_FORCE_FULL=1, inherited through the
#      unified wrapper) re-pushes and repairs the wiped remote; the roll-up
#      names the forced namespaces and the backoff-deferred one — a partial
#      forced pass is never a bare green line
#   8  age-based periodic force (no env knob): only the aged namespace is
#      re-pushed, the fresh unchanged one is still skipped
#   9  no re-push regression: an ordinary run right after a forced pass skips
#   10 DUCKBRAIN_S3_FULL_PASS_INTERVAL_S=0 disables the age-based force
#   11 a forced pass that fails is not a bare green summary (PARTIAL carries the
#      forced count, the forced failure is named, the deferred one is named)
#
# Usage: bash scripts/s3/test-push-backoff.sh
#   exit 0 = every assertion PASS, non-zero = at least one FAIL.
# Requires: git, git-remote-s3 on PATH (the push script's own precondition).
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH="$SELF_DIR/duckbrain-s3-push.sh"
UNIFIED="$SELF_DIR/duckbrain-s3-unified.sh"
for f in "$PUSH" "$UNIFIED"; do
  if [ ! -f "$f" ]; then echo "FAIL: missing $f"; exit 2; fi
done
if ! command -v git-remote-s3 >/dev/null 2>&1; then
  echo "FAIL: git-remote-s3 not on PATH — the push script would abort before any assertion"
  exit 2
fi

S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT

export DUCKBRAIN_S3_NS_ROOT="$S/namespaces"
export DUCKBRAIN_S3_STATE_DIR="$S/state"
export DUCKBRAIN_S3_LOG_DIR="$S/logs"
export DUCKBRAIN_S3_URL_TEMPLATE="file://${S}/remotes/\${name}"
LOG="$DUCKBRAIN_S3_LOG_DIR/duckbrain-s3test.log"
DAILY_LOG="$DUCKBRAIN_S3_LOG_DIR/duckbrain-s3daily.log"
STATE_NS="$DUCKBRAIN_S3_STATE_DIR/s3-git-ns/s3test"
STATE_NS_DAILY="$DUCKBRAIN_S3_STATE_DIR/s3-git-ns/s3daily"
MARKER="$DUCKBRAIN_S3_STATE_DIR/s3-git-push.last"
WEEKLY_MARKER="$DUCKBRAIN_S3_STATE_DIR/s3-weekly-archive.last"
STAMP="$DUCKBRAIN_S3_STATE_DIR/s3-git-pass.last"

# hermetic git: no user/system config may leak into the scratch repos
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL="$S/gitconfig"
: > "$GIT_CONFIG_GLOBAL"
export GIT_AUTHOR_NAME="s3-harness" GIT_AUTHOR_EMAIL="s3@example.invalid"
export GIT_COMMITTER_NAME="s3-harness" GIT_COMMITTER_EMAIL="s3@example.invalid"

# ---- preflight: refuse to run anywhere near production ---------------------
for v in "$DUCKBRAIN_S3_NS_ROOT" "$DUCKBRAIN_S3_STATE_DIR" "$DUCKBRAIN_S3_LOG_DIR"; do
  case "$v" in
    "$S"/*) : ;;
    *) echo "FAIL: scratch override escaped the scratch root: $v"; exit 2 ;;
  esac
done

n_ok=0; n_bad=0
ok() { printf 'PASS: %s\n' "$1"; n_ok=$((n_ok+1)); }
no() { printf 'FAIL: %s\n' "$1"; n_bad=$((n_bad+1)); }
assert_eq() { # <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1 [$3]"; else no "$1 (expected '$2', got '$3')"; fi
}
assert_ge() { # <desc> <min> <actual>
  case "$3" in
    ''|*[!0-9]*) no "$1 (not a number: '$3')"; return 0 ;;
  esac
  if [ "$3" -ge "$2" ]; then ok "$1 ($3 >= $2)"; else no "$1 ($3 < $2)"; fi
}
assert_has() { # <desc> <text> <regex>
  if grep -q -- "$3" <<< "$2"; then ok "$1"; else no "$1 — '$3' not found in: $(printf '%s' "$2" | head -c 400)"; fi
}
assert_lacks() { # <desc> <text> <regex>
  if grep -q -- "$3" <<< "$2"; then no "$1 — '$3' was unexpectedly present"; else ok "$1"; fi
}
assert_file_has() { # <desc> <file> <regex>
  if [ -f "$2" ] && grep -q -- "$3" "$2"; then ok "$1"; else no "$1 — '$3' not in $2"; fi
}
assert_file_absent() { # <desc> <file>
  if [ -e "$2" ]; then no "$1 — $2 exists"; else ok "$1"; fi
}
win_since() { tail -n +"$(( $1 + 1 ))" "$2"; }
sha_of() { git -C "$1" rev-parse HEAD; }
count_lines() { wc -l < "$1" 2>/dev/null || echo 0; }
state_val() { # <state-file> <key> [default] — never aborts the harness
  local f="$1" k="$2" d="${3:-missing}"
  if [ -f "$f" ]; then grep -m1 "^${k}=" "$f" 2>/dev/null | cut -d= -f2- || echo "$d"; else echo "$d"; fi
}
file_or() { # <file> [fallback]
  cat "$1" 2>/dev/null || echo "${2:-missing}"
}
wipe_remote() { # <bare-remote-dir> — a REMOTE-side loss: path kept, refs gone
  rm -rf "$1"
  git init -q --bare -b master "$1"
}
remote_sha() { git -C "$1" rev-parse --verify master 2>/dev/null || true; }
line_matching() { grep -m1 -- "$2" "$1" 2>/dev/null || true; }

# ---- scratch fixtures ------------------------------------------------------
mkdir -p "$DUCKBRAIN_S3_NS_ROOT" "$S/remotes"
mk_ns() { # mk_ns <name>
  local d="$DUCKBRAIN_S3_NS_ROOT/$1"
  git init -q -b master "$d"
  printf 'data for %s\n' "$1" > "$d/data.jsonl"
  git -C "$d" add data.jsonl
  git -C "$d" commit -qm "init $1"
}
FAILING="ns-three"
mk_ns ns-one
mk_ns "Hermes DAGger"        # space in the name: production has one of these
mk_ns "$FAILING"
git init -q --bare -b master "$S/remotes/ns-one"
git init -q --bare -b master "$S/remotes/Hermes DAGger"
# $FAILING deliberately has NO remote → its push fails for real

echo "=== RUN 1 — cold start: 2 push, 1 fails ==="
t0=$(date +%s)
rc=0
"$PUSH" current/git s3test > "$S/run1.out" 2>&1 || rc=$?
run1="$(cat "$S/run1.out")"
assert_eq "run1 exit code is 1 (a push was attempted and failed)" 1 "$rc"
assert_eq "run1 counts: 2 pushed, 0 skipped, 1 failed" 1 "$(grep -c 'OK: pushed=2 skipped=0 failed=1' "$LOG" || true)"
assert_file_has "run1 logs 'FAIL push $FAILING' (summary shape preserved)" "$LOG" "^.*FAIL push ns-three$"
assert_has "run1 stdout PARTIAL line names the failing namespace" "$run1" "duckbrain backup PARTIAL (current/git) — 2 pushed, 1 FAILED: ns-three"
assert_has "run1 logs the push reject reason" "$(cat "$LOG")" "reason\[ns-three\]:"
assert_has "run1 logs the backoff start" "$(cat "$LOG")" "backoff\[ns-three\]: fail_count=1"
assert_ge "completion stamp written at end of the completed pass" "$t0" "$(file_or "$STAMP" x)"
assert_eq "ns-one state file records a clean success" 0 "$(state_val "$STATE_NS/ns-one.state" fail_count)"
assert_eq "space-named namespace gets a sanitised state file" "Hermes DAGger" "$(state_val "$STATE_NS/Hermes_DAGger.state" name)"
assert_ge "failing namespace state file sets a future next_retry" "$(( $(date +%s) + 1 ))" "$(state_val "$STATE_NS/ns-three.state" next_retry 0)"
# the pushes really landed in the bare remotes
assert_eq "ns-one commit reached its bare remote" "$(sha_of "$DUCKBRAIN_S3_NS_ROOT/ns-one")" "$(git -C "$S/remotes/ns-one" rev-parse master)"
assert_eq "space-named commit reached its bare remote" "$(sha_of "$DUCKBRAIN_S3_NS_ROOT/Hermes DAGger")" "$(git -C "$S/remotes/Hermes DAGger" rev-parse master)"

# Remove the healthy remotes: from here on ANY push attempt against them fails,
# so "failed=0" is proof the healthy namespaces were skipped without a push.
mv "$S/remotes/ns-one" "$S/remotes/ns-one.away"
mv "$S/remotes/Hermes DAGger" "$S/remotes/Hermes DAGger.away"

echo "=== RUN 2 — immediately after: healthy skipped, failing deferred ==="
before=$(count_lines "$LOG")
rc=0
"$PUSH" current/git s3test > "$S/run2.out" 2>&1 || rc=$?
w2="$(win_since "$before" "$LOG")"
assert_eq "run2 exit code is 0 (no push was attempted, so none failed)" 0 "$rc"
assert_has "run2 counts: 0 pushed, 3 skipped, 0 failed" "$w2" "^.*OK: pushed=0 skipped=3 failed=0"
assert_has "run2 logs ns-one as up-to-date skip" "$w2" "skip ns-one (up-to-date "
assert_has "run2 logs space-named ns as up-to-date skip" "$w2" "skip Hermes DAGger (up-to-date "
assert_has "run2 defers the failing namespace" "$w2" "defer ns-three (fail_count=1 next_retry="
assert_lacks "run2 did not attempt ns-one (its remote is gone — an attempt would have failed)" "$w2" "FAIL push ns-one"
assert_lacks "run2 did not attempt the space-named ns" "$w2" "FAIL push Hermes DAGger"

echo "=== RUN 3 — backoff window forced open: only the failing ns is attempted ==="
sed -i 's/^next_retry=.*/next_retry=1/' "$STATE_NS/ns-three.state"
before=$(count_lines "$LOG")
rc=0
"$PUSH" current/git s3test > "$S/run3.out" 2>&1 || rc=$?
w3="$(win_since "$before" "$LOG")"
assert_eq "run3 exit code is 1 (the retried push failed again)" 1 "$rc"
assert_has "run3 summary: 0 pushed, 2 skipped, 1 failed" "$w3" "^.*OK: pushed=0 skipped=2 failed=1"
assert_has "run3 retried only the failing namespace" "$w3" "^.*FAIL push ns-three$"
assert_lacks "run3 still skipped ns-one without a push" "$w3" "FAIL push ns-one"
assert_lacks "run3 still skipped the space-named ns" "$w3" "FAIL push Hermes DAGger"
assert_eq "failure count grew to 2 (backoff ladder advancing)" 2 "$(state_val "$STATE_NS/ns-three.state" fail_count)"

echo "=== RUN 4 — unified wrapper: marker advances, failure stays loud ==="
mv "$S/remotes/ns-one.away" "$S/remotes/ns-one"
mv "$S/remotes/Hermes DAGger.away" "$S/remotes/Hermes DAGger"
rm -rf "$DUCKBRAIN_S3_STATE_DIR/s3-git-ns/s3daily"   # fresh state for the daily remote
rm -f "$MARKER" "$STAMP" "$WEEKLY_MARKER"
mkdir -p "$S/scripts"
# The daily wrapper is a mirror of ~/.hermes/scripts/duckbrain-s3-daily.sh
# (`exec duckbrain-s3-push.sh current/git s3daily`) so the real chain
# unified → daily → push runs without leaving the scratch dir.
printf '#!/usr/bin/env bash\nexec %q current/git s3daily\n' "$PUSH" > "$S/scripts/duckbrain-s3-daily.sh"
chmod +x "$S/scripts/duckbrain-s3-daily.sh"
for c in native-sync weekly; do   # stubs: they must never run in this harness
  printf '#!/usr/bin/env bash\necho "STUB %s — should have been skipped"\nexit 0\n' "$c" > "$S/scripts/duckbrain-s3-$c.sh"
  chmod +x "$S/scripts/duckbrain-s3-$c.sh"
done
t4=$(date +%s)
rc=0
DUCKBRAIN_S3_SCRIPTS_DIR="$S/scripts" DUCKBRAIN_S3_SKIP_COMPONENTS="native,weekly" \
  "$UNIFIED" > "$S/run4.out" 2>&1 || rc=$?
run4="$(cat "$S/run4.out")"
assert_eq "run4 exit code is 1 (component failure is reported)" 1 "$rc"
assert_ge "run4 advanced the 24h git marker despite the failure" "$t4" "$(file_or "$MARKER" x)"
assert_has "run4 summary line names the failed component" "$run4" "FAILED components: git-push"
assert_has "run4 summary line names the failing namespace" "$run4" "namespaces: ns-three"
assert_lacks "run4 skipped the native/weekly components" "$run4" "STUB"
assert_file_absent "run4 did not touch the weekly marker" "$WEEKLY_MARKER"
assert_file_has "run4's git layer really ran (2 pushed, 1 failed)" "$DAILY_LOG" "^.*OK: pushed=2 skipped=0 failed=1"
assert_ge "run4 refreshed the completion stamp" "$t4" "$(file_or "$STAMP" x)"

echo "=== RUN 5 — inside the marker window the git layer must not re-run ==="
assert_file_has "run5 sees the marker run4 advanced" "$MARKER" "^[0-9][0-9]*$"
marker_before="$(file_or "$MARKER" missing)"
before=$(count_lines "$DAILY_LOG")
rc=0
DUCKBRAIN_S3_SCRIPTS_DIR="$S/scripts" DUCKBRAIN_S3_SKIP_COMPONENTS="native,weekly" \
  "$UNIFIED" > "$S/run5.out" 2>&1 || rc=$?
run5="$(cat "$S/run5.out")"
assert_eq "run5 exit code is 0 (nothing failed)" 0 "$rc"
assert_eq "run5 left the 24h marker unchanged" "$marker_before" "$(file_or "$MARKER" missing)"
assert_eq "run5 did not run the git layer (no new summary line)" "$before" "$(count_lines "$DAILY_LOG")"
assert_lacks "run5 produced no push summary at all" "$run5" "OK: pushed="

echo "=== RUN 6 — S3-GIT-003 gap: an ordinary run does NOT repair a remote-side wipe ==="
# A remote-side loss that leaves NO local change: the bare remote is re-created
# empty (its refs are gone) while the namespace's own refs are untouched, so the
# recorded refs_hash still matches and the ordinary path skips it.
wipe_remote "$S/remotes/ns-one"
assert_eq "run6 precondition: the ns-one remote really is wiped (no master ref)" "" "$(remote_sha "$S/remotes/ns-one")"
before=$(count_lines "$LOG")
rc=0
"$PUSH" current/git s3test > "$S/run6.out" 2>&1 || rc=$?
w6="$(win_since "$before" "$LOG")"
assert_eq "run6 exit code is 0 (no push attempted: ns-three is still in backoff)" 0 "$rc"
assert_has "run6 skipped ns-one as up-to-date although its remote is gone" "$w6" "^.*skip ns-one (up-to-date "
assert_has "run6 counts: 0 pushed, 3 skipped, 0 failed, 0 forced" "$w6" "^.*OK: pushed=0 skipped=3 failed=0 forced=0"
assert_eq "run6 the wiped remote is still empty — the gap this task closes" "" "$(remote_sha "$S/remotes/ns-one")"

echo "=== RUN 7 — forced full pass (env knob, inherited through the unified wrapper) ==="
rm -f "$MARKER"   # let the unified wrapper run the git layer this time
t7=$(date +%s)
before=$(count_lines "$DAILY_LOG")
rc=0
DUCKBRAIN_S3_SCRIPTS_DIR="$S/scripts" DUCKBRAIN_S3_SKIP_COMPONENTS="native,weekly" DUCKBRAIN_S3_FORCE_FULL=1 \
  "$UNIFIED" > "$S/run7.out" 2>&1 || rc=$?
run7="$(cat "$S/run7.out")"
w7="$(win_since "$before" "$DAILY_LOG")"
assert_eq "run7 unified exit code is 0 (forced pass: nothing attempted failed)" 0 "$rc"
assert_ge "run7 the unified wrapper advanced the 24h git marker" "$t7" "$(file_or "$MARKER" x)"
assert_has "run7 the forced decision is logged with namespace AND reason" "$w7" "force-push ns-one (DUCKBRAIN_S3_FORCE_FULL=1)"
assert_has "run7 the other healthy namespace was forced too (a full pass, not one repo)" "$w7" "force-push Hermes DAGger (DUCKBRAIN_S3_FORCE_FULL=1)"
rollup7="$(line_matching "$DAILY_LOG" 'forced-full: 2 namespace(s) re-pushed despite unchanged refs')"
assert_has "run7 roll-up reports 2 forced with the env attribution" "$rollup7" "(env=2 age=0)"
assert_has "run7 roll-up names ns-one" "$rollup7" "ns-one"
assert_has "run7 roll-up names Hermes DAGger" "$rollup7" "Hermes DAGger"
assert_has "run7 summary counts: 2 pushed, 1 skipped, 0 failed, 2 forced" "$w7" "^.*OK: pushed=2 skipped=1 failed=0 forced=2"
assert_has "run7 the backoff-deferred namespace makes the forced pass visibly partial" "$w7" "^.*forced-full: PARTIAL — 1 namespace(s) in failure backoff were not re-pushed: ns-three"
assert_eq "run7 the wiped remote was repaired (branch re-created at the local tip)" \
  "$(sha_of "$DUCKBRAIN_S3_NS_ROOT/ns-one")" "$(remote_sha "$S/remotes/ns-one")"
assert_lacks "run7 never attempted the deferred namespace" "$w7" "FAIL push ns-three"
# stdout visibility: the forced names AND the partial notice, never a bare green line
forced_line7="$(line_matching "$S/run7.out" 'forced full re-push: 2')"
assert_has "run7 stdout records the forced count" "$forced_line7" "forced full re-push: 2"
assert_has "run7 stdout names the forced ns-one" "$forced_line7" "ns-one"
assert_has "run7 stdout names the forced Hermes DAGger" "$forced_line7" "Hermes DAGger"
assert_has "run7 stdout says the forced pass was partial (not a bare green summary)" "$run7" \
  "duckbrain backup NOTICE (current/git) — forced full pass was partial: 1 namespace(s) in failure backoff were not re-pushed: ns-three"

echo "=== RUN 8 — age-based periodic force: only the AGED namespace is re-pushed ==="
wipe_remote "$S/remotes/ns-one"
sed -i 's/^last_success=.*/last_success=1/' "$STATE_NS_DAILY/ns-one.state"
assert_eq "run8 precondition: ns-one's last_success really is aged (7d+)" 1 \
  "$(state_val "$STATE_NS_DAILY/ns-one.state" last_success)"
assert_eq "run8 precondition: the ns-one remote is wiped again" "" "$(remote_sha "$S/remotes/ns-one")"
before=$(count_lines "$DAILY_LOG")
rc=0
"$PUSH" current/git s3daily > "$S/run8.out" 2>&1 || rc=$?
run8="$(cat "$S/run8.out")"
w8="$(win_since "$before" "$DAILY_LOG")"
assert_eq "run8 exit code is 0 (the forced re-push succeeded)" 0 "$rc"
assert_has "run8 the aged namespace is force-pushed with an age reason" "$w8" \
  "^.*force-push ns-one (age [0-9][0-9]*s >= 604800s since last_success)"
assert_has "run8 the fresh unchanged namespace is STILL skipped (per-namespace, not blanket)" "$w8" \
  "^.*skip Hermes DAGger (up-to-date "
assert_lacks "run8 did not force the fresh namespace" "$w8" "force-push Hermes DAGger"
assert_has "run8 weekly-confirmation line names the aged namespace" "$w8" \
  "^.*forced-full-age: periodic full re-push fired for 1 namespace(s) (interval 604800s since last_success): ns-one"
assert_has "run8 summary counts: 1 pushed, 2 skipped, 0 failed, 1 forced" "$w8" \
  "^.*OK: pushed=1 skipped=2 failed=0 forced=1"
assert_eq "run8 the wipe was repaired by the age-based force alone" \
  "$(sha_of "$DUCKBRAIN_S3_NS_ROOT/ns-one")" "$(remote_sha "$S/remotes/ns-one")"
assert_has "run8 stdout names the forced namespace" "$run8" "forced full re-push: 1 (ns-one)"

echo "=== RUN 9 — no re-push regression: the run right after a forced pass skips again ==="
before=$(count_lines "$DAILY_LOG")
rc=0
"$PUSH" current/git s3daily > "$S/run9.out" 2>&1 || rc=$?
run9="$(cat "$S/run9.out")"
w9="$(win_since "$before" "$DAILY_LOG")"
assert_eq "run9 exit code is 0" 0 "$rc"
assert_has "run9 counts: 0 pushed, 3 skipped, 0 failed, 0 forced" "$w9" "^.*OK: pushed=0 skipped=3 failed=0 forced=0"
assert_has "run9 the just-forced namespace is skipped up-to-date again" "$w9" "^.*skip ns-one (up-to-date "
assert_lacks "run9 nothing was forced (the forced pass refreshed last_success)" "$w9" "force-push"
assert_lacks "run9 made no push attempt at all (no 15-minute re-push regression)" "$w9" "FAIL push"
assert_lacks "run9 stdout has no forced suffix" "$run9" "forced full re-push"

echo "=== RUN 10 — DUCKBRAIN_S3_FULL_PASS_INTERVAL_S=0 disables the age force ==="
sed -i 's/^last_success=.*/last_success=1/' "$STATE_NS_DAILY/ns-one.state"
before=$(count_lines "$DAILY_LOG")
rc=0
DUCKBRAIN_S3_FULL_PASS_INTERVAL_S=0 "$PUSH" current/git s3daily > "$S/run10.out" 2>&1 || rc=$?
w10="$(win_since "$before" "$DAILY_LOG")"
assert_eq "run10 exit code is 0" 0 "$rc"
assert_lacks "run10 the aged namespace was NOT force-pushed (0 = disabled)" "$w10" "force-push"
assert_has "run10 counts: 0 pushed, 3 skipped, 0 failed, 0 forced" "$w10" "^.*OK: pushed=0 skipped=3 failed=0 forced=0"

echo "=== RUN 11 — a forced pass that FAILS is never a bare green summary ==="
rm -rf "$S/remotes/ns-one"   # remote gone entirely: the forced push fails for real
before=$(count_lines "$DAILY_LOG")
rc=0
DUCKBRAIN_S3_FORCE_FULL=1 "$PUSH" current/git s3daily > "$S/run11.out" 2>&1 || rc=$?
run11="$(cat "$S/run11.out")"
w11="$(win_since "$before" "$DAILY_LOG")"
assert_eq "run11 exit code is 1 (a forced push was attempted and failed)" 1 "$rc"
assert_has "run11 summary counts: 1 pushed, 1 skipped, 1 failed, 2 forced" "$w11" \
  "^.*OK: pushed=1 skipped=1 failed=1 forced=2"
assert_has "run11 the healthy namespace was still forced and pushed" "$w11" "force-push Hermes DAGger (DUCKBRAIN_S3_FORCE_FULL=1)"
assert_has "run11 PARTIAL line carries the forced count" "$run11" \
  "duckbrain backup PARTIAL (current/git) — 1 pushed (2 forced), 1 FAILED: ns-one"
assert_has "run11 the forced failure is called out explicitly" "$run11" \
  "duckbrain backup FORCED-FULL PARTIAL (current/git) — forced re-push FAILED for: ns-one"
assert_has "run11 the log records the forced failure" "$w11" "^.*forced-full: FAILED for: ns-one"
assert_has "run11 the deferred namespace is still named (partial pass)" "$w11" \
  "^.*forced-full: PARTIAL — 1 namespace(s) in failure backoff were not re-pushed: ns-three"
assert_eq "run11 the forced failure grew the backoff ladder" 1 "$(state_val "$STATE_NS_DAILY/ns-one.state" fail_count)"

echo "-----"
echo "harness: $n_ok passed, $n_bad failed"
if [ "$n_bad" -gt 0 ]; then exit 1; fi
exit 0
