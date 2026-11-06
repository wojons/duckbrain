# Native S3 support — design and deployment contract

Status: the native S3 code is merged and configurable. Repository defaults keep
`s3.enabled: false` and `s3.pushOnCommit: false`; a deployment may enable either
setting explicitly. This module adds S3 as a first-class DuckBrain storage tier:
incremental sync, push-on-commit, and SQL over S3 via DuckDB's httpfs extension.

## Why

The external backup stack (git-remote-s3 cron + tar.xz cron) works but lives
outside DuckBrain. Native support gives:

- **~30s RPO when `pushOnCommit: true`** (piggybacks the existing `gitBatching`
  debounce window — no per-write PUTs); when it is false, use the configured
  sync/cron interval instead and do not claim a 30-second recovery point.
- **SQL over the archive**: query namespaces straight from the bucket without
  restoring (`read_json_auto` / `read_parquet` on `s3://` paths)
- **Multi-host memory**: `pull` on another machine = DR + shared memory
- **Provider-agnostic**: any S3-compatible endpoint (Hetzner, MinIO, AWS, …)

## Architecture

```
┌─ src/s3/ ────────────────────────────────────────────────┐
│ config.ts   zod schema (s3 block, mirrors gitBatching)    │
│ client.ts   @aws-sdk/client-s3 wrapper (list/put/get/del) │
│ manifest.ts per-namespace sync state (.s3state/<ns>.json) │
│ sync.ts     walk/diff/push/pull engine + cross-proc lock  │
│ query.ts    DuckDB httpfs SQL runner (OWN connection)     │
│ cli.ts      duckbrain s3 {status|sync|query|config}       │
│ index.ts    exports + maybeSyncOnCommit() hook            │
└───────────────────────────────────────────────────────────┘
```

Key layout: `s3://<bucket>/<prefix>/<namespace>/<relPath>`.
Exclusions: `.git/`, `.embeddings/`, `*.db`, `*.parquet`, `*.tmp`, `*.bak`
(rebuildable or versioned elsewhere). The engine never opens the namespace
DuckDB file → no single-writer lock fights with the MCP/HTTP servers.

Credentials: **never in config** (duckbrain.config.json is git-tracked).
AWS SDK v3 default chain: env `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`,
`AWS_PROFILE` → `~/.aws/credentials`, or default profile. The httpfs query
path reads the same env vars.

## In-daemon auto-push to the canonical `s3daily` remote

Shipped 2026-08-24 (AUTOPUSH-001). The daemon itself pushes each namespace
repo to the git-remote-s3 remote every time a commit flushes — no cron in the
path. This replaces the old 24h daily-cron cadence with an RPO of ~30s: the
push piggybacks the existing `gitBatching` debounce window (`maxSeconds: 30`,
`maxLines: 100` — src/git/autocommit.ts), so every namespace commit is on S3
within roughly 30s of a write, not within 24h.

**Mechanism (quoted from src/git/autocommit.ts):**

The write path commits, then calls the push hook unconditionally
(`asyncCommit`, the serving path):

```ts
// Native S3 push hook — gated by s3.enabled && s3.pushOnCommit (PUSH-001:
// default config = zero pushes), interval-coalesced and single-flight.
// Fire-and-forget: never blocks or fails the write path.
maybeSyncOnCommit(namespacePath);
// AUTOPUSH-001: push the namespace repo to the s3daily remote after each
// commit flush (git-remote-s3 → s3://duckbrain/current/git/<ns>), gated
// by the PUSH-001 config checks, never holding the event loop for the
// bundle + pack-objects duration.
await pushNamespaceAsync(namespacePath);
```

The gate is a pure decision (`evaluatePushGate`): off entirely when
`s3.enabled` or `s3.pushOnCommit` is unset (default config = zero pushes), and
coalesced by the `s3.intervalSec` floor between attempts. Per-namespace state
(single-flight `inFlight`, `lastAttemptAt`, `lastPushedHead`) makes it
skip-unchanged: only a HEAD that moved since the last successful push is
pushed, and a failed push is retried on the next gate-open commit flush. Each
push is bounded at `PUSH_TIMEOUT_MS = 30_000` and runs via `execFile` on the
libuv pool (OPS-006 — the serving path never blocks the event loop on git).

