# Evidence — dogfood 2026-11-23 (tick duckbrain-dogfood-2026-11-23-22-14-19)

Copied from the per-run scratch root at
/tmp/duckbrain-dogfood-df-2026-11-23-OlxJhTFN/ (scratch is pruned on a timer;
this copy is the durable one). No transformations: verbatim copies.

| File | What it is |
|---|---|
| quickstart.out / quickstart.err | documented quickstart exit transcript (rc=0, 1.62 s) |
| rest-arms/…status, …body, …hdr | first arms pass: declare refused 400 INVALID_DECLARATION with the self-describing error (rig used the CLI wrapper shape), subsequent 404s because the namespace pre-create had not happened |
| rest-arms2/…status/body/hdr | corrected pass: declare 201, ins 201, dup 409 single+batch, read 200 + X-Total-Count 2, CSV, patch 200/400, delete 200/400, openapi 3.1 |
| perf/cold_create.time, warm_*.time | Step-2b curl time_total samples (cold create 31 ms; warm list 5.3–15.7 ms; warm table read 45–59 ms) |
| consumer pack/install/use transcripts | tarball pack (duckbrain-sdk-0.1.0.tgz), install 0.30 s, consumer useN.out/err (use2: invented export → fixed; use3: live 400 naming required fields; use4: CREATE/LIST/DECLARE/LIST_TABLES/API_ERROR_OK; use5: TXN_INSERT_OK + READ_NOTES_ERR = DOGFOOD-034 evidence) |
| cold-start.* | daemon cold boot artifacts on the scratch root |

The scripts that produced the consumer and perf arms are at
~/.hermes/cache/scratch/df-*.sh (ephemeral); the arms themselves are simple
curl loops fully described in docs/dogfood/2026-11-23-sdk-tarball-and-tables-rest.md.

Rig-fault records (not product findings): arm1 declare used the CLI
multi-table wrapper shape and got a self-describing 400; an intermediate
daemon relaunch missed DUCKBRAIN_NAMESPACES_PATH and was killed after one
GET of a nonexistent namespace (no production data read or written).
