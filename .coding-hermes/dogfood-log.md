# Dogfood Log

Real-use field tests of DuckBrain. Each entry: date, verdict, promise, top findings, time-to-first-success.

## 2026-08-16 — Verdict: 🟡 PROMISING-BUT-ROUGH (P0 crash on semantic search)

- **Promise:** "AI agents get persistent, queryable, version-controlled memory — MCP server (stdio + HTTP), REST API, CLI, Web UI; append-only JSONL + DuckDB (incl. vector search via LM Studio/Ollama) + per-namespace Git."
- **What was exercised (all on a scratch instance, `DUCKBRAIN_CONFIG_PATH=/tmp/dogfood-duckbrain-0816/config.json`, ports 3123/3124, namespaces under /tmp):** a real MCP SDK client (`@modelcontextprotocol/sdk` 1.29.0, npm-installed in a scratch consumer project) driving `bin/duckbrain.js stdio` through a full agent memory session (create/switch/delete namespace, remember ×5, recall exact/prefix/semantic, forget-by-id + tombstone verification, compaction stats, server_status, server_http_start); REST lifecycle + `?q=` semantic search on a 155-memory namespace; CLI (`remember --content`, `recall`, `list-keys`, `embeddings status/rebuild`, `s3 status/--help/bogus`); Web UI (`packages/ui` on :5199); restart persistence + git auto-commit checks; **read-only probes of the live :3000 daemon that exposed a crash loop**.
- **Top findings:**
  1. **P0 — every REST `?q=` (and MCP semantic recall) request crashes the live :3000 daemon**: `duckdb::InvalidInputException "Map keys must be unique."` → std::terminate → SIGABRT/core dump → systemd restart (5 restarts in ~2 min; reproduced on hermes-memory and dexdat-core; no-q requests fine). Scratch daemon (155 memories) instead hangs >60s on `?q=`. Semantic search is unusable in production (DOGFOOD-010).
  2. **P1 — semantic search has no relevance threshold**: `?q=zzznothing` returns ALL memories (ranked); small namespaces return everything for any query (DOGFOOD-011).
  3. **P1 — the usage SKILL is stale/dangerous**: it claims `?q=` works (it now crashes), says CLI remember can't store content (it can, verified), and omits the MCP `embedding_text` field — my first 4 MCP writes failed with cryptic zod errors (DOGFOOD-012). Also `server_http_start` spawns a nonexistent binary in the standard setup (DOGFOOD-013) and `get_compaction_stats` always returns zeros (DOGFOOD-014).
- **What held up:** REST + MCP write/read lifecycle with correct schemas (remember needs `embedding_text`, forget needs the memory `id`, delete_namespace needs `confirm: true`), semantic ranking when warm (scores returned, 0.74–0.77 for true matches), forget→tombstone→hidden, delete_namespace actually deletes files + git repo now (DOGFOOD-004 fixed), CLI `remember --content` fixed (DOGFOOD-003), `list-keys` tree output fixed (DOGFOOD-009), git auto-commit batching, embeddings rebuild (0 failures, ~4s for 5 texts), S3 CLI graceful when disabled + nonzero exit on bogus subcommand (GAP-029), restart persistence, Web UI boots.
- **Time-to-first-success:** ~3 min (health + namespace list + first REST write). Via MCP with the (stale) skill: first write FAILS — ~8–10 min to first successful MCP write (had to read `docs/api/mcp-tools.md` to find `embedding_text`).
- **Friction count:** 14 distinct frictions → 8 board tasks (DOGFOOD-010..017).
- **Foreman:** woken (cooldown 21600s ≥ 14400s, board got 8 real tasks → PUT CooldownS=900). Enabled=true preserved.

## 2026-08-26 — Verdict: 🟡 PROMISING-BUT-ROUGH (engine solid; agent-facing docs/CLI rough)

