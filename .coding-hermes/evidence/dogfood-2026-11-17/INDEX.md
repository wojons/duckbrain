# Evidence — dogfood tick `duckbrain-dogfood-2026-11-17-11-52-37`

Target tip `2a8321ff` (dist/bin rebuilt 2026-11-17 05:56 ET, no `src/` file newer than the build, so the
documented `bin/duckbrain.js` ran current code and no rebuild was needed).

Everything here was produced against a **scratch daemon on 127.0.0.1:3391** with its own
`DUCKBRAIN_CONFIG_PATH` + `DUCKBRAIN_NAMESPACES_PATH` (both under this tick's scratch root) and
`--auth=none` on loopback. No production namespace was written; the live `:3000` daemon was only
health-probed.

## Scripts (the exact bytes that ran)

| script | what it does | output |
|---|---|---|
| `seed_corpus.py` | creates namespace `alpha`, writes 44 memories (5 prefixes, 6 domains, list/nested attributes, duplicate pair, 2 validity-windowed facts) via documented `POST /api/memories` | `seed.jsonl` |
| `journey_read.sh` | the read journey a new agent session would run: list-keys, recall by key/prefix/attr/contains/domain, `search`, `search --all-namespaces`, `query` + 3 templates, `status` | `journey-timings.txt`, `cli-*.out/.err` |
| `probe_prefix.sh` | focused A/B on `recall --prefix` (space form, equals form, impossible prefix, exact key) | `prefix-probe.txt`, `pf-*.out/.err` |
| `probe_rest.py` | REST side of the same A/B plus limit/offset/keys/compaction reads | `rest-prefix.jsonl` |
| `probe_mcp.py` | MCP-over-HTTP `recall` with `keyPrefix` vs `prefix` vs `mode:"prefix"` | `mcp-recall.jsonl` |
| `probe_validity.py` | five-fact validity matrix in namespace `beta` (top-level vs attributes-carried windows) | `validity-probe.jsonl` |
| `journey_lifecycle.sh` | forget → views → as-of → squash → receipts | `life-*.out/.err` |
| `probe_perf.py` | Step 2b timings, cold + warm ×5 | `perf.jsonl` |
| `probe_search_repeat.sh` | 8 consecutive `search` runs (heap-abort recurrence check) | `search-repeat.txt` |
| `file_rows.py` | filed QA-DUCKBRAIN-042, QA-DUCKBRAIN-043, DOC-26 via `boardctl create` (argv lists, no shell) | board rows + paired `task_created` events |
| `append_diagnostics.py` | appended "Run 21" to `docs/dogfood/diagnostics.md` | — |

## The two numbers that matter

- `recall --namespace=alpha --prefix=/team/roster/ --limit=100` → **44** memories (whole namespace);
  `GET /api/memories?...&prefix=/team/roster/` → **9**; MCP `keyPrefix` → **9**.
- `recall --namespace=alpha --prefix=/definitely/not/here/` → **44** (a prefix that cannot match).

`cli-recall-prefix.err` carries the CLI's own two log lines proving the prefix object is dropped between
"Tool called with input" and "Validated input" — that diff is the whole finding.

## Install leg

`bunker-qa-evidence.jsonl` is the collector's live copy from `bunker-qa.sh launch|collect` against
`bunker-mvp` (agent `faf390f4`). Cells retained here are exactly what the collector had synced at the
tick's closeout; the battery's terminal state is reported in the dogfood log entry for this tick, not
implied by this file.

## Home-path elision

Absolute host paths appear only inside captured command output (e.g. `PID written to:
/mnt/ssd/tmp/duckbrain-1000/...`). Nothing here carries a credential: the scratch daemon ran
`--auth=none` and no token was minted this tick.
