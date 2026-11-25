# HARDEN-DUCKBRAIN-001 gate audit refresh — Gates A/B live probes (2026-11-25, attempt 2)

Scratch daemon: `node bin/duckbrain.js http --port 28777 --auth=apikey` with
`DUCKBRAIN_NAMESPACES_PATH=/tmp/gate-audit-20261125-fm0839/namespaces` and
`DUCKBRAIN_AUTH_FILE=/tmp/gate-audit-20261125-fm0839/auth.json`. Build verified first
(`pnpm run build:cli`, `node bin/duckbrain.js http --help` → BUILD_OK). Daemon killed after the run.

Header correction: the brief's `Authorization: Bearer <key>` form 401s on every data route —
the apikey backend reads only `x-api-key` (src/auth/middleware.ts:201). /health accepts Bearer
only because authMiddleware exempts that path. All probes re-run with `x-api-key`.
Credential note: the prior attempt's keyHashes were unrecoverable; the three scratch principals
were re-minted as sha256(literal name) with roles/namespaces/tableGrants preserved exactly
(gate-write-only=writer+widgets:write, gate-read-only=analyst+widgets:read, gate-admin=admin).

## Gate A — table-grant enforcement (probe results)

| Probe | Request | Expected | Actual | Pass |
|---|---|---|---|---|
| A1 | GET rows as gate-write-only | 403 code FORBIDDEN (no read grant) | 403 `{"error":"Forbidden: principal 'gate-write-only' has no read grant for table 'widgets'","code":"FORBIDDEN"}` | PASS |
| A2 | GET rows as gate-read-only | 200 | 200 `[{\"id\":1,\"label\":\"admin-update\"},{\"id\":2,\"label\":\"admin-row\"}]` | PASS |
| A2 | PATCH ?pk=eq.1 as gate-read-only | 403 lacks 'tables.write' | 403 `{"error":"Forbidden: principal 'gate-read-only' lacks grant 'tables.write'","code":"FORBIDDEN"}` | PASS |
| A2 | DELETE ?pk=eq.2 as gate-read-only | 403 lacks 'tables.write' | 403 (same message, code FORBIDDEN) | PASS |
| A3 | table jsonl hash before vs after denials | IDENTICAL | pre = post = `53fd1b3bfa54a5f8dd31a53ba1fcf6b3d63b55b6dda8b2b6f1c7c2982b9eefc9` | PASS |
| A3 | namespace audit ledger carries denials | real rows, not marker-less | `gateaudit-a/_audit/current.jsonl` rows: 08:54:30.331Z tables.read/gate-write-only/table_grant; 08:54:30.381Z + .389Z tables.write/gate-read-only/role | PASS |
| A4 | PATCH ?pk=eq.1 as gate-admin | 200 `{"updated":1}` + durability headers | 200 `{"updated":1}`, `X-Durability: buffered`, `X-Durability-Configured: buffered` | PASS |
| A4 | POST row id=3 as gate-admin | 201 `{"inserted":1}` + durability headers | 201 `{"inserted":1}`, same headers; row landed in `tables/widgets/current.jsonl` | PASS |

Denial semantics verified against source before probing (src/auth/roles.ts
`authorizeTableAccess`): admin bypasses; role must carry `tables.<op>`; tableGrants then
require `rw` or the exact operation — which is why the write-only principal denies on
`table_grant` while the analyst denies on `role`.

## Gate B — /metrics family presence (GET /metrics → 200, 11571 bytes, 24 HELP families, 88 series)

Every family is exposed under the `duckbrain_` prefix; presence = `^duckbrain_<family>` line match.

| Family (brief name) | Exposed as | Present | Series |
|---|---|---|---|
| http_up | duckbrain_http_up | yes | 1 (=1) |
| health_status | duckbrain_health_status | yes | 1 (=2 healthy) |
| health_probe_duration_seconds | duckbrain_health_probe_duration_seconds | yes | 51 (histogram, probe=embedding\|keys\|total) |
| embedding_provider_healthy | duckbrain_embedding_provider_healthy | yes | 3 |
| read_duration_seconds | duckbrain_read_duration_seconds | yes | 14 |
| rejected_total | duckbrain_rejected_total | NO (declared in HELP, 0 series) | 0 |
| embedding_requests_total | duckbrain_embedding_requests_total | NO (declared, 0 series) | 0 |
| embedding cache hits | duckbrain_embedding_cache_hits_total | yes | 1 (=0) |
| embedding cache misses | duckbrain_embedding_cache_misses_total | yes | 1 (=0) |
| git_commit_total | duckbrain_git_commit_total | NO (declared, 0 series) | 0 |
| git_push_total | duckbrain_git_push_total | NO (declared, 0 series) | 0 |
| git_commit_queue_depth | duckbrain_git_commit_queue_depth | yes | 1 (=0) |
| git_last_push_success_timestamp_seconds | duckbrain_git_last_push_success_timestamp_seconds | yes | 1 (=0) |
| storage_namespaces_bytes | duckbrain_storage_namespaces_bytes | yes | 1 (=833696) |
| storage_embedding_cache_bytes | duckbrain_storage_embedding_cache_bytes | yes | 1 (=0) |
| recall_packs_ | duckbrain_recall_packs_total + _nonempty_total | yes | 2 |
| read_ledger_rotation_total | duckbrain_read_ledger_rotation_total | yes | 1 (=0) |
| table_declarations | duckbrain_table_declarations | yes | 2 |
| table_declaration_namespaces | duckbrain_table_declaration_namespaces | yes | 2 |
| s3_ | duckbrain_s3_last_push_age_seconds + _unpushed_files | yes | 2 (+Inf / 8) |

Absent families: **rejected_total, embedding_requests_total, git_commit_total, git_push_total** —
all four are declared (# HELP) counters that simply never fired on a fresh daemon (no rejects,
no provider calls, no git commit/push this uptime). Expected-unobserved, not a registration gap.

Machine-readable companion: `evidence-HARDEN-DUCKBRAIN-001-20261125-gateab-probes.json`.
Gate (c) census (unchanged, foreman-verified): `evidence-HARDEN-DUCKBRAIN-001-20261125-gatec-census.json`.