**Remote selection and branch-aware push (`selectPushRemote` /
`buildPushCommand`):**

```ts
return list.includes("s3daily") ? "s3daily" : list[0];
```
```ts
return `git push --set-upstream ${remote} ${branch}`;
```

The canonical remote is `s3daily` (git-remote-s3, duckbrain profile — the path
the daily cron used → `s3://duckbrain/current/git/<ns>`), falling back to the
first configured remote when `s3daily` is absent, and doing nothing when a
namespace has no remote at all. The push is explicitly branch-aware:
namespace repos have no upstream (`git remote` shows only the s3daily
remote), so a bare `git push` would no-op/fail — the daemon resolves the
current branch and pushes `git push --set-upstream s3daily <branch>` so later
bare pushes resolve too.

**⚠️ Required one-time setup per namespace (DF-0925-08).** The auto-push can
only target a remote that EXISTS, and nothing in DuckBrain creates it: a
namespace whose `git remote` is empty (or holds only unrelated remotes) is
silently skipped by `selectPushRemote`, so its git history never reaches S3 —
while the JSONL/manifest half of `pushOnCommit` keeps syncing normally, which
is what makes the gap easy to miss (S3 shows data objects but no git bundles).
Wire the remote once per namespace, relative to `namespacesPath` (config
`namespacesPath`, default `./namespaces`):

```bash
cd namespaces/<ns>                            # <namespacesPath>/<ns>
git remote add s3daily s3://duckbrain/current/git/<ns>
git remote get-url s3daily                    # verify: prints the s3:// URL
```

`git remote add` fails loudly when the remote already exists (`fatal: remote
s3daily already exists`) — treat that failure as the check, not as an error to
work around. Verify with
`git -C <namespacesPath>/<ns> remote get-url s3daily`; a namespace without it
is not being mirrored. This applies to namespaces created through the HTTP/MCP
API too: they exist as directories and are never auto-wired.

**Credentials/endpoint (`buildPushEnv`):** the helper injects `s3.endpoint` as
`AWS_ENDPOINT_URL` and `s3.region` as `AWS_DEFAULT_REGION` (provider-agnostic);
credentials come from the caller's AWS env / `~/.aws`
(`AWS_PROFILE` only forced when `s3.profile` is pinned). Because the injected map
is spread after `process.env`, a config endpoint **replaces** the operator's own
`AWS_ENDPOINT_URL` — export `AWS_ENDPOINT_URL_S3` instead when you need to
override the push endpoint from the shell (the two resolved chains, Path A vs
Path B, are tabulated under *Effective endpoint* above). Without AWS env the
helper dies with "invalid credentials" and the daemon logs + swallows — never
blocks the write.

**Self-heal (OPS-012):** when a push fails with the duplicate-ref signature
over an s3:// remote (two bundles under `refs/heads/<branch>/`), the daemon
quarantines the stale bundles server-side and retries the push exactly once
(`src/git/s3-repair.ts`) — the layer that races the bundle is the layer that
heals, so the git mirror no longer freezes between daily cron runs.

### Root-scoped by design (S3-SCOPE-001)

The auto-push covers ONLY namespace repos under the daemon's own
`namespacesPath` root (config `namespacesPath`, default `./namespaces`).
Namespace writes that land outside that tree — the sandbox/scratch namespaces
dogfood E2E and tests create under temp dirs — never auto-push their git
history: the hook is invoked with the write's namespace path, and a path
outside the configured root simply isn't part of the daemon's walk.
The push cron (`scripts/s3/duckbrain-s3-push.sh`) is also production-root
scoped: it walks `$HOME/duckbrain/namespaces` (`DUCKBRAIN_S3_NS_ROOT`
overrides) by default, so scratch/sandbox namespaces stay ephemeral and are
never auto-pushed — intentionally, per the DB-GAP-043 scratch-isolation
doctrine. For a non-standard deployment the script accepts
`--ns-root <dir>` to walk a different root; with no flag the default is
unchanged. Filed as board row S3-SCOPE-001; ops/dogfood-e2e.sh Phase 6
documents the workaround (drive the same git-remote-s3 push directly on the
sandbox repo).