- **Promise:** "AI agents get persistent, queryable, version-controlled memory — MCP server (stdio + HTTP), REST API, CLI, Web UI; JSONL + DuckDB (vector search) + per-namespace Git; native S3 tier." Since 08-16: hardened auth (--auth=apikey, tokens, scoping), keyword search + highlight, cross-namespace search, read-only SQL, temporal facts, attr filters, S3 autopush.
- **What was exercised (2026-08-26):** full lifecycle on a scratch daemon (:3126, isolated config/data/auth via DUCKBRAIN_CONFIG_PATH/NAMESPACES_PATH + --auth-file) AND read-only probes of the live hardened :3000 daemon with a fleet token. Verified live: 401/403 auth + REST author provenance (dogfood-hunter@duckbrain.local), namespace scoping, --auth-file isolation (prod auth.json untouched), semantic ?q= (old P0 crash GONE — ranked 0.78/0.559), temporal current-vs-historical views, attr.tick= filter, keyword search with <mark> highlight, --all-namespaces with [ns:] facets, SQL memories view + mutation rejection + template, MCP-over-HTTP tools/list+remember+recall, soft-delete 204, namespace delete guards (400 no-confirm / 400 active-ns / 200 confirm / config unregistered), git auto-commit, restart persistence, live S3 sync status (80+ namespaces, lastSync minutes old).
- **Top findings:** 1) **P1 DOGFOOD-025** MCP-over-HTTP remember stamps host git identity, not the token author — DB-GAP-031 provenance fix is REST-only. 2) **P1 DOGFOOD-026** `duckbrain token` ignores DUCKBRAIN_AUTH_FILE → mints into PROD auth.json (DB-GAP-043 daemon-only; prod restored from backup). 3) **P1 DOGFOOD-027** `recall --namespace <ns>` space-form silently misparses to 'true' → "No memories found" (CLI-FIX-001 class; RETR-008 fixed search only). Plus skill staleness (DOGFOOD-028), --all-namespaces unindexed hard-error (029), s3 status placeholder endpoint (030), SQL view ignores validity (031).
- **What held up:** every documented workflow; auth story solid on REST; all 08-16 P0s fixed; RETR suite works end-to-end; board/foreman healthy (tick #479).
- **Time-to-first-success:** ~3 min (health → auth → first REST write). Skill-guided recall: silent wrong result on space-form flags.
- **Friction count:** 7 new frictions → 7 board tasks (DOGFOOD-025..031). Pre-existing DOGFOOD-018..024 (crash-class) all complete.
- **Foreman:** woken (cooldown 21600s ≥ 14400s, 7 real tasks added → PUT CooldownS=900). Enabled=true preserved.

## 2026-09-04 — Verdict: 🟡 PROMISING-BUT-ROUGH (engine solid + all 7 prior fixes verified; fresh-user install path broken on main)

- **Promise:** "AI agents get persistent, queryable, version-controlled memory — MCP (stdio/HTTP), REST, CLI, Web UI; JSONL + DuckDB vector search + per-namespace git; optional S3 tier; `--auth=apikey` hardening." (cron pick `duckbrain-pm`; picker workdir is an EMPTY stub — ran against the real ~/duckbrain.)
- **What was exercised:** verification dogfood — the 08-26 tasks DOGFOOD-025..031 were all closed complete by the foreman; this run independently re-verified each on a fully isolated scratch daemon (:3777, DUCKBRAIN_NAMESPACES_PATH + DUCKBRAIN_CONFIG_PATH + --auth-file; prod auth.json checksummed unchanged). VERIFIED FIXED live: 025 (MCP remember stamps token author `dogfood-top@duckbrain.local`), 026 (token honors DUCKBRAIN_AUTH_FILE), 027 (recall space-form --namespace parses), 031 (SQL view hides expired+future rows; REST current view hides; --historical shows), GAP-030 (/health 503 when degraded — forced via dead embedder baseUrl; writes stayed 201; semantic ?q= survived via RETR-002 keyword fallback). Also: scoped-token 403, keyword search + <mark> highlight, git auto-commit on scratch ns, MCP forget tombstone, restart persistence. Bunker install leg on las-bunker-03 (agent 95400f8d, destroyed).
- **Top findings:** 1) **P1 DOGFOOD-0904-02 INSTALL BLOCKER** — fresh clone of main + clean `pnpm install --frozen-lockfile` (32s OK) crashes on `node bin/duckbrain.js http`: `Cannot find module 'express'`; express is only transitive in the lockfile (express-rate-limit peer), dev boxes run on stale root-level express; bunker-proven one-liner `pnpm add express@5.2.1` → 200/201/201. 2) **P1 DOGFOOD-0904-01** — CLI `forget` hardcodes namespace 'default' (src/cli/human.ts:636), ignores --namespace, fails for every other ns; MCP forget works. 3) **P2 DOGFOOD-0904-03** — README assumes node≥22+pnpm exist; no quickstart smoke. Infra note: scheduler row `duckbrain-pm` workdir is an empty registration stub (ticked twice, did nothing) — point it at the real repo or delete it.
- **What held up:** every 08-26 P1 fix; graceful degradation (503 health, writes keep working, hybrid search falls back); auth scoping; isolation trio (namespaces/config/auth-file env) leaked nothing.
- **Time-to-first-success:** ~4 min (scratch daemon → first semantic-scored recall) on the dev checkout; **fresh user on main: BLOCKED at first boot** (finding 1). Fresh-machine timings: node via nvm 11s, pnpm install 32s.
- **Friction count:** 3 new (→ DOGFOOD-0904-01..03) + 1 infra registration stub.
- **Foreman:** NOT woken — duckbrain project cooldown is 3600s (< 14400 threshold) and ticked normally 16:23→16:46 today; new tasks will be picked up on its next hourly tick.

