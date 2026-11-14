# Dogfood — `duckbrain search` aborts the process; fresh install is green but the suite is red

- Tick: `duckbrain-dogfood-2026-11-14-10-01-04`
- Target: `duckbrain` @ `b5b97b344b8eaef219312dd1e250e7b05b61a2bf` (main, parity `0/0` with `origin/main` at measurement time)
- Lane workdir: `/home/kara/.hermes/stand-in/dogfood/duckbrain`
- Method: `coding-hermes-dogfood` (skill-driven — no `dogfood-scheduler-tick.sh`, no `dogfooding.ts`)
- Run scratch: `/home/kara/.hermes/cache/scratch/duckbrain-dogfood-2026-11-14-10-01-04/`
- Verdict: **FAILED** — the product works on the surfaces a user touches first (install, HTTP write/read, tables, MCP stdio, `remember`/`recall`), and dies on the one CLI verb a user reaches for when the store has content.

## What was actually used

A real user of DuckBrain builds a memory store and then queries it. This run did that end to end, on an
isolated instance (`HOME`, `DUCKBRAIN_CONFIG_PATH`, `DUCKBRAIN_NAMESPACES_PATH` all inside the run scratch;
no shared daemon, no repo-local `memory/`, no touched project state).

| Surface | What a user does | Result |
| --- | --- | --- |
| HTTP API | `POST /api/namespaces`, write `/quickstart/hello`, read it back | OK — write and read both 200, content round-trips |
| HTTP tables | `tables declare dogfood widgets` (`id` integer pk, `name` varchar), single + batch insert, read, `?id=eq.2`, `?select=name`, `?order=id.desc&limit=2`, `Prefer: count=exact`, `Accept: text/csv`, `PATCH ?pk=eq.1`, `DELETE ?pk=eq.3` | OK — all PostgREST-shaped filters answered correctly, count header exact after delete |
| HTTP edge | `tables/nope`, `?typo=eq.1`, `?id=between.1`, `or=(id.eq.1,id.eq.2)`, `select=id,nope` | OK — 4xx with a readable reason, no 500s |
| OpenAPI | `GET /api/ns/dogfood/openapi.json` | OK — served, table routes present |
| CLI | `remember`, `recall`, `list-keys`, `status`, `tables declare` | OK — write/read round-trip, `status` on an unknown namespace exits 1 and creates no directory |
| CLI | `search "<term>"` | **FAILED** — `rc=134`, `Fatal glibc error: malloc.c:2371 (sysmalloc): assertion failed`, no hits printed, twice |
| MCP stdio | hand-written JSON-RPC consumers against `bin/duckbrain.js stdio` in three fresh namespaces (`mcpagent`, `freshagent`, `ghostns`) | OK — `initialize` → `tools/list` → `remember` → `recall` → `list_keys` → `search` all answer; documented-argument consumers work |
| Docs | `README.md`, `docs/api/http-api.md`, `docs/api/mcp-tools.md`, `examples/mcp-client/README.md` | 3 doc defects filed (`README-23`, `DOC-25`, `README-23` recurrence) |

The failure is not a slow path — it is a dead process. Two independent runs, two different namespace roots,
two different durations, the same abort:

```
$ node bin/duckbrain.js search "cli write path" --namespace=default   # namespace holds ONE memory
rc=134 elapsed_ms=106435     error line printed 8x
$ node bin/duckbrain.js search "warm" --namespace=perf                # different root, ONE memory
rc=134 elapsed_ms=13006      same error, 3 identical lines
Fatal glibc error: malloc.c:2371 (sysmalloc): assertion failed:
  (old_top == initial_top (av) && old_size == 0) || ...  : Aborted (core dumped)
```

`search` is documented as *"Full-text keyword search over memories (content, key, attributes)"*
(`src/cli/human.ts:683`) and needs no embedding provider, so this is not the documented
"embeddings unavailable → keyword fallback" degradation — the keyword path itself corrupts the native heap.
Hot path: `src/cli/human.ts` → `src/mcp/tools/search.ts` → `src/search/query.ts:403` (`keywordSearch`),
which imports the native `duckdb` binding at `src/search/query.ts:14`. That is the same native-heap class as
`README-19` / `README-19-R2` (`*** stack smashing detected ***` in the live daemon), now on a third surface.