### Effective endpoint — which layer wins (DOGFOOD-030, DOC-3)

Two independent code paths resolve the S3 endpoint, and they do **not** share the
same precedence. `duckbrain s3 status`, `s3 sync` and `s3 query` all resolve
**in-process**, while the autopush shells out to `git push` (git-remote-s3 →
botocore) with an environment built by `buildPushEnv`. Documenting only the config
key is what makes an env-configured MinIO/Hetzner deployment read the wrong
endpoint.

**Path A — in-process client and the `s3 status` display**
(`resolveEffectiveEndpoint`, `src/s3/config.ts:80`):

| # | Layer | Wins when |
|---|---|---|
| 1 | `AWS_ENDPOINT_URL_S3` | the service-specific env var is set |
| 2 | `AWS_ENDPOINT_URL` | the generic env var is set (and `_S3` is not) |
| 3 | config `s3.endpoint` | neither env var is set |
| 4 | AWS SDK default | nothing above is set — `s3 status` prints `(AWS default)` |

**Path B — the push child** (git-remote-s3 → botocore, env from `buildPushEnv`,
`src/git/autocommit.ts:588`):

| # | Layer | Wins when |
|---|---|---|
| 1 | `AWS_ENDPOINT_URL_S3` | the operator exported it — `buildPushEnv` never sets this variable, so it passes straight through |
| 2 | `AWS_ENDPOINT_URL` ← config `s3.endpoint` | `s3.endpoint` is set: the helper injects it, and because the map is spread *after* `process.env` it also **replaces** the operator's own `AWS_ENDPOINT_URL` |
| 3 | `~/.aws/config` `[<profile>] endpoint_url` | config `s3.endpoint` is absent (the profile is `s3.profile`, injected as `AWS_PROFILE`) |
| 4 | AWS default | nothing above is set |

The asymmetry, stated plainly: an operator who exports `AWS_ENDPOINT_URL` sees a
`status` endpoint sourced from that env var, but the **push child** keeps using
`s3.endpoint`. To redirect the push endpoint from the shell without editing
config, export `AWS_ENDPOINT_URL_S3` — it is the one layer that survives both
paths. (Changing the *display* and the *push* together means setting
`AWS_ENDPOINT_URL_S3`, or leaving both env vars unset and editing `s3.endpoint`.)

Measured live (2026-09-20) against `botocore 1.42.59` — the library git-remote-s3
calls — with the shipped config value
`s3.endpoint = https://hel1.your-objectstorage.com`:

| Env in the shell | `s3 status` shows (Path A) | push child uses (Path B) |
|---|---|---|
| nothing set | `hel1.your-objectstorage.com` (config) | `hel1.your-objectstorage.com` |
| `AWS_ENDPOINT_URL=generic` | `generic` | `hel1...` — operator var masked by config |
| `AWS_ENDPOINT_URL_S3=svc` | `svc` | `svc` — passes through |
| both env vars set | `svc` | `svc` |

Reproducer (no credentials needed — the `endpoint:` line prints before the
per-namespace bucket listings, so the unreachable probe host only produces
`list failed` warnings after the line you are checking):

```bash
cd /path/to/duckbrain
AWS_ENDPOINT_URL=https://probe.example.com npx tsx bin/duckbrain.ts s3 status | grep endpoint
AWS_ENDPOINT_URL_S3=https://svc.example.com npx tsx bin/duckbrain.ts s3 status | grep endpoint
```

### Live verification (2026-09-20, read-only)

- `git -C ~/duckbrain/namespaces/coding-hermes remote` → `s3daily` (the
  canonical remote is configured on real namespaces);
  `remote get-url s3daily` → `s3://duckbrain/current/git/coding-hermes`
  (git-remote-s3 helper, matching the quoted mechanism).
