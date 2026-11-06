#!/usr/bin/env bash
# restore-proof.sh — BACKUP-RESTORE-PROOF-001
#
# Proves the RESTORE half of the durability story end to end, on real data,
# without touching production objects:
#
#   1. copy N real namespaces into a scratch root (source is read-only)
#   2. hash every syncable file (sha256, sorted) — the baseline
#   3. push them to a THROWAWAY S3 prefix (restore-proof/<utc-stamp>/)
#   4. delete the local tree entirely
#   5. pull with `duckbrain s3 sync all pull` into an EMPTY root — the
#      namespace list is enumerated from the REMOTE prefix, so nothing local
#      can help
#   6. prove equivalence: same namespace list, same file count, and the same
#      sha256 for EVERY synced file (not a sample)
#   7. read a known key through a scratch daemon pointed at the restored tree
#   8. measure restore time/size, print the measured RTO plus a LABELLED
#      projection for namespaces too large to exercise in one run
#   9. delete the throwaway prefix (trap — runs even when the proof fails)
#
# FALSIFIER: `--fault corrupt-one` overwrites one remote object with
# same-length garbage before the pull; `--fault delete-one` removes an object.
# Either way the proof MUST exit 1 and name the divergent/missing file — a
# proof whose control still passes is not a proof.
#
# EXIT: 0 = PASS, 1 = FAIL (mismatch / incomplete restore), 2 = usage or
#       precondition error.
#
# USAGE
#   AWS_PROFILE=duckbrain scripts/restore-proof.sh --namespaces "hermes chat-archive"
#   AWS_PROFILE=duckbrain scripts/restore-proof.sh --namespaces hermes --fault corrupt-one
#
# OPTIONS
#   --namespaces "a b"   namespaces to restore (default: hermes chat-archive)
#   --source-root DIR    namespaces root to copy from (default: $HOME/duckbrain/namespaces)
#   --bucket B           S3 bucket (default: duckbrain)
#   --endpoint URL       S3 endpoint (default: $AWS_ENDPOINT_URL, else Hetzner hel1)
#   --prefix P           remote prefix; MUST start with restore-proof/ (default: restore-proof/<utc>)
#   --work-dir DIR       scratch dir (default: mktemp -d)
#   --port N             scratch daemon port, 28700-28999 (default: random free port)
#   --fault MODE         corrupt-one | delete-one — negative control
#   --keep               keep the work dir AND the remote prefix (debugging only)
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$REPO_ROOT/scripts/proofs/restore-proof-s3.mjs"

NAMESPACES="${RESTORE_PROOF_NAMESPACES:-hermes chat-archive}"
SOURCE_ROOT="${RESTORE_PROOF_SOURCE_ROOT:-$HOME/duckbrain/namespaces}"
BUCKET="${RESTORE_PROOF_BUCKET:-duckbrain}"
ENDPOINT="${RESTORE_PROOF_ENDPOINT:-${AWS_ENDPOINT_URL:-https://hel1.your-objectstorage.com}}"
REGION="${RESTORE_PROOF_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
PREFIX="restore-proof/$(date -u +%Y%m%dT%H%M%SZ)"
WORK_DIR=""
PORT=""
FAULT=""
KEEP=0

say()  { printf '[restore-proof] %s\n' "$*"; }
step() { printf '\n[restore-proof] === %s ===\n' "$*"; }
die()  { printf '[restore-proof] FAIL: %s\n' "$*" >&2; exit "${2:-1}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --namespaces)  NAMESPACES="${2:?}"; shift 2 ;;
    --source-root) SOURCE_ROOT="${2:?}"; shift 2 ;;
    --bucket)      BUCKET="${2:?}"; shift 2 ;;
    --endpoint)    ENDPOINT="${2:?}"; shift 2 ;;
    --prefix)      PREFIX="${2:?}"; shift 2 ;;
    --work-dir)    WORK_DIR="${2:?}"; shift 2 ;;
    --port)        PORT="${2:?}"; shift 2 ;;
    --fault)       FAULT="${2:?}"; shift 2 ;;
    --keep)        KEEP=1; shift ;;
    -h|--help)     sed -n '2,42p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)             die "unknown argument: $1" 2 ;;
  esac
