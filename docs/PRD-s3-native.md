# PRD — Native S3 for DuckBrain

| | |
|---|---|
| **Status** | Review — code prepared & inert (branch `feat/native-s3`, commit `ace63c4`) |
| **Version** | 1.0 (2026-08-07) |
| **Owner** | Bane / DuckBrain |
| **Design doc** | `docs/s3-native.md` |
| **Companion** | external backup crons (`duckbrain-s3-daily.sh`, `duckbrain-s3-weekly.sh`) remain active until Phase 1 ships |

---

## 1. Vision

Make S3 a **first-class storage tier inside DuckBrain** — **additive to the
git-based design, never a replacement**: JSONL-in-git stays canonical and fully
operational. Every namespace is continuously, incrementally mirrored to any
S3-compatible bucket; memory is **queryable with SQL straight from the archive**
(no restore); and any other machine can pull a namespace back — giving DR,
multi-host shared memory, and a tamper-evident history without external tooling.
Provider-agnostic by construction: client-side SQL, path-style, custom endpoint.

## 2. Measurable outcomes

| Metric | Today (external crons) | Target (native) |
|---|---|---|
| Recovery point (RPO) | ≤ 24 h (daily push) | ≤ 30 s (`pushOnCommit`) |
| Recovery time (RTO) for one namespace | manual clone + rebuild (10+ min) | `duckbrain s3 pull <ns>` (minutes, no git tools) |
| Query backup w/o restore | impossible | `duckbrain s3 query "SELECT …"` |
| Off-machine coverage | 2 crons, shell scripts | built-in, per-config, one mechanism |
| Ops surface | scripts + cron + log files | `duckbrain s3 status` |

## 3. Problem

1. Backups are **external**: two cron scripts (git-remote-s3 push + tar.xz).
   They work but live outside DuckBrain — no CLI, no status, no config.
2. **RPO is coarse**: a write at 04:00 waits ~24 h for the next push.
3. The archive is **not queryable**: recovering one fact means restoring first.
4. **No multi-host story**: a second machine cannot easily materialize a
   namespace without git tooling and manual steps.
5. Provider lock-in questions unresolved: which S3 providers support SQL
   features (see §7) — the design must work on Hetzner (current) and scale on AWS.

## 4. Personas & jobs

- **Bane (operator)** — "Understand exactly what is backed up, when, and how to get it back. Zero surprise behavior."
- **Hermes agents (writers)** — "My writes are safe within seconds, without me thinking about it."
- **Second host (N100, DR)** — "Pull the state I need with one command."

## 5. Scope

### In (MVP — code prepared)

- Config block `s3` with master switch (`enabled: false` — inert)
- Incremental push of raw files (JSONL + manifest) — delta-only, excludes `.git/*.db/*.parquet`
- Pull (DR restore, no deletions)
- `pushOnCommit` hook on the autocommit batch window (~30 s RPO)
- SQL over S3 via DuckDB `httpfs` on a dedicated connection
- CLI: `duckbrain s3 {status|sync|query|config}`
- Per-namespace manifests + cross-process lock (crash-safe)
- Any S3-compatible endpoint (Hetzner, AWS, MinIO, R2, …) — path-style default

### Deferred (designed, not built)

- MCP tools (`s3_sync` / `s3_query`) — CLI first, MCP after dogfooding
- Squash-to-S3 (parquet partitions pushed on compaction → queryable lake)
- Lifecycle tiering / Glacier (AWS-only), object-lock immutability
- Event-driven sync (bucket notifications → pull on other hosts)
- Athena / S3 Select integration (AWS-only), web UI status panel
- Periodic background sync loop (`intervalSec` reserved in config)

## 6. Functional requirements

| ID | Requirement | Status |
|---|---|---|
| FR-1 | `s3.enabled=false` default; all features inert until flipped | ✅ done (verified: CLI refuses, hook no-ops) |
| FR-2 | Push uploads only new/changed files (size+mtime vs manifest); never `.git`, `*.db`, `*.parquet`, caches | ✅ done + unit tests |
| FR-3 | Pull downloads missing/different files; never deletes local (backup-accumulation semantics) | ✅ done |
| FR-4 | `pushOnCommit` fires a delta push after each autocommit batch flush, fire-and-forget, never blocks writes | ✅ done (guarded) |
| FR-5 | `duckbrain s3 query "SQL"` runs against `s3://` paths via DuckDB httpfs on its OWN connection | ✅ done (singleton-connection quirk documented) |
| FR-6 | `duckbrain s3 status` shows config + per-namespace local/remote counts + last sync | ✅ done |
| FR-7 | Credentials NEVER in config — env `AWS_PROFILE` / `AWS_ACCESS_KEY_ID` / `~/.aws/credentials` | ✅ done |
| FR-8 | Key layout `s3://<bucket>/<prefix>/<ns>/<relPath>`; prefix configurable | ✅ done |
| FR-9 | One sync at a time per host (file lock, 10-min stale expiry) | ✅ done + test |
| FR-10 | Works on Hetzner (path-style, custom endpoint) AND AWS (no endpoint → default) | ✅ done (config) — 🔲 live E2E when enabled |

## 7. Provider SQL matrix (research, 2026-08-07)

| Provider | Client-side SQL (DuckDB httpfs — works everywhere) | Server-side SQL |
|---|---|---|
| **AWS S3** | ✅ | ✅ S3 Select + Athena + S3 Tables |
| **Hetzner Object Storage** | ✅ | ❌ |
| **MinIO** | ✅ | ✅ S3 Select (CSV/JSON/Parquet; parquet behind flag, some bugs) |
| **Ceph RGW** | ✅ | ⚠️ partial (CSV only, limited syntax) |
| **Cloudflare R2** | ✅ | ❌ |
| **Backblaze B2** | ✅ | ❌ |
| **Wasabi** | ✅ | ❌ |
| **Google GCS** | ✅ | ❌ (BigQuery is separate) |
| **Azure Blob** | ✅ | ❌ (Synapse separate) |

