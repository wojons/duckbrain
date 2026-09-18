#!/usr/bin/env bash
# test-duplicate-bundle-repair.sh — hermetic regression harness for the
# S3-GIT-004 self-healing duplicate-bundle repair in duckbrain-s3-push.sh.
#
# It never touches real S3, real credentials, the real state/log dirs or the
# real namespaces root. The repair is only armed for an s3:// URL template, so
# each case uses its own scratch $HOME whose .local/bin shadows BOTH binaries
# the push script calls:
#   * `aws`             — stub: serves canned object state from the scratch dir
#                         and records every invocation (no network, ever);
#   * `git-remote-s3`   — stub: records the push attempt and refuses.
# (The push script prepends $HOME/.local/bin to PATH, which is what makes the
# shadowing work without touching the real ~/.local/bin.)
#
# Cases:
#   A  two bundles, stale sha present locally -> one quarantine copy (size
#      verified) + one delete of the stale key, the push still runs, the log
#      names the quarantined sha, and the repair is not counted as a failure.
#      Objects the upstream helper ignores (LOCK#/.lock/.zip/PROTECTED#//LOCKS/)
#      must NOT be treated as bundles.
#   B  two bundles, stale sha absent locally  -> zero deletes + loud skip line.
#   C  exactly one bundle                     -> list only, no mutating calls.
#   D  non-s3:// (file://) template           -> guard skipped, ZERO aws calls,
#      and the real push path is untouched (push succeeds for real).
#   E  a git-remote-s3 process is running     -> repair skipped, zero aws calls.
#   F  every aws call fails                   -> repair logged and swallowed,
#      the pass still completes with only the push failure.
#
# Usage: bash scripts/s3/test-duplicate-bundle-repair.sh
#   exit 0 = every assertion PASS, non-zero = at least one FAIL.
# Requires: git, and the real git-remote-s3 on PATH (the push script's own
# precondition check must be satisfiable in the un-stubbed environment).
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH="$SELF_DIR/duckbrain-s3-push.sh"
if [ ! -f "$PUSH" ]; then echo "FAIL: missing $PUSH"; exit 2; fi
if ! command -v git-remote-s3 >/dev/null 2>&1; then
  echo "FAIL: real git-remote-s3 not on PATH — cannot run a test that shadows it"
  exit 2
fi

S="$(mktemp -d)"
HELPER_PID=""
cleanup() {
  if [ -n "$HELPER_PID" ]; then kill "$HELPER_PID" 2>/dev/null || true; fi
  rm -rf "$S"
}
trap cleanup EXIT

# hermetic git: no user/system config may leak into the scratch repos
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL="$S/gitconfig"
: > "$GIT_CONFIG_GLOBAL"
export GIT_AUTHOR_NAME="s3-harness" GIT_AUTHOR_EMAIL="s3@example.invalid"
export GIT_COMMITTER_NAME="s3-harness" GIT_COMMITTER_EMAIL="s3@example.invalid"

STUB_BUCKET="stub-bucket"

# ---- stubs -----------------------------------------------------------------
mkdir -p "$S/stubs"
cat > "$S/stubs/aws" <<'STUB_AWS'
#!/usr/bin/env bash
# stub `aws` — canned object state, call log, never any network.
set -uo pipefail
printf '%s\n' "$*" >> "${STUB_AWS_CALLS:?STUB_AWS_CALLS unset}"
if [ "${STUB_AWS_FAIL:-0}" = "1" ]; then
  echo "stub aws: simulated endpoint failure" >&2
  exit 1
fi
args=("$@")
svc=""; op=""; i=0
while [ "$i" -lt "${#args[@]}" ]; do
  case "${args[$i]}" in
    --endpoint-url|--profile|--region) i=$((i+2)); continue ;;
    s3api|s3) svc="${args[$i]}"; op="${args[$((i+1))]:-}"; break ;;
  esac
  i=$((i+1))