done

PREFIX="${PREFIX%/}"
[ -n "$PREFIX" ] || die "empty --prefix" 2
case "$PREFIX" in
  restore-proof/*) : ;;
  *) die "refusing prefix '$PREFIX' — this proof only writes/deletes under restore-proof/ (production prefixes are off-limits)" 2 ;;
esac
case "$FAULT" in
  ""|corrupt-one|delete-one) : ;;
  *) die "--fault must be corrupt-one or delete-one" 2 ;;
esac

NS_LIST=($NAMESPACES)
[ "${#NS_LIST[@]}" -gt 0 ] || die "no namespaces given" 2

for bin in node sha256sum curl jq rsync; do
  command -v "$bin" >/dev/null || die "missing required tool: $bin" 2
done
[ -d "$SOURCE_ROOT" ] || die "source root not found: $SOURCE_ROOT" 2
for ns in "${NS_LIST[@]}"; do
  [ -d "$SOURCE_ROOT/$ns" ] || die "namespace not found in source root: $SOURCE_ROOT/$ns" 2
done
[ -f "$REPO_ROOT/bin/duckbrain.js" ] || die "bin/duckbrain.js missing (run from a DuckBrain checkout)" 2

if [ -z "$WORK_DIR" ]; then
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/restore-proof.XXXXXX")"
else
  mkdir -p "$WORK_DIR"
  WORK_DIR="$(cd "$WORK_DIR" && pwd)"
fi

if [ -z "$PORT" ]; then
  for _ in $(seq 1 40); do
    cand=$((28700 + RANDOM % 300))
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$cand") 2>/dev/null; then PORT="$cand"; break; fi
  done
  [ -n "$PORT" ] || die "no free scratch port in 28700-28999" 2
fi

SRC_NS="$WORK_DIR/source/namespaces"
RESTORE_NS="$WORK_DIR/restore/namespaces"
CFG_DIR="$WORK_DIR/config"
CFG="$CFG_DIR/duckbrain.config.json"
LOGS="$WORK_DIR/logs"
mkdir -p "$SRC_NS" "$RESTORE_NS" "$CFG_DIR" "$LOGS"
: > "$WORK_DIR/ns-stats.tsv"
: > "$WORK_DIR/push-times.tsv"

DAEMON_PID=""
cleanup() {
  local rc=$?
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  if [ "$KEEP" -eq 0 ]; then
    if ! node "$HELPER" delete-prefix --bucket "$BUCKET" --prefix "$PREFIX" >"$LOGS/cleanup.json" 2>"$LOGS/cleanup.err"; then
      printf '[restore-proof] WARNING: prefix cleanup failed — see %s\n' "$LOGS/cleanup.err" >&2
    fi
    if [ -s "$LOGS/cleanup.json" ]; then
      printf '[restore-proof] cleanup: %s\n' "$(cat "$LOGS/cleanup.json")"
    fi
    case "$WORK_DIR" in
      */restore-proof.*) rm -rf "$WORK_DIR" ;;
      *) printf '[restore-proof] keeping non-temporary work dir %s\n' "$WORK_DIR" ;;
    esac
  else
    printf '[restore-proof] --keep: work dir %s and prefix s3://%s/%s retained\n' "$WORK_DIR" "$BUCKET" "$PREFIX"
  fi
  exit $rc
}
trap cleanup EXIT

cli() { ( cd "$REPO_ROOT" && node bin/duckbrain.js "$@" ); }

printf '{"s3": {"enabled": true, "endpoint": "%s", "region": "%s", "bucket": "%s", "prefix": "%s", "forcePathStyle": true}}\n' \
  "$ENDPOINT" "$REGION" "$BUCKET" "$PREFIX" > "$CFG"

