# Dogfood 2026-11-17 — the prefix filter that isn't, and a key tree that hides its keys

Tick: `duckbrain-dogfood-2026-11-17-11-52-37` · target tip `2a8321ff` · verdict 🟡 **PROMISING-BUT-ROUGH**
(one P1 silent-wrong-answer, one P2 renderer, one P3 docs gap; durability and the newer surfaces held up)

## The promise (what this run tested)

> An agent or operator can create a namespace, write a sprint's worth of memories, and then ask a
> **scoped** question — "what do we know under `/team/roster/`?", "which facts expired?", "what did we
> know before this was forgotten?" — over REST, MCP and the CLI, and get the same answer from each.

That last clause is the one that broke. Everything else in the run — writes, keyword search, semantic
search, validity windows, forget, time travel, daemon restart — behaved.

## How it was used (not the test suite)

A scratch daemon on `:3391` with its own config/namespaces path (`--auth=none`, loopback), no production
namespace touched. One namespace `alpha` seeded with 44 memories through the ordinary documented
`POST /api/memories` payload (5 key prefixes, all six domains, scalar/list/nested attributes, a
duplicate-content pair, two validity-windowed facts), and a second namespace `beta` with a five-fact
validity matrix. Then the same questions were asked through CLI, REST and MCP.

Write cost: 44 writes in **0.82 s** total (≈14 ms each, HTTP, warm).

## Finding 1 (P1) — `recall --prefix=` returns the whole namespace · QA-DUCKBRAIN-042

```
$ duckbrain recall --namespace=alpha --prefix=/team/roster/ --limit=100
Found 44 memories:          # ← every key in the namespace
$ duckbrain recall --namespace=alpha --prefix=/definitely/not/here/ --limit=100
Found 44 memories:          # ← a prefix that cannot match anything
```

Same data, three surfaces:

| surface | request | items |
|---|---|---|
| REST | `GET /api/memories?namespace=alpha&prefix=/team/roster/` | **9** |
| REST | same, prefix that cannot exist | **0** |
| MCP | `recall {keyPrefix: "/team/roster/"}` | **9** |
| CLI | `recall --prefix=/team/roster/` | **44** |

Mechanism, from the CLI's own stderr — the prefix is parsed and then dropped:

```
[recall] Tool called with input: {"namespace":"alpha","limit":100,"mode":"prefix","prefix":"/team/roster/"}
[recall] Validated input: { limit: 100, offset: 0, namespace: 'alpha' }
```

The recall tool's MCP schema (`tools/list`) names that field `keyPrefix`, and an unknown `prefix` is
silently ignored rather than rejected — so the query degrades to "everything" with rc=0 and a confident
count. Two fix points: forward `keyPrefix` from the CLI's recall command (`src/cli/human.ts`), and make
the tool refuse (or alias) unknown filter fields so this class can never be silent again.

## Finding 2 (P2) — `list-keys --prefix=` counts keys it does not print · QA-DUCKBRAIN-043

```
$ duckbrain list-keys --namespace=alpha --prefix=/team/roster/
Keys (9 total):
/team/
  /team/roster/
```

Nine keys are counted; none are shown. stderr shows the resolver forcing `maxDepth: 3`, and the CLI has
no depth/leaf flag (the MCP `list_keys` tool does). `duckbrain list-keys --help` does not print usage at
all — it runs the listing and exits 0 (same missing-guard class as DB-GAP-029 `s3 --help`, DB-GAP-034
`token --help`, HTTP-HELP-001 `http --help`; new instance, not covered).

## Finding 3 (P3) — docs send the validity window to `attributes`, where it is inert · DOC-26

Controlled matrix on namespace `beta` (five facts: current / expired / future, plus the expired+future
pair written with the window nested inside `attributes`):

| read | rows returned |
|---|---|
| `GET /api/memories?namespace=beta` (current view) | 3 — current, expired-**attr**, future-**attr** |
| `GET /api/memories?namespace=beta&historical=true` | 5 — all |

The mechanism is correct **for top-level fields** — the top-level expired/future rows were hidden from
the current view and present historically. But `docs/agentic-memory-roadmap.md:50` calls
`valid_from`/`valid_until` "write-side attributes" and `skills/duckbrain-usage/SKILL.md` never says they
are top-level record fields (`docs/api/http-api.md:571` is the only page that is explicit). An agent that
follows the roadmap stores an inert attribute and its expired fact is recalled as current forever —
precisely the failure the window exists to prevent — with no warning on write.

