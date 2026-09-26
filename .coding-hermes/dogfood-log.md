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

## Run 9 — 2026-09-24 (tick duckbrain-dogfood-2026-09-24-11-15-46) — Verdict: PROMISING-BUT-ROUGH (web-UI angle; every data panel dead)

**Angle:** the Web UI (packages/ui) — untouched by runs 1–8 (skill
angle-pitfall law: change the surface, not the depth). Scratch deployment per
OPS-001 (config/namespaces/auth-file trio, :3795); UI driven both via vite dev
(:8995) and the production build + vite preview (:8996).

**Promise tested:** "Beautiful Web UI — Glassmorphism theme, real-time
updates" (README) driven as a real user: open dashboard, read memory counts,
browse timeline, create/switch namespace.

**What a user gets:** the shell renders (prod build LCP 3.0s, TBT 0ms, 204KB,
3 Lighthouse runs) but every data panel is a permanent "Loading..." skeleton.
Measured cause: (1) UI hardcodes namespace 'default' (ui-store.js:23) which
doesn't exist on a normal install → 12+ 404s per load; (2) UI sends zero
credentials and has no token entry → everything 401 on --auth=apikey (21
HTTP>=400 calls in Lighthouse's network table, incl. 429 retry storms).

**Findings (board):** DF-0924-05 P0 UI DOA (no auth, hardcoded ns, skeleton
forever); DF-0924-06 P1 namespace list/switch vs on-disk dirs split-brain +
phantom 'default' directoryMissing; DF-0924-07 P1 --auth-file without
--auth=apikey serves everything unauthenticated (no key → 201); DF-0924-08 P2
README "Web UI Only" path incomplete, daemon serves 404 on /; DF-0924-09 P3
/health leaks "Namespace 'undefined' does not exist".

**What held up:** REST write/read lifecycle, SSE connected, mapped-namespace
create/switch, scoped-token auth on the prod-style daemon, git auto-commit,
`pnpm build` fixed (DF-0919-02 verified closed: 4.2s, 481KB). Engine sound;
defects are all in the UI→API contract layer.

**Time-to-first-success:** shell 3.0s; first real task (see one memory in the
UI) NOT ACHIEVABLE as shipped — that is the finding.

**Install leg (bunker-qa.sh, las-bunker-03 agent 0e8dfe86, destroyed):**
fresh-install ENV-BLOCKED (no pnpm on the bare agent — harness, not repo);
upgrade FAIL (npm package duckbrain@1.0.0 is a 404 — version claim vs npm
reality, DF-0924-10 filed); docker-deploy FAIL (compose build error, needs
foreman); ui-probe FAIL (concurrently not found — dev-deps pruning on fresh
clone); chaos-shutdown OK. Evidence: /tmp/bunker-qa-evidence-20260924T114556Z-8329.jsonl.

**Perf:** headline UI load LCP 3.0s warm (prod build) — the shell is fast
enough; the defect is functional, not speed. Dev server cold was unmeasurable
headless (empty dump; module fetches individually <25ms). Nothing slow enough
that a user would notice → no PERF row (PERF-001 already covers list_keys).

**Left behind:** docs/dogfood/2026-09-24-webui-integration.md, diagnostics.md
Run 9, skills/duckbrain-usage v1.8.0 (pitfalls 16-18), DF-0924-05..10 on the
board (surgical append, 229 rows / 0 bad), this entry.

## Run 10 — 2026-09-25 (tick duckbrain-dogfood-2026-09-25-10-28-50) — Verdict: SHIPPABLE-ON-THIS-SURFACE (SSE change feed works to spec; two P1s on replay filtering and commit atomicity)

**Angle:** the SUPA-5 realtime change feed — runs 1–9 never drove it past the
opening frame. Full subscriber lifecycle: live events, tables/ops filters,
cursor + Last-Event-ID resume, daemon-restart resume, revoke, overflow,
500-write burst through the rate limiter.

**Promise tested:** "subscribe to committed changes per namespace; changes
appear only after the namespace git commit; persist the last `id:` and resume
strictly after it; malformed/gone cursors fail loudly (400/410)."

**What held up (live-verified):** committed-only delivery (10 writes → 0
events → 10 events at the debounce commit); restart-safe unsigned cursors
(decoded {v,ns,commit,ordinal}; daemon killed + restarted, replay correct);
contiguous per-commit ordinals 1..N across 7 commits / 241 events; loud errors
(400 INVALID_CURSOR ×3 variants, 410 CHANGE_CURSOR_GONE + resync guidance,
403 ungranted ns, 400 INVALID_SUBSCRIPTION grammar); tombstone deletes carry
full row image, never row:null; live ops= filter correct; rate limiter vs
ledger consistency exact under bursts (429 rejects, ledger = acked 201s).

**Top findings (board DF-0925-01..06):**
1. **DF-0925-01 (P1)** — replay ignores the ops= filter: reconnecting an
   `?ops=delete` subscription with a cursor replayed 241 inserts + 1 delete.
   Live filtering is correct; replay applies none.
2. **DF-0925-02 (P1)** — data/audit split-commit: write acked 201 has its data
   row in commit 4fa4042 but its audit record in 34ae769 (+30s) — committed
   write invisible to subscribers up to 30s; root cause asyncCommit
   (src/git/autocommit.ts:194) unfenced by the namespace writer lock.
3. **DF-0925-03 (P2)** — SUPA-5 spec + positioning matrix still say
   "Planned/pending implementation" while the feature ships and works.

Also DF-0925-04 (P2 as_of/asOf doc gaps), DF-0925-05 (P2 revoked-key
subscriber persists until next event on idle namespaces), DF-0925-06 (P3
token --auth-file cannot bootstrap a fresh store, breaking the skill's own
recipe).

**Time-to-first-success:** ~4 min (isolation trio + first change event);
2 min of that was the stale-auth-store error (itself DF-0925-06).

**Perf (Step 2b):** subscribe→ready 68 ms ± 4 ms warm (n=10); POST 201
18 ms ± 7.6 ms (n=20); write-ack→event 9.2 s = the documented 30s commit
debounce (by design, not a defect). No PERF row.

**Install leg:** SKIPPED-install-bunker — not re-proven this tick; runs 6/8
already verified fresh-install on las-bunker (17.6s pnpm frozen install,
DF-0919-01/02 closed). Recorded explicitly, not a silent pass.

**Left behind:** docs/dogfood/2026-09-25-sse-feed-integration.md,
diagnostics.md Run 10 section, skills/duckbrain-usage v1.9.0 (SSE section +
pitfalls 19-20), DF-0925-01..06 on the board (surgical append 230→236 rows,
0 bad lines), this entry.
2026-09-25 | run 10 continuation (tick nudge1) | OK — resumed after gateway drain_timeout drop; verified continuation rather than re-run

state.db confirmed both dogfood commits (b6d5139 run-10 report, e921c97 fix, 791e2fc judge bookkeeping)
were completed and DB-GAP-057 judged PASS (verdict ac0b02ec) before the drop. No re-run performed.

Continuation work:
- Pushed 2 unpushed commits (b6d5139..791e2fc) to origin/feat/native-s3; remote parity verified 0 ahead.
- CI health: run 36130524065 = FAILURE (src/cli/auth-file-enforcement-df092407.test.ts, "authType basic +
  authFile keeps type basic (no auto-flip)"; 1 file failed / 169 passed; docker job skipped). Failed at
  11:40Z before DB-GAP-057 commits — not created by this tick. Filed INT-CI-012 (board 236→237 rows,
  surgical append verified, trailing newline checked).
- dogfood-log entry recorded; no board/status changes to run-10 findings (unchanged: DF-0925-01..06 pending).

Verdict for the tick: OK — prior work recovered and pushed, CI failure surfaced with a board row,
no duplicated dogfood run.
## Run 11 — 2026-09-25 (tick duckbrain-dogfood-2026-09-25-21-34-39) — Verdict: SHIPPABLE-ON-THIS-SURFACE (S3 push/query/share all real; fresh-machine DR restore broken)

- **Angle:** the Native S3 storage tier — the README flagship (SQL over the
  archive, ~30s RPO autopush, multi-host memory). Runs 1–10 only ever probed
  `s3 status` with the tier off; this run pushed, restored, queried, and
  shared memory over the real Hetzner bucket, on an isolated scratch prefix
  (`duckbrain-dogfood-s3`), with scratch config/auth/namespaces roots.
- **Promise tested:** "enable s3.enabled → autopush on commit → SQL over S3
  without restoring → pull on another machine = DR + shared memory."
- **What held up (live-verified):** manifest autopush after the 30s debounce
  (6 objects incl. manifest + _audit); delta push byte-exact; `s3 query`
  via httpfs (row-level SELECTs, 3.6–3.9 s incl. DuckDB boot); restore →
  daemon → 9/9 read-back; write-after-restore 201; two-host round trip —
  host B's 11 writes pushed, pulled onto host A, served by A's RUNNING
  daemon with no restart; `s3 clear` dry-run/real (6/6, audit flags); `s3
  ghosts` read-only. Fresh-machine leg on ephemeral dedi-2 agent 8be0cc13
  (destroyed): README quickstart green verbatim on bare Ubuntu 24.04
  (node 7 s / clone 4 s / pnpm install 10 s / full smoke incl. stored-content
  read-back); `s3 status` with no creds/config = clean "disabled", exit 0.
- **Top findings:**
  1. **DF-0925-07 (P1)** — fresh-machine DR restore is broken: `s3 sync <ns>
     pull` on an empty root → "Namespace not found"; `sync all pull` → exit
     0 "0 namespaces, 0 files transferred" (silent no-op); undocumented
     `namespace create` unlocks the pull but git history never returns
     (data-only).
  2. **DF-0925-08 (P2)** — no documented path wires the per-namespace
     `s3daily` remote (git-mirror autopush silently never fires for new
     namespaces); README's "global git identity required" is stale (fresh
     box passed with none, synthetic author stamped); `s3 status` can't see
     API-created namespaces (registry split-brain on the S3 surface).
  3. **Noted, not filed** — on this HEAD `DUCKBRAIN_AUTH_FILE=<fresh path>
     token` CREATED the store, contradicting pending DF-0925-06 (possibly
     fixed or invocation-dependent; verify before re-filing).
- **Time-to-first-success:** ~6 min from config enable to first autopush
  landed on the bucket (2 min of it my own token-grep mistake — the mint
  output prints the full token once above a truncated example line).
- **Perf (Step 2b):** POST write 0.19 s mean warm (n=10, embedding incl.);
  s3 query 3.6 s cold / 3.9 s warm (≈2 s process boot); pull 4.6 s; delta
  push 1.6 s. Nothing user-visible slow enough for a PERF row.
- **Install leg:** DONE, not skipped — las-bunker-03 unreachable (ssh
  timeout) and las-02 bunkerd crash-looping (exit 1 auto-restart), so the
  ephemeral agent ran on dedi-2 (bunkerd active, registered for this run).
  Install 21 s total to a bootable daemon; smoke passed. Infra note: bunkerd
  destroy ABORTS with home retained when the pre-delete home archive
  exceeds its own kill window (>1 GB node_modules home suffices) — shrink
  then destroy; TTL unaffected.
- **Left behind:** docs/dogfood/2026-09-25-s3-native-tier.md (integration
  report + paste-ready recipe), diagnostics.md Run 11, skills/duckbrain-usage
  v1.10.0 (S3 section + pitfalls 21–22), DF-0925-07/08 on the board
  (surgical append 240→242 rows, numstat 2/0 verified, commit 29cbd6f),
  this entry. Scratch prefix cleared via the product's own `s3 clear`
  (6/6 deleted, bucket prefix empty); prod auth/namespaces untouched.

## Run 12 — 2026-09-26 (tick cron dogfood-pick; angle: examples/ on-ramp + concurrency contract) — Verdict: PROMISING-BUT-ROUGH

- **Promise tested:** "a new integrator can follow the repo's own examples
  (examples/http-api, examples/mcp-client, examples/custom-storage) and the
  README's Multi-Agent concurrency claim to a working first integration."
- **What was exercised (scratch daemon :3821, DUCKBRAIN_CONFIG_PATH +
  DUCKBRAIN_NAMESPACES_PATH isolation, prod :3000 untouched — auth.json md5
  verified unchanged):** all three example walkthroughs executed as documented;
  real MCP SDK 1.30.0 stdio session; corrected REST+MCP lifecycle; 12-way
  concurrent same-key writes; ?q=/contains= search battery; fresh-machine
  install on bunker dedi-2 agent c667cb35 (destroyed); perf pass.
- **Top findings (board DF-0926-01..06, tasks 242→248 committed):**
  1. DF-0926-01 (P0) — examples unusable as shipped: `pnpm start -- <cmd>` →
     "Unknown command: --" (both READMEs); client.js ESM/CJS SyntaxError; bare
     `duckbrain http` binds default port 3000, deletes the LIVE prod daemon's
     pidfile calling it stale, exits 0 on EADDRINUSE (reproduced 2×, prod
     pidfile restored both times).
  2. DF-0926-02 (P1) — undocumented ?key=/?query= silently return the
     UNFILTERED list (discriminator-proven with 2 memories) — the repo's own
     example client teaches both.
  3. DF-0926-03 (P1) — ?contains= deterministically misses terms present
     verbatim in stored content (Hello/from/different → 0; zebra/API → hit),
     stable across the documented index rebuild (rowCount 2) and commit debounce.
  4. DF-0926-04 (P1) — DUCKBRAIN_NAMESPACE / DUCKBRAIN_DATA_DIR inert (example +
     ai-configure.md teach them; MCP write with the env set landed in
     'default'); DF-0926-05 (P2) custom-storage example documents nonexistent
     --verify-config/--config + config keys the zod schema drops; DF-0926-06
     (P3) key-path validation 500s instead of 400.
- **What held up:** the engine behind the examples — corrected lifecycle works
  on REST and MCP (real schema: domain enum, string content, attributes,
  embedding_text; switch_namespace {name}); **concurrency contract exact**
  (12/12 concurrent same-key POSTs → 12 distinct versions, listed 12/12 —
  http-api.md:321 holds); ?q= keyword-fallback 200 without a provider; perf
  POST 13.9ms avg / GET 9.7ms avg warm (n=20) — no PERF row warranted; fresh
  install 18s with smoke id-match (DF-0919-01/02 still fixed; first nvm
  attempt hit a transient CDN error, retry succeeded).
- **Time-to-first-success:** following the repo's own examples verbatim — NOT
  ACHIEVABLE (4 consecutive blocked steps); with documented API + server error
  strings as the guide — ~4 min from clean scratch daemon to first
  write+read-back.
- **Friction count:** 6 new (→ DF-0926-01..06). 0 regressions in previously
  verified surfaces touched this run.
- **Bunker leg:** DONE (not skipped) — dedi-2 agent c667cb35, clone+nvm+
  corepack+pnpm install 18s, boot+write+read-back smoke id-match, agent
  destroyed. INFRA DEFECT: `bunker destroy` on dedi-2 deadline-cancels userdel
  mid-destroy — registry says "destroyed", agent user+home remained ssh-able;
  row BNK-DF-001 filed on /home/kara/bunker; manual userdel completed cleanup.
- **Left behind:** docs/dogfood/2026-09-26-examples-integration.md,
  diagnostics.md Run 12, skills/duckbrain-usage v1.11.0 (pitfalls 23-27 +
  working quickstart), DF-0926-01..06 (surgical commit; sibling
  REVIEW-DUCKBRAIN-006..009 rows preserved uncommitted byte-exact), BNK-DF-001
  on the bunker board, this entry.