export DUCKBRAIN_CONFIG_PATH="$CFG"
export AWS_ENDPOINT_URL="$ENDPOINT"
export AWS_DEFAULT_REGION="$REGION"
# S3-GIT-007 gives every namespace a 300s wall-clock deadline. Measured, the
# engine transfers objects SEQUENTIALLY at ~0.5-1.4 objects/s, so the shipped
# default aborts any namespace above ~400 objects — reproduced on chat-archive
# (617 objects): "[S3] sync chat-archive timed out after 300s (S3-GIT-007)".
# The proof raises the deadline so the exercise can finish; the default's
# ceiling is recorded in docs/evidence/backup-restore-proof-2026-11-05.md.
export S3_SYNC_NAMESPACE_DEADLINE_S="${S3_SYNC_NAMESPACE_DEADLINE_S:-1800}"

# The same exclusion rules src/s3/sync.ts walkLocal() applies. Keeping them in
# lockstep is what makes "file count" comparable between source and restore.
copy_namespace() { # $1 = ns
  rsync -a \
    --exclude '.git/' --exclude '.s3state/' --exclude '.embeddings/' --exclude 'node_modules/' \
    --exclude '*.db' --exclude '*.parquet' --exclude '*.db.wal' --exclude '*.tmp' --exclude '*.bak' \
    --exclude '.DS_Store' \
    "$SOURCE_ROOT/$1/" "$SRC_NS/$1/"
}

hash_manifest() { # $1 = root, $2 = out
  ( cd "$1" \
    && find . \( -name .git -o -name .s3state -o -name .embeddings -o -name node_modules \) -prune -o \
         -type f ! -name '*.db' ! -name '*.parquet' ! -name '*.db.wal' ! -name '*.tmp' ! -name '*.bak' ! -name '.DS_Store' -print0 \
    | sort -z | xargs -0 -r sha256sum ) > "$2"
}