## What held up (recorded because it is the other half of the verdict)

- **Scoped reads on REST/MCP** — prefix, domain, attribute, `contains=` all filtered correctly (9, 7, 11,
  35 rows respectively on the 44-row namespace).
- **`search` (documented keyword verb)** — 8 consecutive runs, rc=0 every time, 398–656 ms, no heap
  abort. This is a scoped non-reproduction of README-19-R3/R4's intermittent `sysmalloc` abort: those
  runs died on large namespaces (13 s / 106 s), this one is 44 rows. It does not refute the row; it does
  not extend it either.
- **Validity windows (top-level form)** — hide expired/future from the current view, show them under
  `--historical`, on both CLI and REST.
- **Forget + time travel** — `forget <uuid> --namespace=alpha` → 43 current rows; tombstone excluded
  from *both* views (as documented); `--as-of=<pre-forget commit>` returns 44 with the forgotten key
  recovered. (An earlier arm of this run queried the post-forget commit and "failed" to recover the row
  — that was this probe's error, corrected here.)
- **Durability across a daemon restart** — after kill + relaunch on the same store: 43 current rows,
  3 rows in `beta`, tombstone still applied, `as_of` still resolves. The store is not held in memory.
- **Corpus numbers agree across surfaces** — SQL `SELECT count(*) FROM memories` = 43 = REST `total` =
  CLI count after the forget. No aggregate drift.

## Performance (Step 2b) — measured, nothing worth a PERF row

| operation | cold | warm (median of 5) |
|---|---|---|
| `GET /api/memories` (43 rows) | 16 ms | **7.7 ms** (6.8–16.1) |
| `GET /api/memories?prefix=` (9 rows) | 8.6 ms | **8.6 ms** |
| `GET /api/memories?contains=` (keyword, 35 hits) | 61 ms | **68.8 ms** |
| `GET /api/memories?q=` (semantic, 10 hits) | **3546 ms** | **297 ms** (248–355) |
| `GET /api/keys` | — | 3.1 ms |
| `GET /api/compaction/stats` | — | 2.3 ms |
| CLI invocation (any verb) | — | 398–620 ms (Node start-up floor) |

The only user-felt number is the first semantic query after a boot (3.5 s cold → 0.3 s warm), which is
the documented AUG-096 warm-up / embedding-provider cost, already recorded in the usage skill; it is not
a new finding and the fix would not change an agent's behaviour. Everything else sits under ~70 ms on a
44-row namespace — no PERF row filed, deliberately.

## Unverified

- **Install leg** — `bunker-qa.sh launch` on `bunker-mvp` (ONLINE, `/tmp` private, net mode *shared*)
  started agent `faf390f4` at 11:55:35Z. At this tick's closeout the collector had synced 15 rows:
  `fresh-install OK` (6.7 s, pnpm 12.4.2), toolchain bootstrap OK ×N, `lint N/A`, **`tests FAIL`**,
  `docker_build OK`, `compose_config OK` — with the battery still RUNNING, so the agent was left intact
  instead of destroyed mid-battery. The `tests` red is one load-sensitive test
  (`src/http/routes/realtime-fanout.test.ts:213`, heartbeat count expected ≥2 got 1; totals
  `1 failed | 2502 passed | 1 skipped (2504)` at 389.02 s); the same file run solo on this box is 2/2
  green, and the row that already owns this test — DOGFOOD-033 — was annotated with the newer counts
  rather than duplicated. Isolation remains UNVERIFIED (host reports a shared network namespace), and
  cells after `compose_config` are reported as not-yet-reached, never as passes.
- **`search` at production scale** — not re-proved (would require touching the live store's index).
- **Auth surfaces** — this run used `--auth=none` on a loopback scratch daemon by design; token/role
  behaviour is owned by SEC-AUTHZ-001 and was not re-walked.

## Artifacts

Probe scripts and their raw outputs: `.coding-hermes/evidence/dogfood-2026-11-17/`
(`seed_corpus.py`, `journey_read.sh`, `probe_prefix.sh`, `probe_rest.py`, `probe_mcp.py`,
`probe_validity.py`, `journey_lifecycle.sh`, `probe_perf.py`, `probe_search_repeat.sh` + `.out`/`.err`
files and the JSONL ledgers they wrote).
