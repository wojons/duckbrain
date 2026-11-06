# OBSDB-005 — storage growth, ledger churn and recall usefulness on `/metrics`

Row: **OBSDB-005** (P2). Spec: `docs/observability-spec.md` §2 blind spots #7-#8, §3.2.

## What was added

| family | type | where the fact is produced |
|---|---|---|
| `duckbrain_storage_namespaces_bytes` | gauge, sampled at collect time | `src/metrics/storage.ts` — one walk of the namespaces root, 60 s reuse window, single-flight, no background timer |
| `duckbrain_storage_embedding_cache_bytes` | gauge, same walk | the `.embeddings/` subset of that walk |
| `duckbrain_read_ledger_rotation_total` | counter | `src/http/readLedger.ts`, incremented after a seal rename lands |
| `duckbrain_recall_packs_total` / `..._nonempty_total` | counters | `src/metrics/recall.ts`, mirrored from `metrics/recall-counter.jsonl` by byte offset (the MCP server is a different process) |

`createHttpServer` now resolves `namespacesPath` before building the metrics
surface and hands it (plus the recall counter path beside it) to
`createHttpMetrics`, so the gauges measure the store the daemon actually serves.

## Proof (scratch daemon, port 28711, `DUCKBRAIN_NAMESPACES_PATH=<scratch>/namespaces`, `--auth=none`)

Store: two copied live namespaces (42,123,224 bytes before the load test).

```
$ curl -s http://127.0.0.1:28711/metrics | grep '^duckbrain_storage_'
duckbrain_storage_namespaces_bytes 42123224
duckbrain_storage_embedding_cache_bytes 18022690

$ du -sb <scratch>/namespaces | cut -f1
42123224                       # gauge == du -sb, 0.0000 % delta

$ find <scratch>/namespaces -type d -name .embeddings -exec du -sb {} + | awk '{s+=$1} END{print s}'
18022690                       # cache gauge == the .embeddings subset
```

Large-tree check of the same measurement code against the 8.1 GB host copy
(`/home/kara/.duckbrain-live/namespaces`):

```
{"namespacesBytes":8126657491,"embeddingCacheBytes":2011168181,"files":479418,"ms":4465}
$ du -sb /home/kara/.duckbrain-live/namespaces | cut -f1
8126657491                     # exact, 479,418 files in 4.5 s
```

Collect-time refresh (no timer): added 3,000,000 bytes, waited past the 60 s
window, re-scraped —

```
du before 52806626  gauge 52806626
du after  55806626  gauge 55806626
```

Ledger rotation, driven by 2,600 real reads (4 KB `namespace` values):

```
$ node burst.js 2600
{"sent":2600,"statuses":{"404":2600},"ms":3344}

$ ls <scratch>/namespaces/.duckbrain-audit/
reads.0001.jsonl (10482061 bytes)  reads.jsonl (201341 bytes)

$ curl -s .../metrics | grep -E '^duckbrain_read_ledger_rotation_total|^duckbrain_reads_total'
duckbrain_read_ledger_rotation_total 1
duckbrain_reads_total{route="GET /api/memories",method="GET",status_class="4xx"} 2600
```

Recall usefulness, after ONE real MCP `recall` over stdio (separate process from
the daemon, `key=/project/hermes-dagger/review-2026-11-03`, namespace `hermes`):

```
$ tail -1 <scratch>/metrics/recall-counter.jsonl
{"ts":"2026-11-06T06:48:30.489Z", ..., "nonEmptyPacks":1, "recordsReturned":2}

$ curl -s .../metrics | grep '^duckbrain_recall_packs'
duckbrain_recall_packs_total 1
duckbrain_recall_packs_nonempty_total 1
# PromQL duckbrain_recall_packs_nonempty_total / duckbrain_recall_packs_total = 1
```

The counters read 0 before that recall and 1 after it — the MCP process wrote the
event, the daemon's scrape counted it, and no in-process increment exists.

## Tests

`src/http/metrics-obsdb005.test.ts` (11 tests): du-ratchet, symlink non-follow,
TTL + no-timer, no-store ⇒ no sample, rotation counter vs sealed segments,
recall mirror idempotency / partial trailing line / truncation monotonicity.
Suite: 266 files / 2,248 tests green; `test-counts.json` bumped in the same commit.

## Not proven here

- The production `/metrics` scrape has not been deployed (that is OBSDB-007, an
  owner-gated restart of :3000). These numbers are from a scratch daemon.
- The recall gauge reads the file at scrape time, so a recall younger than one
  scrape interval appears on the next scrape, not instantly.