dir_list() { ( cd "$1" && find . -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' | sort ); }

step "plan"
say "source root : $SOURCE_ROOT"
say "namespaces  : ${NS_LIST[*]}"
say "remote      : s3://$BUCKET/$PREFIX  (throwaway — deleted on exit)"
say "work dir    : $WORK_DIR"
say "fault       : ${FAULT:-none}"
say "sync deadline: ${S3_SYNC_NAMESPACE_DEADLINE_S}s per namespace (shipped default is 300s — see the evidence doc)"

step "1/8 copy the real namespaces into a scratch root (source is read-only)"
for ns in "${NS_LIST[@]}"; do
  copy_namespace "$ns"
  files=$(find "$SRC_NS/$ns" -type f | wc -l)
  bytes=$(find "$SRC_NS/$ns" -type f -printf '%s\n' | awk '{s+=$1} END {printf "%d", s+0}')
  printf '%s\t%s\t%s\n' "$ns" "$files" "$bytes" >> "$WORK_DIR/ns-stats.tsv"
  say "copied $ns: $files files, $bytes bytes"
done

step "2/8 baseline — sha256 of EVERY syncable file before anything moves"
hash_manifest "$SRC_NS" "$WORK_DIR/baseline.sha256"
BASE_COUNT=$(wc -l < "$WORK_DIR/baseline.sha256")
BASE_BYTES=$(awk -F'\t' '{s+=$3} END {printf "%d", s+0}' "$WORK_DIR/ns-stats.tsv")
say "baseline manifest: $BASE_COUNT files, $BASE_BYTES bytes hashed (sha256sum, sorted by path)"

step "3/8 push to the throwaway prefix (pre-restore remote census must be 0)"
PRE_CENSUS=$(node "$HELPER" census --bucket "$BUCKET" --prefix "$PREFIX")
say "remote before push: $PRE_CENSUS"
[ "$(echo "$PRE_CENSUS" | jq -r .objects)" = "0" ] || die "prefix $PREFIX is not empty — refusing to test against stale objects"
PUSH_START=$(date +%s)
for ns in "${NS_LIST[@]}"; do
  ns_start=$(date +%s)
  DUCKBRAIN_NAMESPACES_PATH="$SRC_NS" cli s3 sync "$ns" push 2>&1 | tee "$LOGS/push-$ns.log"
  ns_s=$(( $(date +%s) - ns_start ))
  printf '%s\t%s\n' "$ns" "$ns_s" >> "$WORK_DIR/push-times.tsv"
  say "pushed $ns in ${ns_s}s"
done
PUSH_TOTAL_S=$(( $(date +%s) - PUSH_START ))
POST_PUSH_CENSUS=$(node "$HELPER" census --bucket "$BUCKET" --prefix "$PREFIX")
say "remote after push: $POST_PUSH_CENSUS"
REMOTE_OBJECTS=$(echo "$POST_PUSH_CENSUS" | jq -r .objects)
[ "$REMOTE_OBJECTS" = "$BASE_COUNT" ] || die "remote holds $REMOTE_OBJECTS objects but the baseline has $BASE_COUNT files — the push is not complete"
say "remote object count == baseline file count ($REMOTE_OBJECTS) — PASS"

if [ -n "$FAULT" ]; then
  step "3b/8 INJECT FAULT ($FAULT) — the negative control"
  node "$HELPER" "$FAULT" --bucket "$BUCKET" --prefix "$PREFIX" --ext .jsonl | tee "$LOGS/fault.json"
  say "fault injected; the restore below MUST now fail loudly"
fi

step "4/8 DELETE the local tree"
rm -rf "$SRC_NS"
[ ! -e "$SRC_NS" ] || die "local tree still present after delete"
say "local source tree removed: $SRC_NS does not exist"

step "5/8 restore with 'sync all pull' into an EMPTY root (namespace list comes from the remote)"
PULL_START=$(date +%s)
DUCKBRAIN_NAMESPACES_PATH="$RESTORE_NS" cli s3 sync all pull 2>&1 | tee "$LOGS/pull.log"
PULL_TOTAL_S=$(( $(date +%s) - PULL_START ))
say "restore wall clock: ${PULL_TOTAL_S}s"
grep -E '^\[S3\] pull complete' "$LOGS/pull.log" | sed 's/^/[restore-proof] remote-enumerated: /' || true

step "6/8 prove equivalence — namespace list, file count, per-file sha256"
FAILURES=0
EXPECTED_NS=$(printf '%s\n' "${NS_LIST[@]}" | sort)
RESTORED_NS=$(dir_list "$RESTORE_NS" || true)
if [ "$EXPECTED_NS" = "$RESTORED_NS" ]; then
  say "namespace list: PASS ($(echo "$RESTORED_NS" | tr '\n' ' '))"
else
  printf '[restore-proof] namespace list MISMATCH\nexpected: %s\nrestored: %s\n' "$EXPECTED_NS" "$RESTORED_NS"
  FAILURES=$((FAILURES + 1))
fi

hash_manifest "$RESTORE_NS" "$WORK_DIR/restored.sha256"
REST_COUNT=$(wc -l < "$WORK_DIR/restored.sha256")
if [ "$REST_COUNT" = "$BASE_COUNT" ]; then
  say "file count: PASS ($REST_COUNT files)"
else
  printf '[restore-proof] file count MISMATCH: baseline=%s restored=%s\n' "$BASE_COUNT" "$REST_COUNT"
  FAILURES=$((FAILURES + 1))
fi

if diff -u "$WORK_DIR/baseline.sha256" "$WORK_DIR/restored.sha256" > "$WORK_DIR/hash-diff.txt"; then
  say "per-file sha256 (ALL $BASE_COUNT files): PASS — no differences"
else
  printf '[restore-proof] per-file sha256 MISMATCH — the restore is NOT byte-identical:\n'
  grep -E '^[-+][^-+]' "$WORK_DIR/hash-diff.txt" | head -20
  MISSING=$(grep -cE '^-[^-]' "$WORK_DIR/hash-diff.txt" || true)
  EXTRA=$(grep -cE '^\+[^+]' "$WORK_DIR/hash-diff.txt" || true)
  printf '[restore-proof] divergent manifest lines: baseline-only=%s restored-only=%s\n' "${MISSING:-0}" "${EXTRA:-0}"
  FAILURES=$((FAILURES + 1))
fi
say "(engine state — namespaces/.s3state manifest, *.db/*.parquet caches — is not part of the comparison; walkLocal() never syncs it)"

step "7/8 read a known key through a scratch daemon on port $PORT"
DAEMON_LOG="$LOGS/daemon.log"
(
  cd "$REPO_ROOT" && \
  DUCKBRAIN_NAMESPACES_PATH="$RESTORE_NS" \
  DUCKBRAIN_DATA_DIR="$WORK_DIR/daemon-data" \
  DUCKBRAIN_EMBEDDING_PROVIDER="openai" \
  DUCKBRAIN_EMBEDDING_API_KEY="" \
  NO_COLOR=1 \
  exec node bin/duckbrain.js http --port "$PORT" --auth=none
) >"$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!

# The scratch daemon runs with NO embedding provider (deliberate: the data
# plane must be provable without a paid API), so /health answers 503
# "degraded". Readiness here means the HTTP surface ANSWERS, not that
# embeddings are up — the read below is the actual proof.
UP=0
CODE="000"
for _ in $(seq 1 60); do
  CODE=$(curl -s -o "$LOGS/health.json" -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/health" || true)
  if [ -n "$CODE" ] && [ "$CODE" != "000" ]; then UP=1; break; fi
  kill -0 "$DAEMON_PID" 2>/dev/null || break
  sleep 1
done
if [ "$UP" = "1" ]; then
  say "health: HTTP $CODE $(head -c 220 "$LOGS/health.json")"
else
  printf '[restore-proof] scratch daemon did not answer on port %s — see %s\n' "$PORT" "$DAEMON_LOG"
  FAILURES=$((FAILURES + 1))
fi

if [ "$UP" = "1" ]; then
  curl -s --max-time 20 "http://127.0.0.1:$PORT/api/namespaces" > "$LOGS/namespaces.json"
  DAEMON_NS=$(jq -r '[.namespaces[].name] | sort | join(" ")' "$LOGS/namespaces.json")
  say "daemon namespace census: $DAEMON_NS"
  if [ "$(echo "$DAEMON_NS" | tr ' ' '\n' | sort | tr '\n' ' ')" = "$(echo "$EXPECTED_NS" | tr '\n' ' ')" ]; then
    say "daemon namespace list == restored namespaces: PASS"
  else
    printf '[restore-proof] daemon namespace list differs from the restored set: %s\n' "$DAEMON_NS"
  fi

  READ_NS="${NS_LIST[0]}"
  curl -s --max-time 30 "http://127.0.0.1:$PORT/api/memories?namespace=$READ_NS&limit=5" > "$LOGS/list.json"
  KNOWN_KEY=$(jq -r '[.. | objects | select(has("key")) | .key] | first // empty' "$LOGS/list.json")
  if [ -n "$KNOWN_KEY" ]; then
    READ_CODE=$(curl -s -o "$LOGS/key.json" -w '%{http_code}' --max-time 30 \
      "http://127.0.0.1:$PORT/api/memories/key$KNOWN_KEY?namespace=$READ_NS")
    say "known-key read: GET /api/memories/key$KNOWN_KEY?namespace=$READ_NS -> HTTP $READ_CODE"
    if [ "$READ_CODE" = "200" ] && [ "$(jq -r '.key // empty' "$LOGS/key.json")" = "$KNOWN_KEY" ]; then
      say "known-key read: PASS ($(wc -c < "$LOGS/key.json") bytes served from the restored tree)"
    else
      printf '[restore-proof] known-key read FAILED: HTTP %s body=%s\n' "$READ_CODE" "$(head -c 300 "$LOGS/key.json")"
      FAILURES=$((FAILURES + 1))
    fi
  else
    printf '[restore-proof] could not pick a known key from %s (list response: %s)\n' "$READ_NS" "$(head -c 300 "$LOGS/list.json")"
    FAILURES=$((FAILURES + 1))
  fi
fi
if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
  kill "$DAEMON_PID" 2>/dev/null || true
  wait "$DAEMON_PID" 2>/dev/null || true
fi
DAEMON_PID=""

step "8/8 RTO — measured, plus a LABELLED projection for namespaces too large for one run"
# Per-namespace restore time as the ENGINE reported it (the wall clock above
# also carries CLI startup + remote enumeration).
pull_ms_for() { # $1 = ns → milliseconds, empty when the engine did not report it
  grep -F "[S3] pull $1: " "$LOGS/pull.log" | tail -1 | sed -nE 's/.* in ([0-9]+)ms$/\1/p' || true
}
printf '%-24s %8s %12s %8s %9s %11s\n' namespace files bytes push_s pull_s files_per_s
SLOWEST_NS=""; SLOWEST_FILES=0; SLOWEST_BYTES=0; SLOWEST_MS=0
while IFS=$'\t' read -r ns files bytes; do
  push_s=$(awk -v n="$ns" '$1==n{print $2}' "$WORK_DIR/push-times.tsv" | head -1)
  pull_ms=$(pull_ms_for "$ns")
  case "$pull_ms" in ''|*[!0-9]*) pull_ms=0 ;; esac
  printf '%-24s %8s %12s %8s %9s %11s\n' "$ns" "$files" "$bytes" "${push_s:-?}" \
    "$(awk -v ms="$pull_ms" 'BEGIN{printf "%.1f", ms/1000}')" \
    "$(awk -v f="$files" -v ms="$pull_ms" 'BEGIN{ if (ms>0 && f>0) printf "%.2f", f/(ms/1000); else print "?" }')"
  if [ "$files" -gt "$SLOWEST_FILES" ]; then
    SLOWEST_NS="$ns"; SLOWEST_FILES="$files"; SLOWEST_BYTES="$bytes"; SLOWEST_MS="$pull_ms"
  fi
done < "$WORK_DIR/ns-stats.tsv"
say "MEASURED restore: $BASE_COUNT files, $BASE_BYTES bytes, ${#NS_LIST[@]} namespace(s); wall clock ${PULL_TOTAL_S}s (push ${PUSH_TOTAL_S}s); $FAILURES failing criterion(a)"
if [ "$SLOWEST_MS" -gt 0 ]; then
  say "MEASURED RTO (largest namespace exercised): $SLOWEST_NS — $SLOWEST_BYTES bytes / $SLOWEST_FILES files restored in $(awk -v ms="$SLOWEST_MS" 'BEGIN{printf "%.1f", ms/1000}')s"
fi
PER_OBJ=$(awk -v ms="$SLOWEST_MS" -v f="$SLOWEST_FILES" 'BEGIN{ if (f>0) printf "%.4f", (ms/1000)/f; else printf "0" }')
say "Largest production namespaces under $SOURCE_ROOT (syncable files only):"
PROJ_INPUT=$( cd "$SOURCE_ROOT" \
  && find . \( -name .git -o -name .s3state -o -name .embeddings -o -name node_modules \) -prune -o \
       -type f ! -name '*.db' ! -name '*.parquet' ! -name '*.db.wal' ! -name '*.tmp' ! -name '*.bak' ! -name '.DS_Store' -printf '%s %p\n' \
  | awk '{ n=split($2, a, "/"); ns=a[2]; f[ns]++; b[ns]+=$1 } END { for (k in f) printf "%d %d %s\n", f[k], b[k], k }' \
  | sort -rn | head -3 )
echo "$PROJ_INPUT" | while read -r f b ns; do
  projected=$(awk -v f="$f" -v po="$PER_OBJ" 'BEGIN{ printf "%d", f*po }')
  printf '  PROJECTION (not measured): %-24s %8s files %12s bytes -> ~%ss (~%.1fh) at the measured sequential rate\n' \
    "$ns" "$f" "$b" "$projected" "$(awk -v p="$projected" 'BEGIN{printf "%.1f", p/3600}')"
done
say "projection = files x ${PER_OBJ}s per object (rate measured on the largest namespace above); the sync engine transfers objects SEQUENTIALLY, so per-object latency dominates"

step "result"
if [ "$FAILURES" -eq 0 ]; then
  say "PASS — restore is byte-identical for $BASE_COUNT files across ${#NS_LIST[@]} namespace(s), and a scratch daemon read a known key out of the restored tree."
  exit 0
else
  say "FAIL — $FAILURES criterion/criteria failed. This is the proof doing its job: do not trust a restore until these pass."
  exit 1
fi