- `git rev-parse --abbrev-ref HEAD` → `master` — the branch the daemon would
  push via `git push --set-upstream s3daily master`.
- 153 namespace directories live under `~/duckbrain/namespaces` (the
  daemon's namespacesPath), i.e. the auto-push's root-scoped coverage set.
- Current prod daemon config: `s3.enabled: true` with `pushOnCommit: false`
  (`duckbrain.config.json`) — the hook is wired and verified live in
  watcher/autocommit-push-gate.test.ts, but the deployed daemon currently
  leaves the daily cron as the active push layer; flipping
  `pushOnCommit: true` is what activates the ~30s RPO path documented above.
- Nothing in the codebase resolves `s3daily` outside `src/git/autocommit.ts`
  and the daily push script — the daemon path and the cron path converge on
  the same remote.

## SQL over S3 — what actually works where

Two very different mechanisms:

**1. Client-side SQL (DuckDB httpfs) — WORKS ON EVERY S3-COMPATIBLE PROVIDER.**
DuckDB reads the objects (regular GETs) and queries them locally. This is what
`duckbrain s3 query` uses. Any provider with a plain S3 API works: AWS,
Hetzner Object Storage, Cloudflare R2, Backblaze B2, Wasabi, MinIO, Ceph RGW,
GCS-interop, Azure-anywhere-S3, … No provider-side feature needed. Cost: the
objects are transferred (GETs); parquet gives column/row-group pruning via
range requests.

**2. Server-side SQL (provider computes on its side) — provider-dependent:**

| Provider | Server-side SQL | Notes |
|---|---|---|
| AWS S3 | ✅ **S3 Select** (SQL per object: CSV/JSON/Parquet) + **Athena** (SQL across objects/buckets) + **S3 Tables** (2024: queryable tables) | full ecosystem |
| MinIO | ✅ **S3 Select** (CSV/JSON/Parquet; parquet needs `MINIO_API_SELECT_PARQUET`; some bugs) | self-hosted |
| Ceph RGW | ⚠️ **partial S3 Select** (CSV only, limited SQL syntax, no semicolons) | version-dependent |
| Hetzner Object Storage | ❌ none | S3-compatible API only |
| Cloudflare R2 | ❌ none | (Workers can query, but not S3 Select) |
| Backblaze B2 | ❌ none | |
| Wasabi | ❌ none | |
| Google GCS | ❌ no S3 Select | (BigQuery is a separate product, not the S3 API) |
| Azure Blob | ❌ no S3 Select | (Synapse/ADX are separate) |

**Takeaway:** the DuckBrain `s3 query` feature works on Hetzner today
(client-side httpfs). AWS adds server-side pushdown (Athena/S3 Select) for
big-data scans without transferring everything.

## Activation checklist (when ready)

1. `duckbrain.config.json` → `"s3": { "enabled": true, "endpoint": "https://s3.<your-region>.your-provider.com", "bucket": "my-duckbrain", "prefix": "duckbrain", "pushOnCommit": true }`
2. Export credentials in the daemon/CLI env: `AWS_PROFILE=<your-profile>` (or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`).
3. Wire each namespace's git mirror ONCE — the auto-push is a no-op without it (DF-0925-08): `git remote add s3daily s3://duckbrain/current/git/<ns>` inside `<namespacesPath>/<ns>`, verified with `git -C <namespacesPath>/<ns> remote get-url s3daily`.
4. `duckbrain s3 status` → verify listing works (and that your namespaces appear).
5. `duckbrain s3 sync all push` → first full push.
6. `duckbrain s3 query "SELECT count(*) FROM read_json_auto('s3://duckbrain/<ns>/event/2026-08/current.jsonl')"` → SQL over S3.
7. Restart the MCP/HTTP daemon so autocommit picks up `pushOnCommit`.

## Fresh-machine DR restore

`pull` restores from the bucket, not from local state. On a machine whose
`namespaces/` root is empty or absent (DF-0925-07):

- `duckbrain s3 sync <ns> pull` BOOTSTRAPS: it creates the missing namespace
  dir and downloads the namespace's files. (Push on a missing namespace still
  fails loudly — there is nothing local to push.) Bootstrap is data-only: the
  `namespaceMappings` config registry is NOT touched (use
  `duckbrain namespace create <ns>` if you want it registered).
- `duckbrain s3 sync all pull` enumerates the REMOTE prefix
  (`listRemoteNamespaces`) and unions it with the local namespace dirs, so a
  fresh machine restores every namespace that exists on S3. The summary
  prints per-namespace downloaded counts; if the remote prefix holds
  namespaces but ALL restores fail, the CLI prints a loud warning and exits
  nonzero — a restore is never a silent zero.

### Restore proof and measured RTO (2026-11-05)

`scripts/restore-proof.sh` exercises this path end to end against a throwaway
prefix (`s3://<bucket>/restore-proof/<utc-stamp>/`, deleted on exit): copy real
namespaces → sha256 every syncable file → push → **delete the local tree** →
`sync all pull` into an empty root → compare the namespace list, the file
count and the sha256 of EVERY file → read a known key through a scratch
daemon. `--fault corrupt-one|delete-one` is the negative control: the proof
must fail loudly when one remote object is altered or removed.

Measured on 2026-11-05 (Hetzner hel1, `hermes` + `chat-archive`, 631 files /
159 MB): pull 287 s, push 342 s, every file byte-identical, known key served
HTTP 200 from the restored tree. Largest namespace exercised, `chat-archive`
(617 files / 156 MB): **4.6 min restore**. Throughput is ~2 objects/s because
transfers are sequential — projected (not measured) `scheduler` (258k objects)
≈ 32 h, `fleet-quality` (29k) ≈ 3.6 h. Full transcript, controls and the two
defects found (the 300 s per-namespace deadline, and `pull` reporting success
on a corrupted object) are in
[docs/evidence/backup-restore-proof-2026-11-05.md](evidence/backup-restore-proof-2026-11-05.md).

> **Fixed by S3-DEADLINE-001:** `S3_SYNC_NAMESPACE_DEADLINE_S` used to be a
> total wall-clock cap, which made every namespace above ~560 objects
> unrestorable with shipped defaults (570 of 617 objects landed before the
> abort). It is now the **no-progress window** the watchdog enforces (re-armed
> per completed object) and the floor of a **work-derived total allowance**
> (`syncDeadlineBudgetSeconds`), while transfers run in a bounded pool of 8
> (`S3_SYNC_CONCURRENCY`) instead of strictly sequentially. A stuck namespace
> still aborts, nonzero, naming the namespace and the progress it reached; a
> merely large one finishes.

### Pull verifies what it restores — and the backup carries its own checksums (S3-PULL-INTEGRITY-001)

Until 2026-11-06 a pull wrote whatever bytes `GetObject` returned. A remote
object overwritten with same-length garbage was restored, the pass printed
`0 failed`, and a scratch daemon served the corrupt content — the proof's
sha256 comparison found it, the ENGINE did not.

Every downloaded body is now verified **before** it is written, strongest
evidence first:

1. **listing size** — a body whose length differs from the object's listed size
   was truncated or extended in transit;
2. **checksum ledger** — `<prefix>/<ns>/.s3state/checksums.json`, published by
   the push that uploaded the objects, records our own sha256 (and the ETag
   observed then) for every file. Checked first, because it is the only
   authority that catches a server-side overwrite: such an object carries a
   *self-consistent* ETag (the bucket derives it from whatever bytes it holds
   now), so an md5 tier alone passes it;
3. **single-part ETag** — an ETag without a `-` is the object's md5 (transport
   and at-rest integrity for objects we hold no ledger entry for; multipart
   ETags are composites and are never treated as checksums);