---

## Run — 2026-09-19 (tick duckbrain-dogfood-2026-09-19-18-33-51)

**Verdict: PROMISING-BUT-ROUGH.** Promise ("agent gets persistent,
version-controlled memory over HTTP/MCP/CLI") holds: full workflow verified
live on an isolated scratch daemon — namespace create, write, exact/prefix/
tree/semantic recall, scoped-token 401/403, MCP remember/forget, SSE change
feed (ready -> heartbeat -> cursor change), validity windows, git-batched
auto-commit. CLI forget in non-default namespaces now WORKS
(DOGFOOD-0904-01 fix verified in source).

**Focus this run: fresh-machine installability** (ephemeral bunker
las-bunker-03, agent 7649b92c, clean Debian user, clone of public origin at
ce936ae). Found 2 install breakers invisible on the dev checkout:
- DF-0919-01 (P1): pnpm install --frozen-lockfile RC=0 but express (and
  ~30 pkgs) unlinked on a fresh store -> boot Cannot find module 'express';
  pnpm add express@5.2.1 repairs. install=60s, boot <5s after workaround.
- DF-0919-02 (P1): pnpm build fails — packages/ui/tsconfig.json baseUrl
  removed in TS7 (TS5102). Backend unaffected (tsx runs src).
- DF-0919-03 (P2): README pnpm version drift + non-root corepack flag.
- DF-0919-04 (P3): /health 503 with all active providers healthy (keyless
  openai counts unhealthy).
- DF-0919-05 (P3): validUntil camelCase silently dropped (snake_case works).
- DF-0919-06 (P3): outside-default warning fires on explicit ?namespace=.

**Time-to-first-success:** ~10s on the dev checkout (scratch daemon up +
first write read back); on the fresh bunker, only after the DF-0919-01
workaround — without it, first success is blocked entirely.

**Friction count:** 6 new (above), 0 pre-existing regressions found in the
API contracts documented in the usage skill.

**Bunker leg:** PASSED after workaround — clone 60s, quickstart smoke
(README steps 1-5) 201/201/200 on the fresh daemon, no sudo needed, agent
destroyed, bunker clean.

**Left behind:** docs/dogfood/2026-09-19-integration.md, diagnostics.md
run-6 section, skills/duckbrain-usage v1.6.0, DF-0919-01..06 on the board
(events appended), this entry.

NOTE: first application of this run's artifacts was wiped from the working
tree by a sibling process while uncommitted (re-applied and committed in the
same step — see git history for the double landing).

---

## Run 8 — 2026-09-23 (tick duckbrain-dogfood-2026-09-23-06-20-14)

**Verdict: PROMISING-BUT-ROUGH.** Focus surface: the namespace deletion
lifecycle (e3a9852, 2026-09-22) — delete-disk vs clear-s3 vs ghost sweep —
untouched by runs 1-7. Promise holds on the CLI: guards (force, active-ns,
in-flight-push lock) all fire with exact reasons, who/why audit line lands,
ghost sweep detects+prunes seeded ghost state, daemon behind a CLI delete
stays coherent (deleted ns → 404, no ghosting at HEAD). Isolated scratch
daemon (:3923, env isolation trio), prod untouched.

Top findings:
1. **DF-0923-01 (P1)** — the in-flight-push guard is CLI-only: REST DELETE
   /api/namespaces/:name and MCP delete_namespace call the shared core
   WITHOUT the guard. Live-proven: same live lock that blocks the CLI does
   NOT block REST (200, dir gone). Half-landed-push/ghost scenarios are
   reachable through the agent-facing surfaces.
2. **DF-0923-02 (P2)** — REST/MCP deletion writes NO lifecycle.log audit
   line (only the CLI path logs who/why).
3. **DF-0923-03 (P2)** — zero docs for the feature; plain `namespace delete`
   silently changed semantics (disk-only now).
Also: DF-0923-04 (P2) compose path broken fresh (probe 000, chaos-shutdown
rc=1); DF-0923-05 (P3) no npm artifact (upgrade E404).

Time-to-first-success: ~30s (daemon boot ~4s + create + write + read-back).
Fresh-machine install: **17.6s** pnpm frozen install on a clean bunker user —
DF-0919-01 (express missing) FIXED at HEAD.

Perf (Step 2b): REST namespace DELETE 10.6 ms ± 2.5 ms warm (hyperfine n=10);
CLI delete-disk 1.20s cold (Node+DuckDB startup dominates); nothing a user
would feel — no PERF row filed.

Bunker leg: battery PASSED fresh-install (17.6s) on bunker-las-02 agent
a5e78c5a (destroyed); docker-deploy/chaos-shutdown FAILED (DF-0923-04);
ui-probe FAIL = harness misfit (npm run dev here is the backend), not filed
as a product defect; upgrade FAIL = DF-0923-05.

Left behind: docs/dogfood/2026-09-23-integration.md, diagnostics.md run-7
section, skills/duckbrain-usage deletion-lifecycle section, DF-0923-01..05 on
the board (tasks 199→204, events 1176→1181, census-verified), this entry.

## Run — 2026-09-24 (tick duckbrain-qa, as-of time-travel angle)

**Verdict: PROMISING-BUT-ROUGH.** Promise under test: "Read-only as-of recall
at a date, commit, branch, or tag — no checkout — Available now" (README
flagship; never exercised by runs 1–6). On current HEAD the promise HOLDS
end-to-end: HTTP/CLI/MCP as-of all resolve commit/tag/branch/date/instant
refs with correct edge 400s, second-level instant precision, tombstone
recovery via pre-forget refs, true no-checkout, 30.4ms warm as-of vs 6.1ms
current (no PERF row). What breaks the verdict is delivery: **origin/main is
679 commits stale (Aug 07)** — fresh users get a clone that cannot boot
(DF-0919-01's express fix never shipped, re-proven: `Cannot find module
'express'`), lacks as-of entirely, and its server **silently answers
`?as_of=` with 200 + current-state** instead of an error. Local work sits on
feat/native-s3 (up to date at HEAD d3de5a6); main is not.

**Top findings (board DF-0924-01..04, tasks 218→222, events 626–629,
census-verified, commit b435e38):**
1. DF-0924-02 (P0): origin/main stale 679 commits; as-of absent from what
   users clone; stale server returns 200+wrong data for `?as_of=` — README
   promises a feature the default branch does not have.
2. DF-0924-01 (P1): fresh clone of origin/main cannot boot (express missing;
   same defect as DF-0919-01, unfixed on the published branch).
3. DF-0924-03 (P2): MCP `recall.asOf` implemented + verified working but
   documented nowhere (mcp-tools.md: 0 mentions). Plus DF-0924-04 (P3):
   `as_of+q=` returns 500 not 400.

**Time-to-first-success:** ~2 min on the dev checkout (scratch daemon →
namespace → write → as-of read-back at a tag). Fresh user on the published
main: BLOCKED at boot; after two undocumented workarounds (pnpm add
express@5.2.1 + DUCKBRAIN_DATA_DIR precreated), quickstart 4/4 in ~90s — but
the as-of flagship still silently missing there.

**Bunker leg:** las-bunker-03 agent 413229ca (spawn→clone 10s→install 28s
RC=0→boot blocked→workarounds→quickstart PASS→as-of probe recorded→DESTROYED,
key removed). install_seconds=28 (post-express-fix boot 1s). Workaround
steps are the docs finding: README's own quickstart cannot pass on its own
published branch.

**Left behind:** docs/dogfood/2026-09-24-integration.md (full battery table +
worked example), diagnostics.md Run 8, skills/duckbrain-usage v1.7.0 (as-of
section: three surfaces, semantics, availability warning), DF-0924-01..04 on
the board (surgical commit b435e38; sibling CI-005 event row preserved
byte-exact, uncommitted, as found), this entry.
