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

1. `duckbrain.config.json` → `"s3": { "enabled": true, "endpoint": "https://hel1.your-objectstorage.com", "bucket": "duckbrain", "prefix": "duckbrain", "pushOnCommit": true }`
2. Export credentials in the daemon/CLI env: `AWS_PROFILE=duckbrain` (or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`).
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