4. **local manifest sha256** — usable only while the listing's ETag still equals
   the ETag recorded with it (the version token proves the hash describes the
   object we just fetched; a changed token means it does not).

A **mismatch** is a failure, not a warning: the object key is named, the bytes
are never written (a pre-existing local file is left untouched, never
overwritten with unverified content), `s3 sync` exits nonzero, and the
namespace appears in the `sync all` failure list with its key.

**Objects restored with no checksum evidence are counted, not trusted.** The
honest answer for a fresh machine that has neither an ETag nor a ledger entry
(multipart ETag, or a namespace pushed before the ledger existed) is that the
bytes cannot be proven. They are still restored — a DR restore must run on a
machine that has nothing — but the per-namespace line carries
`unverified=<n>`, each key is listed (first 20), and the pass warns that the
bytes are trusted, not proven. The escape from that state is one push: the
next `s3 sync <ns> push` publishes the ledger, after which restores verify
every object.

A push whose ledger cannot be uploaded is a **failed push** (nonzero exit,
key named): the objects would be restorable but unverifiable, and the next pull
would have to say so at the worst possible moment. The ledger is metadata — it
does not change file counts, is never restored as a data file, and `walkLocal`
never syncs a local `.s3state`.

### Pull also verifies what NEVER ARRIVES (S3-PULL-COMPLETENESS-001)

