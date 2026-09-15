# DuckBrain → Hetzner S3 backup layers (`scripts/s3/`)

Canonical, versioned copies of the host-side DuckBrain backup scripts that run
from cron. The deployed files live in `~/.hermes/scripts/`; these copies are the
source of truth and must stay **byte-identical** to what is deployed.

| File | Deployed as | Role |
|------|-------------|------|
| `duckbrain-s3-push.sh` | `~/.hermes/scripts/duckbrain-s3-push.sh` | Pushes every namespace repo's full git history to S3 via `git-remote-s3` |
| `duckbrain-s3-unified.sh` | `~/.hermes/scripts/duckbrain-s3-unified.sh` | Single cron entry point; runs the three layers at their own cadence |
| `test-push-backoff.sh` | `~/.hermes/scripts/test-push-backoff.sh` | Hermetic regression harness for the git layer (never touches real S3) |

Not included here (unchanged, still only on the host):
`duckbrain-s3-daily.sh` (`exec duckbrain-s3-push.sh current/git s3daily`),
`duckbrain-s3-native-sync.sh`, `duckbrain-s3-weekly.sh`.

## The layers

`duckbrain-s3-unified.sh` is cron's only entry point (every 15 min, job
`1229f45f3ea4`) and runs three layers with internal cadence:

1. **native delta sync** — every run (`duckbrain-s3-native-sync.sh`).
2. **git-history push** — at most once per 24 h (`duckbrain-s3-daily.sh` →
   `duckbrain-s3-push.sh current/git s3daily` → `s3://duckbrain/current/git/<ns>`).
3. **weekly tar.xz archive** — at most once per 7 d (`duckbrain-s3-weekly.sh` →
   `s3://duckbrain/archives/weekly/`, keeps the newest 12).

A single-instance `flock` on `$STATE_DIR/duckbrain-s3-unified.lock` keeps a
long pass from colliding with the next tick.

## Markers

| File (in `$STATE_DIR`) | Written by | Meaning |
|------------------------|-----------|---------|
| `s3-git-push.last` | `duckbrain-s3-unified.sh` | Epoch of the last git layer **run**. The layer is skipped while `now - value < 86400`. |
| `s3-git-pass.last` | `duckbrain-s3-push.sh` | Epoch of the last **completed pass** (the loop walked every namespace). Bare epoch, atomic write. |
| `s3-weekly-archive.last` | `duckbrain-s3-unified.sh` | Epoch of the last weekly archive (7 d window). |

Since S3-GIT-002 the git layer advances `s3-git-push.last` when the layer
**completed** — either it exited 0, or `s3-git-pass.last` is fresh for this run
(`>=` the epoch captured just before the layer started). A namespace that is
rejected by S3 therefore no longer re-runs the whole ~140-repo pass every 15
minutes; individual failures are handled per-namespace (below) and are still
reported loudly:

```
duckbrain unified S3 backup FAILED components: git-push namespaces: hermes-canopy
```

A pass that never started (e.g. the namespaces root is missing) writes no stamp,
so the marker does **not** advance and the next tick retries.

## Per-namespace state

One small human-readable `key=value` file per namespace per remote:

```
$STATE_DIR/s3-git-ns/<remote-name>/<namespace>.state
```

e.g. `~/.hermes/state/s3-git-ns/s3daily/hermes-canopy.state`:

```
name=hermes-canopy
sha=<local HEAD sha of the last successful push>
refs_hash=<sha256 of refs/heads + refs/tags at that moment>
last_success=<epoch>
last_attempt=<epoch>
fail_count=<consecutive failed attempts>
next_retry=<epoch>
```

* The filename is sanitised (`Hermes DAGger` → `Hermes_DAGger.state`); the real
  name is stored inside as `name=`.
* State is **keyed by remote name** so the same namespace pushed under a
  different remote (different S3 prefix) is never mistaken for up to date.
* Writes are atomic (`tmp` + `mv`), so a reader never sees a partial file.

### Skip / defer rules (git layer)

* **up to date** — `fail_count == 0` and `refs_hash` matches the repo's current
  `refs/heads`+`refs/tags`: no `git push` at all, counted as *skipped*, logged as
  `skip <ns> (up-to-date <sha12>)`. `refs_hash` (not just HEAD) means a new tag
  with an unchanged HEAD is still pushed.
* **deferred** — a previous attempt failed and `next_retry > now`: not attempted,
  counted as *skipped*, logged as
  `defer <ns> (fail_count=N next_retry=<epoch> retry_in_s=N)`.
