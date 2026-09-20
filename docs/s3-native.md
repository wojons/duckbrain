# Native S3 support — design (prepared, NOT activated)

Status: **code prepared 2026-08-07, inert by default** (`s3.enabled: false`).
This module adds S3 as a first-class DuckBrain storage tier: incremental
sync, push-on-commit, and SQL over S3 via DuckDB's httpfs extension.

## Why

The external backup stack (git-remote-s3 cron + tar.xz cron) works but lives
outside DuckBrain. Native support gives:

- **~30s RPO** via `pushOnCommit` (piggybacks the existing `gitBatching`
  debounce window — no per-write PUTs)
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

**Credentials/endpoint (`buildPushEnv`):** endpoint and region derive from the
user's s3 config block (provider-agnostic — `AWS_ENDPOINT_URL`,
`AWS_DEFAULT_REGION`); credentials come from the caller's AWS env / `~/.aws`
(`AWS_PROFILE` only forced when `s3.profile` is pinned). Without AWS env the
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
outside the configured root simply isn't part of the daemon's walk. The cron
push script (`scripts/s3/duckbrain-s3-push.sh`) is the general mechanism: it
pushes EVERY namespace repo including sandbox ones. Filed as board row
S3-SCOPE-001; ops/dogfood-e2e.sh Phase 6 documents the workaround (drive the
same git-remote-s3 push directly on the sandbox repo).

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
3. `duckbrain s3 status` → verify listing works.
4. `duckbrain s3 sync all push` → first full push.
5. `duckbrain s3 query "SELECT count(*) FROM read_json_auto('s3://duckbrain/<ns>/event/2026-08/current.jsonl')"` → SQL over S3.
6. Restart the MCP/HTTP daemon so autocommit picks up `pushOnCommit`.

## Pitfalls baked in

- ⛔ httpfs on its OWN connection — the singleton connection strips extensions
  (VSS crash bug); `query.ts` creates a fresh in-memory Database.
- `INSTALL httpfs` needs network on first use (extension download).
- DuckDB `s3_endpoint` wants the host WITHOUT scheme; `s3_url_style='path'`
  required for Hetzner/MinIO-style endpoints (hence `forcePathStyle`).
- Push is delta-only; pull never deletes (backup-accumulation semantics).
- `@aws-sdk/client-s3` added to dependencies (2026-08-07).
