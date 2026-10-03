#!/usr/bin/env bash
# Daily DuckBrain backup → Hetzner S3: git push of all namespaces (full history)
# to s3://<bucket>/duckbrain/current/git/<ns>  (the "running version")
exec "$HOME/.hermes/scripts/duckbrain-s3-push.sh" "current/git" "s3daily"
