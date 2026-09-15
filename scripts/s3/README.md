# Deployment note — scripts/s3/

**These scripts are DuckBrain deployment helpers, not part of the product.**

They contain values specific to ONE deployment (the original author's host):
the Hetzner Object Storage endpoint, the `duckbrain` AWS profile name, and
the `s3://duckbrain` bucket layout. They are tracked here as the reviewable,
versioned source of the ops crons on that host ("Deployed as" below) — not as
a general-user feature.

## Using them for your own deployment

Every deployment-specific value is an env var — override, don't edit:

| Hardcoded default | Override via |
|---|---|
| `AWS_PROFILE=duckbrain` | `AWS_PROFILE=<your-profile>` |
| `AWS_ENDPOINT_URL=https://hel1.your-objectstorage.com` | `AWS_ENDPOINT_URL=<your-endpoint>` |
| bucket `duckbrain` / layout `current/git`, `duckbrain/<ns>` | `BUCKET=<your-bucket>` (prefix constants at top of each script) |

In-product equivalent: the daemon's `s3.*` config block (`endpoint`,
`region`, `bucket`, `prefix`, optional `profile`) drives the built-in
auto-push (`src/git/autocommit.ts` → `buildPushEnv`) — provider-agnostic by
construction. These scripts predate that path and are kept for the cron
workflow on the origin host.

| File | Deployed as | Role |
|------|-------------|------|
| `duckbrain-s3-push.sh` | cron (daily/weekly) | full git-history push of every namespace repo |
| `duckbrain-s3-unified.sh` | cron (15 min) | merged native-sync + raw-sync pass |
| `test-push-backoff.sh` | — | hermetic harness (real `file://` pushes, no mocks) |