done
state="${STUB_AWS_STATE:?STUB_AWS_STATE unset}"
bucket="${STUB_AWS_BUCKET:?STUB_AWS_BUCKET unset}"
get_opt() {
  local k=0
  while [ "$k" -lt "${#args[@]}" ]; do
    if [ "${args[$k]}" = "$1" ]; then printf '%s' "${args[$((k+1))]:-}"; return 0; fi
    k=$((k+1))
  done
  return 0
}
check_bucket() {
  if [ "$1" != "$bucket" ]; then echo "stub aws: unexpected bucket '$1'" >&2; exit 2; fi
}
case "$svc/$op" in
  s3api/list-objects-v2)
    check_bucket "$(get_opt --bucket)"
    prefix="$(get_opt --prefix)"
    awk -F'\t' -v p="$prefix" 'index($0, p) == 1 { print }' "$state"
    exit 0
    ;;
  s3api/head-object)
    check_bucket "$(get_opt --bucket)"
    key="$(get_opt --key)"
    line="$(awk -F'\t' -v k="$key" '$1 == k { print; exit }' "$state")"
    if [ -z "$line" ]; then
      echo "An error occurred (404) when calling the HeadObject operation: Not Found" >&2
      exit 254
    fi
    printf '%s\n' "$(printf '%s' "$line" | cut -f3)"
    exit 0
    ;;
  s3/cp|s3/rm)
    want=2   # `aws s3 cp <src> <dst>` vs `aws s3 rm <path>`
    if [ "$op" = "rm" ]; then want=1; fi
    positional=()
    j=$((i+2))
    while [ "$j" -lt "${#args[@]}" ]; do
      positional+=("${args[$j]}")
      j=$((j+1))
    done
    if [ "${#positional[@]}" -ne "$want" ]; then
      echo "stub aws: $op expects exactly $want s3:// argument(s) (got ${#positional[@]})" >&2
      exit 64
    fi
    src="${positional[0]}"; dst="${positional[1]:-}"
    case "$src" in s3://*) ;; *) echo "stub aws: bad src '$src'" >&2; exit 64 ;; esac
    rest="${src#s3://}"; check_bucket "${rest%%/*}"; s_key="${rest#*/}"
    if [ "$op" = "cp" ]; then
      case "$dst" in s3://*) ;; *) echo "stub aws: bad dst '$dst'" >&2; exit 64 ;; esac
      rest="${dst#s3://}"; check_bucket "${rest%%/*}"; d_key="${rest#*/}"
      line="$(awk -F'\t' -v k="$s_key" '$1 == k { print; exit }' "$state")"
      if [ -z "$line" ]; then
        echo "An error occurred (404) when calling the CopyObject operation: Not Found" >&2
        exit 254
      fi
      d_size="$(printf '%s' "$line" | cut -f3)"
      if [ "${STUB_AWS_TRUNCATE_COPY:-0}" = "1" ]; then d_size=$(( d_size > 0 ? d_size - 1 : 0 )); fi
      printf '%s\t%s\t%s\n' "$d_key" "$(printf '%s' "$line" | cut -f2)" \
        "$d_size" >> "$state"
      exit 0
    fi
    tmpfile="$state.tmp.$$"   # rm is idempotent, exactly like the real CLI
    awk -F'\t' -v k="$s_key" '$1 != k' "$state" > "$tmpfile"
    mv -f "$tmpfile" "$state"
    exit 0
    ;;
esac
echo "stub aws: unsupported call: $*" >&2
exit 64
STUB_AWS
cat > "$S/stubs/git-remote-s3" <<'STUB_HELPER'
#!/usr/bin/env bash
# stub `git-remote-s3` — records the push attempt and refuses. Never any network.
set -uo pipefail
printf '%s\n' "$*" >> "${STUB_HELPER_CALLS:?STUB_HELPER_CALLS unset}"
echo "stub git-remote-s3: hermetic harness refuses to contact S3" >&2
# STUB_HELPER_SLEEP simulates an IN-FLIGHT push (case E): stay alive, then fail.
if [ "${STUB_HELPER_SLEEP:-0}" != "0" ]; then sleep "${STUB_HELPER_SLEEP:-0}"; fi
exit 1
STUB_HELPER
chmod +x "$S/stubs/aws" "$S/stubs/git-remote-s3"