Verification above covers bytes that arrive. An object that was deleted (or
never landed) remotely produces no download at all, so the per-object loop
never sees it: `scripts/restore-proof.sh --fault delete-one` removed one
object, the engine reported success, and only the proof's own file-count /
sha256 comparison noticed afterwards.

The ledger makes completeness decidable without a network round-trip per path.
When a namespace's checksum ledger is present, every path it lists is compared
against the remote listing **before anything is written**:

- **ledger path + no object in the remote listing = failure** (`kind:
  missing`). The key is named with the ledger's size/sha256, `s3 sync` exits
  nonzero, `sync all` counts the namespace as failed, and nothing local is
  written **or deleted** — a missing remote object never removes the copy that
  is already on disk. The fix is a push of that namespace, which re-uploads
  objects absent remotely (`computeDeltas` uploads any local file with no
  remote object).
- **no ledger = no completeness claim.** Nothing can be compared, so the pull
  restores what the listing offers and prints that it CANNOT claim completeness
  (an absent object is indistinguishable from one that was never pushed).
  `checksumLedger: "absent"` in the stats and the warning are the signal; one
  push publishes the ledger.

This is why the ledger is published by every push and why a failed ledger
upload fails the push: without it, a restore can only prove what it received,
never that it received everything.

A restored namespace arrives **data-only**: JSONL + manifest files. Git
history never travels through S3 objects, so the restored namespace has no
`.git` until tracking is reinitialized (matches the daemon's own identity,
src/git/autocommit.ts):

```bash
for d in namespaces/*/; do (cd "$d" && git init -q \
  && git config user.email "duckbrain@localhost.localdomain" \
  && git config user.name "DuckBrain" \
  && git add -A && git commit -q -m "restore: reinit tracking after S3 pull" || true); done
```