**Decision:** the `s3 query` feature is provider-agnostic by construction
(client-side). AWS is the only complete server-side option — relevant only for
Phase 4 big-data scans.

## 8. Architecture (as built)

```
duckbrain s3 sync all push
        │  config.s3 (zod, default disabled)
        ▼
┌─ src/s3/ ─────────────────────────────────────────────┐
│ sync.ts    walkLocal → computeDeltas → put/get loop    │
│            (lock: .s3state/.lock, 10min stale)         │
│ manifest.ts .s3state/<ns>.json {size, mtimeMs}         │
│ client.ts  @aws-sdk/client-s3 (list/put/get/delete)    │
│ query.ts   DuckDB(:memory:) INSTALL/LOAD httpfs        │
│            SET s3_endpoint/region/url_style=path       │
│ cli.ts     status|sync|query|config                    │
└────────────────────────────────────────────────────────┘
  ▲ autocommit.ts flush ── maybeSyncOnCommit() (pushOnCommit)
  │ config/index.ts — s3 block in DuckBrainConfigSchema
```

Data flow (push): write → JSONL append → autocommit batch flush (≤30 s) →
`maybeSyncOnCommit` → walk local, diff vs manifest+remote listing → PUT deltas
→ save manifest. Never touches the namespace DuckDB file (no single-writer
lock conflicts with MCP/HTTP servers).

## 9. Non-functional requirements

- **RPO:** ≤30 s with `pushOnCommit`; ≤1 cycle of the configured interval otherwise
- **RTO:** one command per namespace; no git tooling required on target host
- **Security:** keys never in git-tracked config; bucket scoped per purpose
  (dedicated `duckbrain` bucket + dedicated key, already in place)
- **Durability:** provider SLA; weekly tar.xz + git-bundle layer remains as
  independent belt-and-suspenders during Phase 1–2
- **Cost:** delta-only PUTs; query = GETs (parquet range pruning later)
- **Concurrency:** file lock prevents overlapping syncs; pulls never delete
- **Offline:** sync fails loudly but never blocks writes (hook is fire-and-forget)

## 10. Acceptance criteria

**Phase 0 (prepared — DONE):**
- AC-0.1 `duckbrain s3 status` prints "disabled" with default config
- AC-0.2 `duckbrain s3 sync` refuses to run while disabled
- AC-0.3 autocommit hook no-ops (no network calls) while disabled
- AC-0.4 full suite green (262/262 incl. 8 new s3 tests), `tsc --noEmit` clean

**Phase 1 (activate on Hetzner):**
- AC-1.1 `s3.enabled=true` + `AWS_PROFILE=duckbrain` → `s3 status` lists namespaces with remote counts
- AC-1.2 `s3 sync all push` uploads all namespaces; second run uploads 0 (idempotent)
- AC-1.3 a file deleted locally stays on S3 (no `--delete` semantics)
- AC-1.4 `s3 pull` on a fresh clone of the namespace dir restores all files (diff = empty)

**Phase 2 (pushOnCommit):**
- AC-2.1 a `remember` write appears on S3 within 60 s (30 s debounce + sync)
- AC-2.2 daemon restart mid-sync → next sync resumes cleanly (manifest + stale lock)

**Phase 3 (query):**
- AC-3.1 `s3 query "SELECT count(*) FROM read_json_auto('s3://duckbrain/<ns>/event/<month>/current.jsonl')"` returns the live JSONL row count
- AC-3.2 query works with zero local namespace files present (pure remote)

**Phase 4 (AWS extras — when on AWS):**
- AC-4.1 Athena can query the same prefix (server-side)
- AC-4.2 lifecycle rule moves partitions older than N days to IA/Glacier; query still works after restore

## 11. Rollout plan

1. **Phase 0** — code prepared, inert, reviewed (current state)
2. **Phase 1** — enable on the `duckbrain` bucket (Hetzner) alongside existing crons; run AC-1.x; compare with cron behavior for 1 week
3. **Phase 2** — flip `pushOnCommit`; the daily cron becomes **redundant, not
the design** (kept or retired by choice — the git-based version remains
canonical and operational; keep weekly tar.xz)
4. **Phase 3** — dogfood `s3 query`; decide squash-to-S3
5. **Phase 4** — optional AWS migration for Athena/lifecycle/eventing

## 12. Open questions for Bane

1. Ship MCP tools (`s3_sync`/`s3_query`) in Phase 2, or dogfood CLI first?
2. Should `pull` eventually support `--prune` (delete local files absent remotely) behind an explicit flag, or stay append-only forever?
3. Is squash-to-S3 (queryable parquet lake) in scope for Phase 3?
4. Multi-host pull: automate on the N100 via cron, or manual only?
5. Keep the weekly tar.xz forever, or retire once native push is proven?

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Ceph/botocore quirks (list render bug, key perms) | boto3 pinned venv; raw s3api checks; dedicated keys verified per bucket |
| httpfs extension download requires network on first query | INSTALL wrapped in try/catch; documented; works on the daemon host |
| pushOnCommit load (bundle-style full re-upload avoided) | delta-only PUTs, never git bundles; excluded rebuildables |
| Config drift (secrets in config) | zod schema rejects nothing but policy: keys only via env; review gate |
| S3 cost creep | delta-only + excludes; lifecycle rules in Phase 4 |
