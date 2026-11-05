# Operations surface: what is reachable over HTTP, and what is not

Status: decided 2026-11-05 (SURFACE-HTTP-OPS-001).

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

All four append one line to the namespace lifecycle ledger
(`<namespaces>/.s3state/lifecycle.log`) carrying `op`, `surface`, `principal`
and the outcome, which is the ledger REST namespace deletion and S3 clearing
already use.

## CLI-only (decisions)

### `s3 sync`

Safety. A sync mutates the shared bucket under a per-namespace lock that the
CLI holds for the life of the process, and reports progress on its own stderr.
Over HTTP the caller would get no progress and no cancellation: a client that
disconnects leaves the sync holding the lock for the whole deadline, and two
concurrent triggers block each other. The blast radius is the **bucket**, not a
namespace, which the namespace-grant model cannot express. Operators run it on
the host where the credentials and the lock live.

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