The empty-commit `|| true` covers namespaces with zero files (an empty repo
is fine — the daemon's first write path re-runs init/commit itself). The full
paste-able sequence (clone → pull → git reinit → serve) is in
[README.md → Fresh-machine DR restore](../README.md#fresh-machine-dr-restore-paste-able).

### Freshness: a stale mirror used to look complete (S3-SYNC-STOPPED-001)

The mirror went **eight days** without a push (2026-10-28 → 2026-11-05) while
every surface read green, and nothing in the product could have said otherwise:

- `s3 status` printed `lastSync=<timestamp>` — a fact nobody compares to a
  clock, and one the **pull** writes too, so a restore made a host look freshly
  pushed;
- no surface counted the files written since that timestamp;
- `pull` checked completeness against the checksum ledger published by the
  **same** stale push, so a mirror that had not moved since October was
  indistinguishable from a current one. Pulling `hermes` into an empty tree
  restored 6 objects, reported `downloaded=6 skipped=0`, and exited 0 while the
  live namespace held 14 syncable files and 271 records.

Three facts are now recorded and reported.

**Push record** — `.s3state/<ns>.push.json`, written by every push:

```json
{ "version": 1, "ns": "hermes", "lastPushAt": "2026-11-06T18:36:36.259Z",
  "lastPushAttemptAt": "2026-11-06T18:36:36.259Z", "lastPushOk": true,
  "uploaded": 14, "skipped": 0, "failedUploads": 0, "failures": 0 }
```

`lastPushAt` advances **only on a clean pass** (every planned object uploaded
and the checksum ledger published). A pass with a failed PUT keeps the previous
clean time, so "how stale is the mirror" cannot be improved by a failed push.

**Pass record** — `.s3state/last-push-run.json`, written by every
`sync all push`:

```json
{ "version": 1, "command": "sync all push", "startedAt": "...",
  "finishedAt": "...", "ok": true, "attempted": 294, "succeeded": 294,
  "failed": 0, "uploaded": 1528, "error": null }
```

`finishedAt: null` means the pass **started and never wrote a terminal state**
(killed, hung, host died) — the difference between "the schedule is firing" and
"the schedule fired once, in October".

**`s3 status` reports both** — per namespace the age of the last clean push,
whether the last attempt failed, and how many local files that push does not
cover (named in the JSON path):

```
Last pushed run: ok at 2026-11-06T19:02:11Z (3m ago) attempted=294 succeeded=294 failed=0 uploaded=1528
  hermes: local=14 remote=15 lastSync=2026-11-06T18:36:35.597Z lastPush=2026-11-06T18:36:36.259Z (4s ago) unpushed=0
```

A file counts as unpushed when it was written after the last clean push, when
no sync manifest covers it (nothing ever confirmed it exists remotely), or when
the host has neither a push record nor a manifest (nothing can testify that any
of the tree reached the mirror). One walk feeds both `local=` and the freshness
number, so the scheduler namespace's 258k files are stats, not reads.

**Pull refuses a mirror older than the tree.** With a local sync manifest
present, `pull` is now a pre-flight check as well as a transfer:

- a local syncable file written **after** `manifest.lastSyncAt` → failure
  `kind: stale`, the file is named, **nothing is downloaded**;
- a local path with **no object** in the remote listing → failure
  `kind: unpushed`, named the same way.

Both make the command exit nonzero and name the files a restore would lose
(`failed=22` for `hermes` on 2026-11-06, exit 22). A tree with no manifest — the
fresh-machine restore — is deliberately **not** gated: it has no claim about
what the mirror should contain, and the pull is the authority there.

### The schedule is a systemd timer, not a memory

`ops/systemd/duckbrain-s3-sync.service` runs
`scripts/s3/duckbrain-s3-sync-all.sh`, which `exec`s
`node --import tsx bin/duckbrain.ts s3 sync all push` from the checkout (source,
not `dist/`: a scheduled backup must run the code that is in the repo). The
timer fires **one hour after the previous pass finished** (`OnUnitInactiveSec`),
so a slow pass delays the next one instead of stacking, and systemd will not
start a oneshot that is still running. There is no wall-clock kill: the engine's
per-namespace stall watchdog is what detects a hang (S3-DEADLINE-001).

```bash
cp ops/systemd/duckbrain-s3-sync.service ops/systemd/duckbrain-s3-sync.timer \
   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now duckbrain-s3-sync.timer
systemctl --user list-timers duckbrain-s3-sync.timer     # next fire
journalctl --user -u duckbrain-s3-sync.service -f        # one line per namespace
```

The timer is the durable schedule; `.s3state/last-push-run.json` is the
authority on whether it actually ran (a timer that fires into a failing pass
still looks scheduled — check the record, not the unit).

### Alerting on a stale mirror

Two aggregate gauges on `GET /metrics` (no namespace label — names are user
data, and the store holds ~300 of them; the per-namespace breakdown is `s3
status`):

```
duckbrain_s3_last_push_age_seconds   age of the OLDEST clean push; +Inf when a
                                     namespace has no clean push on record
duckbrain_s3_unpushed_files          local syncable files the last clean push
                                     does not cover, across all namespaces
```

```yaml
- alert: DuckbrainS3MirrorStale
  expr: duckbrain_s3_last_push_age_seconds > 7200
  for: 10m
  annotations:
    summary: "DuckBrain S3 mirror is {{ $value }}s behind (schedule stopped?)"
- alert: DuckbrainS3BacklogGrowing
  expr: duckbrain_s3_unpushed_files > 5000
  for: 30m
```

Both are sampled at collect time from the same root (5-minute reuse window, one
stat-walk of the store); a walk that cannot finish publishes **no sample**
rather than a partial count, so a missing series means "unmeasured", never
"fresh".

## Namespace deletion — delete-disk vs clear-s3

Deletion is TWO separate operations (`src/namespaces/lifecycle.ts`): removing the local copy and destroying the remote S3 objects. Never conflate them.

| | `namespace delete-disk` (alias: `s3`-less `delete --force`) | `namespace clear-s3` / `s3 clear` | `s3 ghosts [--sweep]` |
|---|---|---|---|
| Touches | local namespace dir (git repo + JSONL + embeddings), config `namespaceMappings` entry, per-ns sync manifest `.s3state/<ns>.json` | every S3 object under `<prefix>/<ns>/` (delta sync objects + git bundle layers) | ghost sync manifests + ghost mappings only (state files) |
| S3 objects | **KEPT** (retrievable via pull / git clone) | **DESTROYED** | untouched |
| Local disk | deleted | untouched | untouched |
| Gates | `--force` required; refuses while a push is in flight; active-namespace guard; audited (who/why JSONL in `.s3state/lifecycle.log`) | `--dry-run` default; `--yes --requested-by=<who> --reason=<why>` to execute; re-lists the prefix at execution time (TOCTOU-safe); audited | sweep: `--yes --requested-by=<who>`; audited |
| Result | scheduled pushes stop for the namespace | remote copy gone (restore only from backups) | dead namespaces stop failing every push cadence |

### Semantic change of plain `namespace delete`

`namespace delete <ns> --force` formerly took a `--purge` boolean and destroyed the remote copy. It now means **disk-only** — identical to `delete-disk`; S3 objects are kept. `delete <ns> --force --purge` survives as a legacy alias running the same disk-only code path, kept so old scripts don't silently change meaning — but that means scripts written against the old behavior **silently preserve S3 state**. Move remote destruction to `clear-s3` explicitly.

### Checking for and resolving "s3 ghosts"

An *S3 ghost* is object/manifest state that outlives its namespace: S3 objects with no live local namespace, or (the push-failure class) sync manifests / config mappings whose namespace dir is gone — these keep dead namespaces on every push cadence with "Namespace not found"/ENOENT retries.

```bash
duckbrain s3 ghosts            # list ghost manifests + ghost mappings (read-only)
duckbrain s3 ghosts --sweep --yes --requested-by=<who> [--reason=<why>]
                               # prune the ghost state (S3 objects untouched)
duckbrain namespace clear-s3 <ns> --dry-run   # enumerate remaining S3 objects for a namespace
                               # (empty plan + deleted locally = the namespace is fully gone)
```

Note: the in-flight-push guard and lifecycle audit are CLI-only — REST `DELETE /api/namespaces/:name` and MCP `delete_namespace` use the shared core without them; prefer the CLI for operator deletions.

## Pitfalls baked in

- ⛔ httpfs on its OWN connection — the singleton connection strips extensions
  (VSS crash bug); `query.ts` creates a fresh in-memory Database.
- `INSTALL httpfs` needs network on first use (extension download).
- DuckDB `s3_endpoint` wants the host WITHOUT scheme; `s3_url_style='path'`
  required for Hetzner/MinIO-style endpoints (hence `forcePathStyle`).
- Push is delta-only; pull never deletes (backup-accumulation semantics).
- `@aws-sdk/client-s3` added to dependencies (2026-08-07).
