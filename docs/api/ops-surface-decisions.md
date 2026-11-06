# Operations surface: what is reachable over HTTP, and what is not

Status: decided 2026-11-05 (SURFACE-HTTP-OPS-001); amended 2026-11-06
(SURFACE-S3-001) — `s3 sync`, `s3 clear` and `s3 ghosts` moved from CLI-only to
exposed under `/api/ns/:ns/s3`, with the lock contract that answers the reason
this file originally gave for keeping them off HTTP.

DuckBrain's data plane (memories, keys, namespaces, declared tables, the change
feed) is on HTTP. Its **operations** were CLI-only: a remote agent could write
memories but could not run a single maintenance verb. This document is the
decision record for each of those verbs, so the gap cannot drift back silently.
`src/http/routes/ops-surface-parity.test.ts` asserts every line below.

Two outcomes are allowed per verb: **exposed** (a route with the same
implementation the CLI calls) or **CLI-only** (with the security or safety
reason written down). Silence is not an option.

## Exposed

| Verb | Route | Notes |
|------|-------|-------|
| `squash` | `POST /api/compaction/squash` | Admin role. Dry run unless `dryRun: false` **and** `confirm: true`. One lifecycle-ledger line per run. |
| `namespaces prune` | `POST /api/ops/namespaces/prune` | Admin role. Dry run unless `dryRun: false` and `confirm: true`. `residueOnly` supported. Reports mappings before/after, removed count and manifests pruned. |
| `s3 status` | `GET /api/ops/s3/status` | Admin role. Same collector as `s3 status --json` (`collectS3StatusReport`), so the two surfaces cannot disagree. `probe=false` skips the bucket listing. |
| `consolidate` | `POST /api/ops/consolidate` | Admin role. Read-only analysis: per-namespace delta/dedup counts plus the digest text. `date` defaults to yesterday (UTC). |
| `s3 sync` | `POST /api/ns/:ns/s3/sync` | Admin or writer role plus the namespace grant (SURFACE-S3-001). Same `syncNamespace()` engine, lock and deadline watchdog as the CLI. A concurrent trigger is `409 SYNC_IN_PROGRESS`; the response carries the CLI's counts and any per-object failures. |
| `s3 clear` | `POST /api/ns/:ns/s3/clear` | Admin role. Destructive remote-object delete: dry run by default, then `dryRun: false` + `confirm: true` + a `reason`. Disk untouched. |
| `s3 ghosts` | `GET`/`POST /api/ns/:ns/s3/ghosts`, `POST /api/ns/:ns/s3/ghosts/clear` | Listing needs only the namespace grant; the sweep is admin-only, confirm-gated and SCOPED to the namespace in the path. |

All of them append one line to the namespace lifecycle ledger
(`<namespaces>/.s3state/lifecycle.log`) carrying `op`, `surface`, `principal`
and the outcome, which is the ledger REST namespace deletion and S3 clearing
already use.

## CLI-only (decisions)

### `s3 query`

Security and cost. The verb runs an operator-supplied SQL string against the
bucket through DuckDB httpfs with the daemon's own credentials. Over HTTP that
is an arbitrary-SQL surface whose cost (scan volume, egress) the namespace
grant cannot bound and whose credential scope is the host's, not the caller's.
`GET /api/ns/:ns/s3` answers the operational question that motivated most
`query` use ("what is up there?") without handing out the SQL surface.

### `s3 config`

Locality. The verb prints the daemon's resolved store (endpoint, bucket,
prefix, path style) for a human debugging the HOST's configuration. The same
facts are already in every `GET /api/ns/:ns/s3` response (`store`), so a route
would add a second, host-shaped view of the same values — the divergence class
this file exists to prevent.

### `distill-sessions`

Security and locality. The verb reads `~/.hermes/state.db` — a host file that
lives outside every namespace — and writes extracted session records as the
invoking principal. A route would let any admin token ask the daemon to read
arbitrary host files and would attribute session records to the daemon's
principal instead of the caller. It stays a host CLI verb.

### `embeddings rebuild`

Cost and duration. A rebuild calls a paid embedding provider for every uncached
record; it can run for hours and the CLI already supports `--detached` with its
own log. HTTP has no progress or cancel channel, so a request-scoped route would
either pin a connection for the entire rebuild or return "started" with no way
to learn the outcome. Scheduling belongs to cron + CLI.

### `token create` / `token revoke`

Security. Credential minting over the network turns a stolen admin token into
**permanent** admin credentials — the auth store is a host file that outlives
the token that wrote it. Revocation is the emergency-response path and must not
depend on the same credential system being healthy. Both stay on the host CLI.

## Deferred, not denied

`consolidate --write-digest` (the memory POST into namespace `duckbrain`) stays
CLI-only for now: it needs that namespace's write grant plus a durable actor
identity, and a maintenance route should not write memories on the caller's
behalf. It can be exposed once the actor-identity question is settled.

## Superseded decisions

### `s3 sync` — was CLI-only (2026-11-05), now exposed (2026-11-06)

The original decision said a sync holds a per-namespace-root lock for the life
of the process and reports progress on its own stderr, so an HTTP caller that
disconnects would leave the lock held and two concurrent triggers would block
each other. That was measured, not hypothetical, and it is the reason
SURFACE-S3-001 could not simply mount the verb. The route answers it:

- the lock is the same one (`acquireLock`), never bypassed; a second trigger is
  `409 SYNC_IN_PROGRESS` naming the lock instead of queueing or silently
  no-op'ing;
- every run is bounded by the engine's own deadline watchdog
  (S3-DEADLINE-001), so a vanished caller cannot pin the lock past that budget;
- the response carries the counts and the per-object failures the CLI prints,
  so a partial push is visible rather than inferred from a log on another box;
- the namespace grant bounds the blast radius to one namespace's prefix, and
  the request records who ran it in the lifecycle ledger.

What is still NOT provided: streamed progress and mid-flight cancellation.
Those remain CLI affordances; a caller that needs them runs the CLI on the
host. `src/http/routes/s3.test.ts` pins the 409-on-lock behaviour so the
original objection cannot quietly come back.
