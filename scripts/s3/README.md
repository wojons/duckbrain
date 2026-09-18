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
| `test-duplicate-bundle-repair.sh` | — | hermetic harness for the duplicate-bundle repair (stub `aws` + stub remote helper) |

## Duplicate-bundle ref collisions (self-healed)

`git-remote-s3` stores one bundle per ref **tip**:

```
s3://<bucket>/<subprefix>/<ns>/refs/heads/<branch>/<tipsha>.bundle
```

The directory IS the ref and the filename IS the tip, so normally exactly one
bundle exists. Two racing pushes each write a bundle with a *different* tip sha
under the same ref; from then on every push to that ref is refused and it never
self-heals:

* client side: `error: dst refspec refs/heads/master matches more than one`
* helper side: `! [remote rejected] master (multiple bundles exists on server. Run git-s3 doctor to fix.)`

`duckbrain-s3-push.sh` repairs this itself, per namespace, right before that
namespace's push (inside the wrapper's `flock`; skipped, with a log line, when a
`git-remote-s3` helper is already pushing the same namespace — a concurrent push
could add a third bundle):

1. list the objects under `<url>/refs/heads/<branch>/` and keep the `*.bundle`
   ones — `LOCK#`, `*.lock`, `PROTECTED#` and `.zip` are ignored, exactly as the
   upstream helper does;
2. if more than one bundle exists, the **keeper** is the one whose sha equals the
   local branch tip, else the newest by `LastModified`;
3. every other bundle is copied to
   `s3://<bucket>/quarantine/git/<ns>/<branch>/<sha>.bundle`, the copy's size is
   verified, and only then is the original deleted from the ref path;
4. a bundle whose sha is **not** in the local repo is never deleted (loud
   `repair-skip` line), and if bundles still remain the log says so — the push
   then fails exactly as it did before. A repair is never counted as a pass
   failure, and a non-`s3://` URL template makes zero `aws` calls.

### Rollback

Copy the quarantined object back onto the ref path and the ref is exactly as it
was before the repair:

```bash
AWS_PROFILE=duckbrain AWS_ENDPOINT_URL=https://hel1.your-objectstorage.com \
  aws s3 cp \
  "s3://duckbrain/quarantine/git/<ns>/<branch>/<sha>.bundle" \
  "s3://duckbrain/current/git/<ns>/refs/heads/<branch>/<sha>.bundle"
```

Only while no push is running: afterwards the ref holds two bundles again and
the next pass repairs it again. The same command with the bucket/prefix of the
`archives/git` (weekly) target restores that copy.