# git resolves git-remote-<scheme> from its OWN exec path BEFORE PATH, and this
# host carries /usr/lib/git-core/git-remote-s3 -> ~/.local/bin/git-remote-s3
# (installed by the deployment), so a PATH-only shadow does NOT intercept the
# push. Mirror the real exec path into the scratch dir and override that single
# entry: every other helper stays byte-identical, and the real remote helper can
# never run from this harness.
GIT_EXEC_MIRROR="$S/git-exec"
mkdir -p "$GIT_EXEC_MIRROR"
for f in "$(git --exec-path)"/*; do ln -sf "$f" "$GIT_EXEC_MIRROR/$(basename "$f")"; done
rm -f "$GIT_EXEC_MIRROR/git-remote-s3"
cp "$S/stubs/git-remote-s3" "$GIT_EXEC_MIRROR/git-remote-s3"
chmod +x "$GIT_EXEC_MIRROR/git-remote-s3"

# ---- assertions ------------------------------------------------------------
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
  if grep -q -- "$3" <<< "$2"; then ok "$1"; else no "$1 — '$3' not found in: $(printf '%s' "$2" | head -c 500)"; fi
}
assert_lacks() { # <desc> <text> <regex>
  if grep -q -- "$3" <<< "$2"; then no "$1 — '$3' was unexpectedly present"; else ok "$1"; fi
}
assert_file_has() { # <desc> <file> <regex>
  if [ -f "$2" ] && grep -q -- "$3" "$2"; then ok "$1"; else no "$1 — '$3' not in $2"; fi
}
count_matches() { # <file> <regex> — count matching lines in a possibly-absent file
  local f="$1" pat="$2" n
  [ -f "$f" ] || { echo 0; return 0; }
  n="$(grep -c -e "$pat" "$f" || true)"
  echo "${n:-0}"
}
count_matches_any() { # <file> <regex>... — sum of per-pattern counts (patterns
  local f="$1"; shift                           # are mutually exclusive here)
  local total=0 p
  for p in "$@"; do total=$(( total + $(count_matches "$f" "$p") )); done
  echo "$total"
}
file_lines() { # <file> — number of non-empty lines
  local n=0
  if [ -f "$1" ]; then n="$(grep -c . "$1" || true)"; fi
  echo "${n:-0}"
}
stamp_written() { # <file> — 1 when it holds a unix timestamp
  if [ -f "$1" ] && grep -q -e '^[0-9][0-9]*$' "$1"; then echo 1; else echo 0; fi
}
file_or() { cat "$1" 2>/dev/null || echo "${2:-missing}"; }

# ---- per-case scaffolding --------------------------------------------------
case_dir() { # case_dir <label> <ns-name>
  C="$S/$1"
  rm -rf "$C"
  mkdir -p "$C/namespaces" "$C/state" "$C/logs" "$C/home/.local/bin" "$C/remotes"
  cp "$S/stubs/aws" "$C/home/.local/bin/aws"
  cp "$S/stubs/git-remote-s3" "$C/home/.local/bin/git-remote-s3"
  chmod +x "$C/home/.local/bin/aws" "$C/home/.local/bin/git-remote-s3"
  NS="$C/namespaces/$2"
  LOG="$C/logs/duckbrain-s3dup.log"
  AWS_CALLS="$C/aws-calls.log"
  HELPER_CALLS="$C/helper-calls.log"
  AWS_STATE="$C/aws-state"
  : > "$AWS_STATE"
}

mk_ns() { # mk_ns <root> <name> [commit-count]
  local root="$1" name="$2" n="${3:-1}" d i
  d="$root/$name"
  git init -q -b master "$d"
  printf 'data for %s\n' "$name" > "$d/data.jsonl"
  git -C "$d" add data.jsonl
  git -C "$d" commit -qm "c1 $name"
  i=2
  while [ "$i" -le "$n" ]; do
    printf 'rev %s\n' "$i" >> "$d/data.jsonl"
    git -C "$d" add data.jsonl
    git -C "$d" commit -qm "c$i $name"
    i=$((i+1))
  done
  printf '%s' "$d"
}

put_obj() { # put_obj <key> <lastmodified> <size>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$AWS_STATE"
}

state_bundles() { # state_bundles <key-prefix> — bundle keys under a prefix
  awk -F'\t' -v p="$1" 'index($1, p) == 1 && $1 ~ /\.bundle$/ { print $1 }' "$AWS_STATE"
}

run_pass() { # run_pass <case-dir> <remote> <url-template> ; sets PASS_RC
  local c="$1" remote="$2" tpl="$3"
  PASS_RC=0
  HOME="$c/home" \
  GIT_EXEC_PATH="$GIT_EXEC_MIRROR" \
  DUCKBRAIN_S3_NS_ROOT="$c/namespaces" \
  DUCKBRAIN_S3_STATE_DIR="$c/state" \
  DUCKBRAIN_S3_LOG_DIR="$c/logs" \
  DUCKBRAIN_S3_URL_TEMPLATE="$tpl" \
  STUB_AWS_STATE="$c/aws-state" \
  STUB_AWS_CALLS="$c/aws-calls.log" \
  STUB_AWS_BUCKET="$STUB_BUCKET" \
  STUB_AWS_FAIL="${STUB_AWS_FAIL:-0}" \
  STUB_AWS_TRUNCATE_COPY="${STUB_AWS_TRUNCATE_COPY:-0}" \
  STUB_HELPER_CALLS="$c/helper-calls.log" \
  "$PUSH" current/git "$remote" > "$c/push.out" 2>&1 || PASS_RC=$?
}

# Informational only: the concurrency guard is scoped to the namespace being
# repaired, so a helper pushing some OTHER namespace (normal on this host) does
# not affect any case below.
LIVE_HELPERS="$(pgrep -f 'git-remote-s3' 2>/dev/null | grep -c . || true)"
if [ "${LIVE_HELPERS:-0}" -gt 0 ]; then
  echo "note: $LIVE_HELPERS git-remote-s3 process(es) already running on this host (unrelated namespaces do not block the repair)"
fi

echo "=== CASE A — two bundles, stale sha present locally ==="
case_dir caseA ns-dup
NSDIR="$(mk_ns "$C/namespaces" ns-dup 2)"
STALE_SHA="$(git -C "$NSDIR" rev-list --max-parents=0 HEAD | head -1)"   # NOT the tip
TIP_SHA="$(git -C "$NSDIR" rev-parse HEAD)"
REFKEY="current/git/ns-dup/refs/heads/master"
# the STALE bundle is the NEWER one on purpose: 'keep the local tip' must win
# over 'keep the newest LastModified'.
put_obj "$REFKEY/$STALE_SHA.bundle" "2026-09-18T03:19:00+00:00" 1111
put_obj "$REFKEY/$TIP_SHA.bundle"   "2026-09-16T03:56:00+00:00" 2222
# objects the upstream helper's get_bundles_for_ref() ignores — never bundles
put_obj "$REFKEY/LOCK#.lock"             "2026-09-18T03:19:00+00:00" 0
put_obj "$REFKEY/repo.zip"               "2026-09-18T03:19:00+00:00" 3333
put_obj "$REFKEY/PROTECTED#master"       "2026-09-18T03:19:00+00:00" 0
put_obj "$REFKEY/LOCKS/heads/master"     "2026-09-18T03:19:00+00:00" 0
run_pass "$C" s3dup 's3://stub-bucket/current/git/${name}'
A_LOG="$(file_or "$LOG" "")"
A_CALLS="$(file_or "$AWS_CALLS" "")"
assert_eq "A: exit code 1 (the push itself was refused by the stub helper)" 1 "$PASS_RC"
assert_eq "A: repair counted no failure — exactly the one push failed" 1 \
  "$(grep -c -e 'OK: pushed=0 skipped=0 failed=1' <<< "$A_LOG" || true)"
assert_file_has "A: S3-GIT-002 contract intact (FAIL push logged)" "$LOG" "^.*FAIL push ns-dup$"
assert_eq "A: completion stamp still written after a repair" 1 "$(stamp_written "$C/state/s3-git-pass.last")"
assert_eq "A: exactly one quarantine copy" 1 "$(count_matches "$AWS_CALLS" 's3 cp')"
assert_file_has "A: the copy targets quarantine/git/<ns>/<branch>/<stale-sha>.bundle" \
  "$AWS_CALLS" "quarantine/git/ns-dup/master/$STALE_SHA.bundle"
assert_eq "A: exactly one delete" 1 "$(count_matches "$AWS_CALLS" 's3 rm')"
assert_file_has "A: the delete targets the stale key under the ref path" \
  "$AWS_CALLS" "s3://$STUB_BUCKET/$REFKEY/$STALE_SHA.bundle"
assert_lacks "A: the keeper (local tip) was never copied or deleted" \
  "$AWS_CALLS" "$TIP_SHA.bundle"
assert_eq "A: the copied object's size was verified (one head-object)" 1 \
  "$(count_matches "$AWS_CALLS" 's3api head-object')"
assert_has "A: one loud line naming the quarantined sha (12 chars)" \
  "$A_LOG" "repair ns-dup: quarantined 1 duplicate bundle(s) (${STALE_SHA:0:12})"
assert_lacks "A: no leftover-duplicate line (exactly one bundle remains)" \
  "$A_LOG" "still .* bundles after repair"
assert_ge "A: the push still ran (helper invoked)" "1" "$(file_lines "$HELPER_CALLS")"
assert_eq "A: exactly one bundle left under the ref path" 1 \
  "$(state_bundles "$REFKEY/" | grep -c . || true)"
assert_eq "A: the surviving bundle is the local tip" "$REFKEY/$TIP_SHA.bundle" \
  "$(state_bundles "$REFKEY/" | head -1)"
assert_eq "A: the quarantined copy carries the source size" 1 \
  "$(awk -F'\t' -v k="quarantine/git/ns-dup/master/$STALE_SHA.bundle" '$1 == k && $3 == 1111 { print }' "$AWS_STATE" | grep -c . || true)"
assert_eq "A: ignored objects (LOCK#/.zip/PROTECTED#//LOCKS/) were left alone" 4 \
  "$(grep -c -e 'LOCK#.lock' -e 'repo.zip' -e 'PROTECTED#master' -e 'LOCKS/heads/master' "$AWS_STATE" || true)"

echo "=== CASE B — stale sha NOT present locally ==="
case_dir caseB ns-stale
NSDIR="$(mk_ns "$C/namespaces" ns-stale 2)"
TIP_SHA="$(git -C "$NSDIR" rev-parse HEAD)"
GHOST_SHA="dead00000000000000000000000000000000beef"
REFKEY="current/git/ns-stale/refs/heads/master"
put_obj "$REFKEY/$TIP_SHA.bundle"   "2026-09-16T03:56:00+00:00" 2222
put_obj "$REFKEY/$GHOST_SHA.bundle" "2026-09-18T03:19:00+00:00" 1111
run_pass "$C" s3dup 's3://stub-bucket/current/git/${name}'
B_LOG="$(file_or "$LOG" "")"
assert_eq "B: zero quarantine copies" 0 "$(count_matches "$AWS_CALLS" 's3 cp')"
assert_eq "B: zero deletes (unverifiable data is never deleted)" 0 "$(count_matches "$AWS_CALLS" 's3 rm')"
assert_has "B: loud skip line naming the unverifiable sha" "$B_LOG" \
  "repair-skip ns-stale: stale bundle $GHOST_SHA under refs/heads/master is NOT in the local repo"
assert_has "B: honest leftover report" "$B_LOG" "repair ns-stale: still 2 bundles after repair"
assert_ge "B: the push still ran" "1" "$(file_lines "$HELPER_CALLS")"
assert_eq "B: both bundles are still there" 2 "$(state_bundles "$REFKEY/" | grep -c . || true)"

echo "=== CASE C — exactly one bundle (idempotent no-op) ==="
case_dir caseC ns-one
NSDIR="$(mk_ns "$C/namespaces" ns-one 1)"
TIP_SHA="$(git -C "$NSDIR" rev-parse HEAD)"
REFKEY="current/git/ns-one/refs/heads/master"
put_obj "$REFKEY/$TIP_SHA.bundle" "2026-09-18T03:19:00+00:00" 4444
run_pass "$C" s3dup 's3://stub-bucket/current/git/${name}'
C_LOG="$(file_or "$LOG" "")"
assert_eq "C: the ref path was listed exactly once" 1 \
  "$(count_matches "$AWS_CALLS" "list-objects-v2 --bucket $STUB_BUCKET --prefix $REFKEY/")"
assert_eq "C: zero mutating aws calls (no cp/rm/head-object)" 0 \
  "$(count_matches_any "$AWS_CALLS" 's3 cp' 's3 rm' 'head-object')"
assert_has "C: says so at the normal log level" "$C_LOG" \
  "repair ns-one: 1 bundle under refs/heads/master (ok, nothing to repair)"
assert_lacks "C: no quarantine line" "$C_LOG" "quarantined"

echo "=== CASE D — non-s3:// template: guard skipped, zero aws calls ==="
case_dir caseD ns-file
NSDIR="$(mk_ns "$C/namespaces" ns-file 1)"
git init -q --bare -b master "$C/remotes/ns-file"
run_pass "$C" s3dup "file://$C/remotes/\${name}"
D_LOG="$(file_or "$LOG" "")"
assert_eq "D: exit code 0 (real push succeeded)" 0 "$PASS_RC"
assert_file_has "D: the namespace was pushed for real" "$LOG" "^.*OK: pushed=1 skipped=0 failed=0"
assert_eq "D: the commit reached the bare remote" "$(git -C "$NSDIR" rev-parse HEAD)" \
  "$(git -C "$C/remotes/ns-file" rev-parse master)"
assert_eq "D: ZERO aws calls" 0 "$(count_matches "$AWS_CALLS" '.')"
assert_eq "D: the remote helper was never invoked" 0 "$(file_lines "$HELPER_CALLS")"
assert_lacks "D: no repair activity logged at all" "$D_LOG" "repair"

echo "=== CASE E — a git-remote-s3 helper for THIS namespace is already running ==="
case_dir caseE ns-busy
NSDIR="$(mk_ns "$C/namespaces" ns-busy 2)"
STALE_SHA="$(git -C "$NSDIR" rev-list --max-parents=0 HEAD | head -1)"
TIP_SHA="$(git -C "$NSDIR" rev-parse HEAD)"
REFKEY="current/git/ns-busy/refs/heads/master"
put_obj "$REFKEY/$STALE_SHA.bundle" "2026-09-18T03:19:00+00:00" 1111
put_obj "$REFKEY/$TIP_SHA.bundle"   "2026-09-16T03:56:00+00:00" 2222
# same argv shape git uses (helper + remote + url) and a real in-flight delay
STUB_HELPER_CALLS="$HELPER_CALLS" STUB_HELPER_SLEEP=25 \
  "$C/home/.local/bin/git-remote-s3" s3dup "s3://$STUB_BUCKET/current/git/ns-busy" \
  >/dev/null 2>&1 &
HELPER_PID=$!
sleep 1
if ! pgrep -f 'git-remote-s3' | grep -q -x "$HELPER_PID"; then
  echo "WARN: the simulated helper (pid $HELPER_PID) is not visible to pgrep — case E assertions are not meaningful"
fi
run_pass "$C" s3dup 's3://stub-bucket/current/git/${name}'
E_LOG="$(file_or "$LOG" "")"
assert_eq "E: the ref path was never listed" 0 \
  "$(count_matches "$AWS_CALLS" "refs/heads/master")"
assert_eq "E: zero mutating aws calls" 0 \
  "$(count_matches_any "$AWS_CALLS" 's3 cp' 's3 rm' 'head-object')"
assert_has "E: repair skipped with a loud log line" "$E_LOG" \
  "repair ns-busy: skipped refs/heads/master (a git-remote-s3 process is already pushing this namespace"
assert_lacks "E: nothing was quarantined" "$E_LOG" "quarantined"
assert_eq "E: both bundles untouched" 2 "$(state_bundles "$REFKEY/" | grep -c . || true)"
kill "$HELPER_PID" 2>/dev/null || true
HELPER_PID=""

echo "=== CASE F — every aws call fails: the repair never fails the pass ==="
case_dir caseF ns-flaky
NSDIR="$(mk_ns "$C/namespaces" ns-flaky 2)"
STALE_SHA="$(git -C "$NSDIR" rev-list --max-parents=0 HEAD | head -1)"
TIP_SHA="$(git -C "$NSDIR" rev-parse HEAD)"
REFKEY="current/git/ns-flaky/refs/heads/master"
put_obj "$REFKEY/$STALE_SHA.bundle" "2026-09-18T03:19:00+00:00" 1111
put_obj "$REFKEY/$TIP_SHA.bundle"   "2026-09-16T03:56:00+00:00" 2222
STUB_AWS_FAIL=1 run_pass "$C" s3dup 's3://stub-bucket/current/git/${name}'
F_LOG="$(file_or "$LOG" "")"
assert_ge "F: the failed list was attempted" "1" "$(count_matches "$AWS_CALLS" 'list-objects-v2')"
assert_has "F: the transient aws error is a log line, not a failure" "$F_LOG" \
  "repair ns-flaky: list failed for refs/heads/master (continuing)"
assert_eq "F: the pass still completed with only the push failure" 1 \
  "$(grep -c -e 'OK: pushed=0 skipped=0 failed=1' <<< "$F_LOG" || true)"
assert_eq "F: the completion stamp is still written" 1 \
  "$(stamp_written "$C/state/s3-git-pass.last")"
assert_eq "F: nothing was deleted while aws was down" 2 \
  "$(state_bundles "$REFKEY/" | grep -c . || true)"

echo "=== CASE G — the quarantine copy lands TRUNCATED: the original must survive ==="
case_dir caseG ns-short
NSDIR="$(mk_ns "$C/namespaces" ns-short 2)"
STALE_SHA="$(git -C "$NSDIR" rev-list --max-parents=0 HEAD | head -1)"
TIP_SHA="$(git -C "$NSDIR" rev-parse HEAD)"
REFKEY="current/git/ns-short/refs/heads/master"
put_obj "$REFKEY/$STALE_SHA.bundle" "2026-09-18T03:19:00+00:00" 1111
put_obj "$REFKEY/$TIP_SHA.bundle"   "2026-09-16T03:56:00+00:00" 2222
STUB_AWS_TRUNCATE_COPY=1 run_pass "$C" s3dup 's3://stub-bucket/current/git/${name}'
G_LOG="$(file_or "$LOG" "")"
assert_eq "G: the copy was attempted" 1 "$(count_matches "$AWS_CALLS" 's3 cp')"
assert_eq "G: the copy was size-checked" 1 "$(count_matches "$AWS_CALLS" 's3api head-object')"
assert_has "G: the mismatch is logged" "$G_LOG" "quarantine size mismatch for $STALE_SHA"
assert_eq "G: the original was NOT deleted" 0 "$(count_matches "$AWS_CALLS" 's3 rm')"
assert_has "G: honest leftover report" "$G_LOG" "repair ns-short: still 2 bundles after repair"
assert_eq "G: both ref-path bundles are still there" 2 "$(state_bundles "$REFKEY/" | grep -c . || true)"
assert_eq "G: the (short) quarantine copy was kept" 1 \
  "$(awk -F'\t' -v k="quarantine/git/ns-short/master/$STALE_SHA.bundle" '$1 == k && $3 == 1110 { print }' "$AWS_STATE" | grep -c . || true)"
assert_eq "G: no quarantine summary line (nothing was pruned)" 0 \
  "$(grep -c -e 'quarantined' <<< "$G_LOG" || true)"

echo "-----"
echo "harness: $n_ok passed, $n_bad failed"
if [ "$n_bad" -gt 0 ]; then exit 1; fi
exit 0