* **backoff ladder** on each failed attempt:
  `900, 3600, 21600, 86400` seconds (capped at 86400 = 24 h); a success clears
  `fail_count` and `next_retry`.

### Exit code

`duckbrain-s3-push.sh` exits `1` only when an **attempted** push failed —
a deferred or up-to-date namespace is not a failure. That keeps a broken
namespace from turning every tick red while still surfacing real pushes that
fail.

Log lines used by other tooling (kept stable):

```
2026-09-15T10:08:44Z FAIL push <namespace>
2026-09-15T10:08:44Z OK: pushed=N skipped=N failed=N remote_repos=N duration_s=N
duckbrain backup PARTIAL (<subprefix>) — N pushed, M FAILED: <ns...> (log: <path>)
```

## Environment overrides

Every override defaults to the production value, so an unmodified environment
behaves exactly as before. They exist so the harness (and any future migration)
can exercise the real scripts off-production.

| Variable | Used by | Default |
|----------|---------|---------|
| `DUCKBRAIN_S3_NS_ROOT` | push | `$HOME/duckbrain/namespaces` |
| `DUCKBRAIN_S3_STATE_DIR` | push + unified | `$HOME/.hermes/state` |
| `DUCKBRAIN_S3_LOG_DIR` | push | `$HOME/.hermes/backups` |
| `DUCKBRAIN_S3_URL_TEMPLATE` | push | `s3://${BUCKET}/${PREFIX}/${name}` |
| `DUCKBRAIN_S3_SCRIPTS_DIR` | unified | `$HOME/.hermes/scripts` |
| `DUCKBRAIN_S3_SKIP_COMPONENTS` | unified | empty = all three layers run |

`DUCKBRAIN_S3_URL_TEMPLATE` tokens: `${BUCKET}` `${PREFIX}` `${name}` and the
brace forms `{bucket}` `{prefix}` `{name}`. The remote repo count
(`aws s3api list-objects-v2`) is skipped — no AWS call at all — unless the
template is an `s3://` URL.

`DUCKBRAIN_S3_SKIP_COMPONENTS` takes a comma-separated subset of
`native,git,weekly` (e.g. `native,weekly` runs the git layer alone).

## Deploy

The unified script runs every 15 minutes, so **never edit the deployed files in
place** — bash reads a script lazily and an in-place edit can corrupt a run that
is mid-script. Deploy with an atomic inode swap, and check the cron lock first:

```bash
flock -n ~/.hermes/state/duckbrain-s3-unified.lock true   # must succeed (lock free)
for f in duckbrain-s3-push.sh duckbrain-s3-unified.sh test-push-backoff.sh; do
  install -m 0755 "scripts/s3/$f" "$HOME/.hermes/scripts/$f.new"
  cp -p "$HOME/.hermes/scripts/$f" "$HOME/.hermes/scripts/$f.bak-$(date +%s)"
  mv "$HOME/.hermes/scripts/$f.new" "$HOME/.hermes/scripts/$f"
done
cmp scripts/s3/duckbrain-s3-push.sh   ~/.hermes/scripts/duckbrain-s3-push.sh
cmp scripts/s3/duckbrain-s3-unified.sh ~/.hermes/scripts/duckbrain-s3-unified.sh
```

If `flock` fails, a run holds the lock — wait for it to finish and retry.

## Test harness

```bash
bash scripts/s3/test-push-backoff.sh        # repo copy
bash ~/.hermes/scripts/test-push-backoff.sh # deployed copy (byte-identical)
```

38 assertions, one `PASS:`/`FAIL:` line each, exit non-zero if any fail. It is
fully hermetic: all scratch state lives under `$(mktemp -d)`, the namespaces
root / state dir / log dir are redirected through the env overrides above, the
`file://` URL template keeps the AWS object count out of the picture, and the
unified script is driven through `DUCKBRAIN_S3_SCRIPTS_DIR` so the real
`unified → daily → push` chain runs inside the scratch dir. It performs **real**
git pushes to scratch bare remotes (no mocks): two namespaces have a remote, the
third does not and therefore fails for real.

Covered: cold-start failure accounting, up-to-date skipping without any push
attempt (the healthy remotes are deleted so an attempt could not pass),
backoff deferral and ladder growth, forced retry after the window opens, marker
advance on a completed-but-failing pass, loud failure reporting, the weekly
marker staying untouched when a component is skipped, and no re-run inside the
marker window.

Requires `git` and `git-remote-s3` on `PATH` (the push script's own
precondition); it uses an empty `GIT_CONFIG_GLOBAL` so no user config leaks in.
