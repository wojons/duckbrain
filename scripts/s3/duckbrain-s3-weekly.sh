#!/usr/bin/env bash
# Weekly DuckBrain archive → Hetzner S3 (tar.xz snapshot)
# Archives ALL namespace repos (working tree incl. uncommitted data + .git history;
# DuckDB index files *.db / *.parquet excluded — rebuildable) into:
#   s3://duckbrain/archives/weekly/duckbrain-namespaces-YYYY-MM-DD.tar.xz
# Rotation: keeps the newest 12 archives. Verifies remote size == local size
# before deleting the local tarball.
#
# Uses AWS_PROFILE=duckbrain (NOT sourcing ~/.hermes/.env — line 39 has a bare
# token that breaks `source`).
set -euo pipefail

BUCKET="duckbrain"
ENDPOINT="https://hel1.your-objectstorage.com"
export AWS_PROFILE="duckbrain"
ARCHIVE_PREFIX="s3://${BUCKET}/archives/weekly"
LOG_DIR="$HOME/.hermes/backups"
LOG="$LOG_DIR/duckbrain-weekly.log"
KEEP=12
START=$(date +%s)

mkdir -p "$LOG_DIR"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }

if [ ! -d "$HOME/duckbrain/namespaces" ]; then
  echo "FAIL: ~/duckbrain/namespaces does not exist"; log "FAIL: namespaces dir missing"; exit 1
fi
if ! command -v xz >/dev/null 2>&1; then
  echo "FAIL: xz not installed"; log "FAIL: xz missing"; exit 1
fi

NS_COUNT=$(ls "$HOME/duckbrain/namespaces" | wc -l)
if [ "$NS_COUNT" -lt 3 ]; then
  echo "FAIL: namespace count $NS_COUNT looks wrong, aborting"; log "FAIL: ns count $NS_COUNT"; exit 1
fi

STAMP=$(date +%Y-%m-%d)
TARBALL="/tmp/duckbrain-namespaces-${STAMP}-$$.tar.xz"
KEY="duckbrain-namespaces-${STAMP}.tar.xz"

# Snapshot: namespaces (working tree + .git history) + top-level duckbrain config.
# Exclude rebuildable DuckDB index files (*.db, *.parquet) — data lives in JSONL.
tar -cJf "$TARBALL" -C "$HOME/duckbrain" \
  --exclude='*.db' --exclude='*.parquet' --exclude='*.tmp' --exclude='*.bak' \
  namespaces duckbrain.config.json 2>/dev/null \
  || { echo "FAIL: tar.xz creation failed"; log "FAIL: tar.xz creation"; exit 1; }
LOCAL_SIZE=$(stat -c %s "$TARBALL")

# Upload
if ! AWS_PROFILE="$AWS_PROFILE" aws --endpoint-url "$ENDPOINT" s3 cp "$TARBALL" "$ARCHIVE_PREFIX/$KEY" --quiet 2>&1; then
  echo "FAIL: weekly archive upload failed"; log "FAIL: upload $KEY"; rm -f "$TARBALL"; exit 1
fi

# Self-verify: remote size must equal local size
REMOTE_SIZE=$(AWS_PROFILE="$AWS_PROFILE" aws --endpoint-url "$ENDPOINT" s3api head-object --bucket "$BUCKET" --key "archives/weekly/$KEY" --query ContentLength --output text 2>/dev/null || echo 0)
if [ "${REMOTE_SIZE:-0}" != "$LOCAL_SIZE" ]; then
  echo "FAIL: size mismatch local=$LOCAL_SIZE remote=$REMOTE_SIZE"; log "FAIL: size mismatch $KEY local=$LOCAL_SIZE remote=$REMOTE_SIZE"; rm -f "$TARBALL"; exit 1
fi

# Cleanup local tarball once verified
rm -f "$TARBALL"

# Rotation: keep newest $KEEP archives
OLD=$(AWS_PROFILE="$AWS_PROFILE" aws --endpoint-url "$ENDPOINT" s3 ls "$ARCHIVE_PREFIX/" 2>/dev/null | awk '{print $4}' | sort | head -n -"$KEEP" || true)
DELETED=0
for f in $OLD; do
  if [ -n "$f" ] && [[ "$f" == duckbrain-namespaces-* ]]; then
    AWS_PROFILE="$AWS_PROFILE" aws --endpoint-url "$ENDPOINT" s3 rm "$ARCHIVE_PREFIX/$f" --quiet 2>/dev/null && DELETED=$((DELETED + 1))
  fi
done

END=$(date +%s)
DUR=$((END - START))
HUMAN=$(awk -v b="$LOCAL_SIZE" 'BEGIN{printf "%.1f MB", b/1048576}')

log "OK: $KEY size=$LOCAL_SIZE ns=$NS_COUNT duration_s=$DUR rotated=$DELETED"
echo "duckbrain weekly archive OK — $NS_COUNT namespaces, $HUMAN ($KEY), uploaded in ${DUR}s, rotated $DELETED old archive(s)"
