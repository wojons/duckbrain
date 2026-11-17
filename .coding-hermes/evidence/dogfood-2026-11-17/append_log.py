#!/usr/bin/env python3
"""Append this tick's entry to .coding-hermes/dogfood-log.md (append-only)."""
import pathlib

P = pathlib.Path("/home/kara/duckbrain/.coding-hermes/dogfood-log.md")
TEXT = """
## 2026-11-17 — scoped reads on three surfaces: REST and MCP answer, the CLI answers something else (tick `duckbrain-dogfood-2026-11-17-11-52-37`)

Verdict **🟡 PROMISING-BUT-ROUGH**. Target tip `2a8321ff` (dist CLI current: no `src/` file newer than
`dist/bin/duckbrain.js`, so the documented `bin/duckbrain.js` ran tip code with no rebuild). Scratch
daemon `:3391`, isolated config + namespaces path, `--auth=none` on loopback; no production namespace
touched.

Promise under test: an agent/operator can create a namespace, write a sprint's worth of memories, and ask
a SCOPED question ("what do we know under `/team/roster/`?", "which facts expired?", "what did we know
before this was forgotten?") over REST, MCP and the CLI and get the same answer from each.

1. **P1 `recall --prefix=` returns the whole namespace** — `duckbrain recall --prefix=/team/roster/
   --limit=100` printed `Found 44 memories` on a 44-memory namespace; a prefix that cannot exist
   (`/definitely/not/here/`) also printed 44, rc=0, no warning. Same data: REST `?prefix=` → 9,
   MCP `keyPrefix` → 9, REST impossible prefix → 0. Cause is in the CLI's own stderr: it builds
   `{mode:"prefix", prefix:"…"}` but the recall tool's schema names that field `keyPrefix` and silently
   drops unknown fields, so the validated input arrives with only `{limit, offset, namespace}` and the
   query runs unfiltered. **Filed QA-DUCKBRAIN-042** (P1, bug) with the three-surface table, the stderr
   diff and both fix points (forward `keyPrefix`; reject/alias unknown filter fields so this can never be
   silent again).

2. **P2 `list-keys --prefix=` counts keys it does not print** — `list-keys --prefix=/team/roster/` prints
   `Keys (9 total):` then only `/team/` and `/team/roster/`; the nine leaves are withheld by a hard-coded
   `maxDepth: 3`, there is no depth/leaf flag on the CLI (MCP has one), and nothing marks the truncation.
   `list-keys --help` also runs the listing instead of printing usage (new instance of the
   DB-GAP-029/DB-GAP-034/HTTP-HELP-001 class). **Filed QA-DUCKBRAIN-043** (P2). Note this invalidates
   pitfall 35's old workaround ("use `list-keys --prefix=` for enumeration"), which is now corrected in
   the usage skill.

3. **P3 the validity window works only as a top-level field, while two agent-facing docs call it an
   "attribute"** — controlled five-fact matrix in a second namespace: current view returned 3 rows
   (current + both attributes-carried windowed facts); `?historical=true` returned 5. The top-level
   `valid_until`/`valid_from` rows were correctly hidden. `docs/agentic-memory-roadmap.md:50` calls them
   "write-side attributes" and `skills/duckbrain-usage/SKILL.md` never says they are top-level record
   fields — an agent following the roadmap stores an inert attribute and its expired fact is recalled as
   current forever, with no warning on write. **Filed DOC-26** (P3, docs).

4. **Refinement, not a new row — `--limit` is broken only in SPACE form.** `recall --limit 3` validates as
   `limit: 10`; `recall --limit=3` validates as 3 and returns 3. Same parser family as DOGFOOD-027-R2
   (`list-keys --namespace alpha` → `true`). **Annotated QA-DUCKBRAIN-036** with the corrected scope and a
   proposed AC addition, rather than minting a sibling.

5. **Recurrence, not a new row — fresh-machine suite still RED on exactly one load-sensitive test.** The
   install leg's `tests` cell failed on the clean agent: `FAIL src/http/routes/realtime-fanout.test.ts >
   DB-SUPA-5 bounded fan-out > heartbeat and close cleanup — expected 1 to be greater than or equal to 2
   (line 213:29)`; totals `1 failed | 297 passed (298)` files, `1 failed | 2502 passed | 1 skipped (2504)`
   tests, 389.02 s. Same tree, solo run on this box: 2/2 passed, rc=0 → load-dependence confirmed, not a
   deterministic break. **Annotated DOGFOOD-033** (the row that already owns this test) with the newer
   counts and the non-reproduction arm; no sibling filed.

6. **What held up** (recorded because it is half the verdict): REST/MCP prefix, domain, attribute and
   `contains=` filters all filtered correctly (9 / 7 / 11 / 35 rows); `search` ran 8/8 clean
   (398–656 ms, rc=0) — a scoped non-reproduction of README-19-R3/R4 at 44 rows, which does NOT refute
   the size-dependent abort and did not rebuild a production index to chase it; validity windows in the
   top-level form hide expired/future facts and `--historical` shows them; `forget` → 43 rows, tombstone
   excluded from BOTH views as documented, `--as-of=<pre-forget commit>` returns 44 with the forgotten key
   recovered; the whole corpus survived a daemon kill + relaunch (43 current rows, tombstone still
   applied, as-of still resolving); SQL `count(*)` = 43 = REST `total` = CLI count after the forget — no
   aggregate drift across surfaces.

7. **PERF (Step 2b) — measured, nothing filed.** 44 writes in 0.82 s (≈14 ms each). Warm medians of 5:
   list 43 rows **7.7 ms**, prefix list **8.6 ms**, `contains=` **68.8 ms**, semantic `q=` **297 ms**,
   `/api/keys` **3.1 ms**, `/api/compaction/stats` **2.3 ms**; CLI invocation 398–620 ms (Node startup
   floor). The only user-felt number is the FIRST semantic query after boot at **3546 ms** cold — the
   documented AUG-096 warm-up / embedding-provider cost, already on record, and not worth a PERF row.
   Nothing else on a 44-row namespace is slow enough for a user to notice; filing it would devalue the
   real rows.

Install leg: `bunker-qa.sh launch` on `bunker-mvp` (ONLINE, `/tmp` private, net mode *shared*) spawned
agent `faf390f4` at 11:55:35Z; the collector synced 15 rows by this tick's closeout — `fresh-install OK`
(6.7 s, pnpm 12.4.2), toolchain bootstrap OK, `lint N/A`, `tests FAIL` (§5), `docker_build OK`,
`compose_config OK` — with the battery still RUNNING, so the agent was left intact rather than destroyed
mid-battery. Isolation stays **UNVERIFIED** (host reports a shared network namespace) and the cells after
`compose_config` are reported as not-yet-reached, not as passes.

UNVERIFIED, named: `search` at production scale (would require rebuilding a live namespace's index);
auth/token/role surfaces (this run used an explicit `--auth=none` loopback scratch daemon by design — that
is SEC-AUTHZ-001's ground); the install battery's cells after `compose_config`.

Left behind: `docs/dogfood/2026-11-17-prefix-filter-and-listkeys.md` (integration report),
`docs/dogfood/diagnostics.md` "Run 21" (how the CLI reaches the store and where the filter is lost, why
`list-keys` hides leaves, the two validity shapes, the durability check), `skills/duckbrain-usage/SKILL.md`
v1.15.0 (pitfalls 37–40 + the correction to pitfall 35's workaround), and the full probe set under
`.coding-hermes/evidence/dogfood-2026-11-17/` (11 scripts, ledgers, the smoking-gun stderr, the pulled
`tests.log` failure excerpt and the solo-green run).

ch:trace tick=duckbrain-dogfood-2026-11-17-11-52-37 target=2a8321ff rows_filed=QA-DUCKBRAIN-042,QA-DUCKBRAIN-043,DOC-26 rows_annotated=QA-DUCKBRAIN-036,DOGFOOD-033 evidence=.coding-hermes/evidence/dogfood-2026-11-17/ install=fresh-install-OK/tests-FAIL/RUNNING agent=faf390f4 perf=no-finding
"""
with P.open("a", encoding="utf-8") as f:
    f.write(TEXT)
txt = P.read_text(encoding="utf-8")
print(f"appended {len(TEXT)} chars; entries={txt.count(chr(10) + '## ')} tick_hits={txt.count('duckbrain-dogfood-2026-11-17-11-52-37')}")