One more observation in the same class, recorded but not filed separately because it did not reproduce:
a daemon boot on port 3115 (fresh config, populated namespace root) died with `Aborted (core dumped)`
before serving; 20/20 boots afterwards under rapid kill/restart churn were clean, so the boot surface is
intermittent and the row would be un-actionable on its own.

## Performance (Step 2b) — measured, and mostly not a finding

Headline operations, warm (same daemon, repeated) and cold (new process → first 200 → first op):

| Operation | Warm | Cold |
| --- | --- | --- |
| `GET /health` | ~9 ms | spawn → ready ~0.4 s |
| `GET /api/memories/key/<ns>/<key>` (exact key) | ~15 ms | first read after boot is dominated by namespace warm-up, not the read |
| `GET /api/ns/<ns>/tables/<table>` (3 rows, PostgREST filters) | sub-50 ms across 10 calls | — |
| `POST /api/memories` (write) | sub-50 ms across 10 calls | — |
| daemon boot with a namespace present | — | `HTTP server ready` fast; deep index warm-up runs in the background and can exceed the 30 s inner timeout per namespace |

**Verdict on perf: nothing the product does in normal use is slow enough for a user to notice.** Reads are
tens of milliseconds, writes the same, boot is sub-second to first HTTP answer. No `PERF-` row is filed —
the one place time is lost to a user (`search`, 13 s then 106 s of nothing before the abort) is a crash, not
a latency regression, and is filed as `README-19-R3`. The fresh-machine suite's own 295 s runtime is test-harness
cost (281.96 s / 27% of tracked time is module import evaluation, 466 modules 1546 times), not product latency;
it is mentioned in `DOGFOOD-033` only as the load pressure that makes the heartbeat test flaky.

## Fresh-machine install leg (bunker, never a silent pass)

`bunker-qa.sh launch /home/kara/duckbrain` → agent `67aeb9f5` on `bunker-mvp`, battery detached, evidence
`/tmp/bunker-qa-evidence-20261114T102005Z-2956750.jsonl` (25 cells + launch + collect, collected to terminal
state). Verdicts, read from the jsonl and from the per-cell logs saved before the destroy step:

| Cell | Verdict | Evidence |
| --- | --- | --- |
| `fresh-install` | **OK** | `pnpm` 12.4.2, `pnpm install --frozen-lockfile` done in 5.8 s on a clean checkout |
| `toolchain-bootstrap` | OK | node/pnpm provisioned in the fresh agent |
| `tests` | **FAIL** | `Test Files 1 failed \| 291 passed (292)`, `Tests 1 failed \| 2467 passed (2468)`, 295.14 s — `src/http/routes/realtime-fanout.test.ts:213`, `AssertionError: expected 1 to be greater than or equal to 2` (heartbeat frames) |
| `lint` | OK | — |
| `docker_build` | OK | image builds from the committed Dockerfile |
| `compose_config` | OK | compose file validates |
| `ci-pass` (`act`) | FAIL | host has no `act` (`act=no` in the earlier status snapshot) — infrastructure, not a code red; recorded as unverified, not as a product defect |
| `upgrade` (`npm install -g duckbrain@1.0.0`) | FAIL | `rc=1` inside the ephemeral agent; the published-package upgrade path could not be exercised there |
| `chaos-shutdown` | FAIL | the chaos chain never started because the compose `up` it depends on did not come up in the agent |
| `destroy` | FAIL | agent `67aeb9f5` was **not** reclaimed — the ephemeral leg leaked its agent |

So: **installability is proven** (fresh-install OK on a machine that had never seen the repo), but the
project's own suite is red on that machine, which is the more damaging of the two for a new user.
The `destroy` failure is a harness finding, not a DuckBrain one, and is reported here rather than filed on
the DuckBrain board.

## Rows filed (this tick)

| Row | Priority | Finding |
| --- | --- | --- |
| `README-19-R3` | P2 | `duckbrain search` aborts `rc=134` (glibc sysmalloc) on the current tip — third surface of the README-19 native-heap corruption class; carries both measurements and the `src/search/query.ts:403` hot path |
| `README-23` | P2 | Shipped `duckbrain.config.example.json` cannot start a daemon (enabled `s3` block, placeholder endpoint fails schema validation) while `README.md:98` calls that exact file the template to copy |
| `DOC-25` | P3 | `examples/mcp-client/README.md:70` teaches a `remember` call that can never succeed — passes `content=` and no `attributes`, but the MCP schema requires `embedding_text` (string) and `attributes` (object) |
| `DOGFOOD-032` | P3 | CLI verbs pollute stdout with internal debug dumps (`[duckbrain] Cleared stale DuckDB connections`, `[recall] Tool called with input: {...}`), so piping documented output into `jq` fails |
| `DOGFOOD-033` | P2 | Fresh-machine suite red: `realtime-fanout` heartbeat test fails under parallel load (1/2468), passes 5/5 in isolation |

`boardctl validate -C .` → `RESULT: OK` after filing (722 pre-existing warnings, no new errors).

## Diagnostics trail (reproduce any line)

All paths relative to the run scratch `/home/kara/.hermes/cache/scratch/duckbrain-dogfood-2026-11-14-10-01-04/`:

- `config-minimal.json` — the 3-key config that actually boots (`defaultNamespace`, `namespacesPath`, `gitBatching`); the shipped example does not.
- `evidence/search-crash.sh` / `search-crash.txt` — the 13 s abort, captured with both stdout and stderr.
- `evidence/cli-sweep.sh` / `cli-sweep.txt` — CLI token sweep incl. `status` on a non-existent namespace and the `recall | jq` pipe probe.
- `evidence/mcp-probe.js`, `mcp-probe2.js` (+ `.out`), `mcp-probe3.js`, `mcp-probe4.js` — stdio consumers, documented-argument variant, three fresh namespaces.
- `evidence/coldstart.js` / `coldstart.out` — cold boot timing (`waitReady` polls to first 200).
- `evidence/perf-remeasure.sh` — warm/cold re-measurement on an isolated port with `DUCKBRAIN_SEARCH_TIMING=1`.
- `evidence/bigread-check.sh`, `evidence/boot-crash.sh`, `evidence/boot-matrix.sh`, `evidence/boot-loop.sh` (+ `mx/*.log`) — boot-surface probes; 20/20 clean boots under churn.
- `evidence/boot-crash.log` — one boot where per-namespace warm-up exceeded its 30 s budget and served anyway.
- Bunker evidence `/tmp/bunker-qa-evidence-20261114T102005Z-2956750.jsonl` and per-cell logs `/tmp/bunker-qa-evidence-20261114T102005Z-2956750.jsonl.logs/qa-logs-3813958/` (`tests.log:5684` FAIL, `:5697` summary).

## What a user should take away

Use the HTTP API: it is complete, correct, and fast, and every documented shape I tried answered the way the
docs said. Use `remember`/`recall` from the CLI: they work and they round-trip. Do **not** build a workflow on
`duckbrain search` at this tip — it kills the process instead of returning hits, and it does so on an empty-ish
store, which is exactly when a new user tries it first.

## Reconciliation addendum (same tick, later refire)

Four corrections the next reader needs, all from re-reading the committed artifacts rather than the prose:

- **Product tree unchanged.** `git diff --name-only b5b97b34..HEAD -- src/ bin/ package.json` = 0 paths, so every
  measurement above (search abort, install cells, warm/cold timings) belongs to the tree as committed. Nothing
  was re-run and nothing needs to be.
- **Ledger census.** "25 cells + launch + collect" undercounts the evidence: the jsonl holds 28 rows with 19
  distinct cell names, ten of them repeated `toolchain-bootstrap`. Histogram: `10 OK toolchain-bootstrap`,
  `OK ×6`, `UNVERIFIED ×2`, `N/A ×1`, `INFO ×3`, `FAIL ×6`. The `fresh-install` row is `OK` (5.8 s).
- **Row provenance is incomplete.** The five rows below are committed but carry **no paired `task_created`
  event** in `.coding-hermes/board/events.jsonl` (last event id there is `8682`). The skill helper that wrote
  them has been fixed to emit the event; the backfill of `8683`–`8687` is left OPEN because the harness write
  gate refused the append (`user has NOT consented`, no interactive approver on this surface).
- **Agent `67aeb9f5` is still running**, `bunker info` at `11:12Z`: expires `2026-11-14T14:20:30Z`. Its three
  failed destroys mean teardown is unproven until someone proves absence after that time.
