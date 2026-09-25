# DuckBrain Diagnostics — how it's built, what breaks, the right way

This is the explained diagnostic trail from the 2026-08-07 dogfood run (and what the repo's own
history shows). It answers "how does this thing work, and why did it fail this way" — not raw logs.

## 1. Architecture in one page

```
MCP client ──stdio──▶ bin/duckbrain.js (CLI + stdio MCP)
HTTP client ────────▶ Express server (port 3000) ── POST /mcp (Streamable HTTP MCP)
                        │  /api/memories /api/keys /api/namespaces /health /stats
                        ▼
                   src/mcp/tools (remember, recall, forget, list_keys, squash, namespaces, server_*)
                        ▼
                   DuckDB query layer (src/duckdb)  ◀── reads JSONL partitions per namespace
                        ▼
                   namespaces/<ns>/<domain>/<YYYY-MM>/current.jsonl   (append-only)
                   manifest.json                                      (partition index)
                   .git/                                              (per-namespace repo)
                   .embeddings/<provider>_<model>/                    (vector cache, gitignored)
```

- **Config:** `duckbrain.config.json` in the workdir; `defaultNamespace` picks the default ns;
  `namespaceMappings` aliases ns name → path. Env overrides: `DUCKBRAIN_NAMESPACES_PATH` (data dir).
- **DuckDB is a query layer over JSONL, not a store.** In-memory/temp DuckDB instances read the
  JSONL; there is no canonical .db to corrupt — the JSONL + git are the truth. This is why data
  survived a restart in testing, and why board/parquet caches are rebuildable.
- **The board** (`.coding-hermes/board/`) is the same pattern applied to the project itself:
  `tasks.jsonl` + `events.jsonl` are canonical and git-tracked; `board.db`/`*.parquet` are
  untracked rebuildable caches (JSONL-NORM-001, Bane directive 2026-08-07).

## 2. Errors encountered during the run and why they happen

1. **`Invalid domain 'architecture'. Must be one of: person, event, concept, message, config, raw_note`**
   — zod enum on the write path. The docs example predates the enum (or never matched it). The
   enum is enforced at REST (`POST /api/memories`), MCP (`remember`), and CLI alike — a consistent
   contract; only the docs are stale (DOGFOOD-006).

2. **REST `?q=` returns everything** — `src/http/routes/memories.ts` builds `QueryParams` with
   `query: req.query.q` (line 58) but the `recallTool()` call (lines 63-68) passes only
   `keyPrefix/limit/domain/namespace`. The parameter is parsed and dropped — dead code, silent.
   The MCP `recall` path DOES support semantic `query`; the REST route just never forwards it.
   Fix direction: forward `query` (and decide: REST `q` = semantic search or FTS LIKE).

3. **Semantic recall `memories: []` + error string** — `embedding.provider=auto` →
   `createAutoProvider()` probes `isHealthy()` in order lmstudio → ollama → openai and picks the
   first that ANSWERS (reachability, not model usability). LM Studio answers on :1234 but the
   configured model (`text-embedding-qwen3-embedding-0.6b`) was unloaded → every embed is HTTP 400
   → recall catches the failure and returns `{memories: [], error: "Embedding generation failed:
   ..."}` with a 200. Ollama (nomic-embed-text:latest) was never consulted at query time.
   Fix direction: fallback chain at embed time; isError/500 on failure; model-usability probe.
   Note the write path embeds at write time (cache), so semantic search works as long as the cache
   is warm — it's the cold-miss path that breaks (DOGFOOD-002).

4. **CLI `remember` stores the key as content** — `bin/duckbrain.ts` `remember` accepts
   `--domain/--attr/--namespace/--wait` only. Any other flag is silently ignored; the memory's
   `embedding_text` falls back to the key. This is why the record for
   `remember /scratch/project/alpha --content=...` came back with `embedding_text: "/scratch/project/alpha"`.
   The MCP/REST remember path takes `embedding_text`/`content` properly — the CLI is the odd one
   out (DOGFOOD-003).

5. **`delete_namespace` leaves the directory** — the MCP tool removes the mapping (config
   `namespaceMappings`) and returns success; the on-disk namespace (JSONL + .git + .embeddings)
   is untouched. Deliberate? Unclear — the API name says delete. At minimum it must be documented
   or actually delete (DOGFOOD-004).

6. **No .git in implicitly-created namespaces** — git init happens in the namespace-creation path
   (`create_namespace`); the write path (CLI/HTTP `remember` to a missing namespace) creates the
   partition dirs and manifest but never runs `git init`. So the auto-committer has no repo to
   commit to and silently does nothing. API-created namespaces commit reliably (~30s batch window;
   observed commit `df0763e chore: auto-commit namespace data`) (DOGFOOD-005).

7. **Per-instance pidfile + scratch cleanup** — `http` mode now writes a
   per-instance pidfile (`duckbrain-http-<port>.pid`, or
   `duckbrain-http-<socket-basename>.pid` for socket-only instances) to
   `DUCKBRAIN_DATA_DIR` or `/tmp`. A second instance can no longer clobber the
   first's pidfile, and `server_status` reads the file matching the queried
   port/socket. Per-process temp `duckbrain-<pid>-*.db` scratch files are
   cleaned up on exit (they were unlinked on clean close, but crash exits left
   them behind) (DOGFOOD-008).

## 3. The right way (what a maintainer should know)

- **Storage contract:** append-only JSONL is the source of truth; never delete lines, write
  tombstones (`action: "tombstone"`). The query layer filters them. This held up in testing —
  keep it that way.
- **Versioning contract:** every namespace SHOULD be a git repo with batched auto-commit. The
  gap is only the implicit-creation path (DOGFOOD-005). A regression test should assert
  "first write → .git exists".
- **Embedding contract:** vectors never in git; cache keyed by `sha256(modelId + contentHash)`;
  different models coexist per provider subdir. Keep, but make provider selection resilient
  (DOGFOOD-002).
- **HTTP API:** the route layer should be a thin pass-through of the tool layer. `memories.ts`
  dropping `q` shows what happens when the route re-builds params by hand — a shared
  params→recallTool helper would have prevented it.
- **Test strategy:** 254 unit tests + HTTP integration tests exist and the board battery is
  green — yet none of these nine gaps were caught, because the tests never did what a user does:
  verbatim docs examples, a second server instance, an implicit namespace, a cold embedding
  cache, a real `?q=` assertion. Add those five probes.

---

## 2026-08-16 follow-up — what the second deep run found

Follow-up to the 08-07 trail. Same architecture, four new lessons:

### 1. The P0: semantic search aborts the whole process (DOGFOOD-010)

`recall(query=...)` runs a two-phase pipeline: (a) embed the query via the
provider chain (LM Studio → Ollama fallback, DOGFOOD-002 fix), (b) fetch
candidates with `LIMIT max(limit*10, 100)` (i.e. up to 510 rows) and rank them
in JS. The crash is NOT in JS — it is a **native DuckDB exception that escapes
as an uncaught C++ throw and calls std::terminate**:

```
terminate called after throwing an instance of 'duckdb::InvalidInputException'
  what():  {"exception_type":"Invalid Input","exception_message":"Map keys must be unique."}
```

On the live daemon this was fatal and reproducible on every `?q=` request
(5 systemd restarts in ~2 min of probing; `journalctl --user -u duckbrain-http`).
The trigger is data-shape dependent: the scratch daemon (155 memories, all
`attributes: {}`) did NOT crash — it instead HUNG >60s on the same request,
suggesting the candidate query itself is also pathologically slow when the
namespace has many rows. Two independent failure modes, same code path.

**Why it wasn't caught:** the regression test for DOGFOOD-001 asserted `?q=`
forwards to recallTool on a 3-memory namespace. Nobody ran `?q=` against a
namespace with real-world JSONL (duplicate keys inside `attributes` objects are
the prime suspect for the DuckDB map-key error — DuckDB builds a MAP/STRUCT from
the JSON object and duplicate keys are an error, not a warning). The test suite
also never asserted "server stays alive after a bad query".

**The right way:** the process must survive a bad query. Options: (a) catch the
native exception boundary (worker process per query, or `--enable-source-maps`
won't help — this is C++), (b) pre-validate/normalize `attributes` on write so
duplicate keys never reach disk, (c) add a process-level guard + crash handler
that restarts cleanly. Plus: `?q=` on a big namespace must have a bounded
execution path (the 510-candidate fetch + on-the-fly embedding is unbounded).

### 2. "Fixed" is a lie until a user runs it (DOGFOOD-012)

The 08-07 trail's fixes landed, but `skills/duckbrain-usage/SKILL.md` still
taught the OLD behavior ("?q= is dead", "CLI remember stores no content"). Both
were wrong by 08-16: `?q=` forwards (and crashes — worse than dead), and CLI
`--content` persists fine. **The skill is the integration surface for agents;
when it drifts from the code, agents both avoid working features and trip over
new ones** (the MCP `embedding_text` rename cost 4 failed writes this run).
Lesson: every code fix that changes observable behavior must update the skill
in the same commit — that is the repo's contract with its users.

### 3. Schema drift between surfaces is a tax on every integrator

MCP `remember` takes `embedding_text`; REST takes `content` — same field, two
names (docs note this, the skill doesn't). `forget` takes a UUID, not a key.
`delete_namespace` needs `confirm: true`. All documented in
`docs/api/mcp-tools.md`, all invisible to someone following the skill. The zod
errors (`-32602 expected string, received undefined at embedding_text`) are
technically accurate and practically useless — they name the missing field but
not the alternative name the caller likely used.

### 4. Tools that lie (DOGFOOD-013/-014/-015)

- `server_http_start` returns `{spawned: true, message: "...not listening within 5s"}`
  after spawning a **nonexistent binary** (`npx tsx /bin/duckbrain.ts` —
  `projectRoot` is derived from cwd, which is the repo root, so `..`/`..` walks
  to `/`). `stdio: "ignore"` hides the child's error completely. Root-cause:
  path resolution must come from the module location, not the working directory.
- `get_compaction_stats` hardcodes `cwd/.duckbrain/namespaces/default` (legacy
  layout) — in any configured deployment it returns all zeros for a populated
  namespace. It never resolves the active namespace like every other tool does.
- `server_status` reads a shared pidfile path and a default port, so a
  scratch-config process reports on the LIVE daemon (port 3000 listening, pid
  null). It cannot answer "is MY instance up?" in multi-instance setups.

### The right way, restated for this codebase

1. Every DuckDB call must be assumed capable of throwing a native exception —
   the process boundary is the only safe catch. Add a crash guard now.
2. Semantic search needs a relevance threshold (DOGFOOD-011) — ranking without
   filtering means "search" returns everything on small namespaces.
3. Writes must echo their destination namespace (DOGFOOD-017) — the sticky
   active namespace across processes silently redirects writes.
4. Board/foreman: the duckbrain-http systemd service restart loop is the canary
   for this class of bug — a watchdog that flags `status=6/ABRT` restarts would
   have caught DOGFOOD-010 the first time it happened.

## 11. Post-auth-flip state (2026-08-26 dogfood) — how auth actually works now

The 08-24 DB-GAP-031 flip made the fleet daemon require API keys. Architecture of the
current auth path:

- Daemon runs `--auth=apikey` (+ `--rate-limit 600`, unix socket). Keys live in
  `~/.duckbrain/auth.json` as `apiKeys: [{key, name, namespaces?}]`; `namespaces`
  absent = unrestricted, present = only those namespaces (403 otherwise).
- Request flow: missing key → 401; bad key → 401; scoped key to non-granted ns → 403;
  good key → handler. REST writes stamp `author: <token-name>@duckbrain.local`.
- **Known asymmetry (DOGFOOD-025):** the REST handler stamps token identity, but the
  MCP-over-HTTP path (`src/mcp/tools/remember.ts`) stamps the host git identity. The
  DB-GAP-031 fix landed in one handler only. Same request, same key, two authors.
- **Known isolation hole (DOGFOOD-026):** `duckbrain token` (the minting CLI) hardcodes
  `~/.duckbrain/auth.json`; `--auth-file`/`DUCKBRAIN_AUTH_FILE` (DB-GAP-043, 08-25)
  redirect only the http daemon's reader. A scratch/judge mint pollutes prod — happened
  to me during this run; restored from backup. The 08-25 incident (auth.json wiped by a
  judge's scratch daemon) is the same class of failure, and DB-GAP-043 fixed only half
  of it.
- The 08-25 incident history is instructive: a judge's tier-2 live verification spawned
  scratch daemons that (a) replaced ~/.duckbrain/auth.json with test keys and (b)
  SIGTERMed the live daemon. Recovery: key-file restore + re-mint + restart. The
  `--auth-file` flag exists precisely so scratch daemons never see the prod store —
  use it for every scratch daemon (I did; prod store untouched all run).

## 12. The arg-parser trap class (recall vs search)

Two CLI parsers drifted: `search` got space-form value capture fixed (RETR-008,
08-19), `recall` did not — `--namespace X` / `--as-of Y` silently become
boolean `true` (DOGFOOD-027, CLI-FIX-001). Worse than an error: it returns
"No memories found" against namespace 'true' — silent wrong results. Lesson:
flag parsers in this codebase need a shared helper, and every "space-form
fixed" task must grep for sibling parsers (search/recall/list-keys/query all
have bespoke parseArgs).

## 13. Semantic search stability (old P0, now fixed)

08-16: every REST `?q=` crashed the daemon (`duckdb::InvalidInputException "Map
keys must be unique."` → SIGABRT; DuckDB auto-infer of duplicate keys in
real-world JSONL). Fix: explicit all-VARCHAR `read_json` schema + `ignore_errors`.
08-26: `?q=` returns ranked scores (0.78/0.559 on a scratch ns), never crashes;
`?q=zzznothing` returns everything on a 4-row ns (ranked) — the 0.25 score floor
is a rank filter, not a relevance gate; small namespaces will always return
something. Treat `.score` as the signal.

## 14. The SQL surface's blind spot

`duckbrain query` runs read-only SQL over a `memories` view (latest per id,
tombstones excluded; mutating keywords and out-of-scope table functions
rejected with explicit messages — verified). But the view does NOT apply the
valid_from/valid_until window that `recall` applies (DOGFOOD-031): expired and
future-dated rows appear in SQL results while the REST current view hides
them. If you query memories, expect raw records, not the validity-filtered
"now" view.

## 15. S3 tier status

Live daemon syncs every 15 min (`intervalSec: 900`, `pushOnCommit: false` +
AUTOPUSH-001 immediate-push on commit flush). `s3 status` against the real
bucket: 80+ namespaces, lastSync timestamps minutes old, local/remote counts
(some namespaces show small local>remote deltas — next sync window catches
them). Cosmetic wart: status prints the placeholder endpoint from config
(`hel1.your-objectstorage.com`) while the real endpoint comes from AWS env
(DOGFOOD-030).

## 16. The health endpoint's degraded contract (GAP-030), and how to test it

`/health` derives one boolean: `degraded = !embedding.healthy || keys_error`.
Degraded ⇒ HTTP **503**, healthy ⇒ 200; the body always carries the detail
(`embedding.providers[].note`, `keys_error`). Two traps when verifying it live:

- **The probes are 30s-TTL cached.** Corrupt something, curl, and you may hit a
  cached healthy answer. Wait out the TTL between state change and probe.
- **The keys probe is a resilient read.** Appending junk bytes to a JSONL chunk
  does NOT fail it (the read path skips bad lines by design — the same
  resilience that keeps duplicate JSON keys from crashing reads, see §13). The
  reliable way to force degraded is a dead embedding provider: point
  `embedding` at an unreachable baseUrl in a scratch config and restart.

Verified 09-04 on a scratch daemon: dead embedder ⇒ 503 + `status:degraded` +
`note:"unreachable"`, while writes stayed 201 and semantic `?q=` still returned
results via the RETR-002 keyword/BM25 fusion fallback (scores are keyword ranks
there, not cosine similarities — don't compare them to healthy-mode scores).
Also seen: during the first seconds after a cold boot the keys probe can report
`Namespace 'undefined' does not exist` (harmless startup race, self-clears);
the `undefined` string in the error is cosmetically wrong and worth a cleanup
task someday.

## 17. The fresh-user path is where the dev box lies to you (09-04)

The dev checkout on the fleet host works even when the repo manifest is wrong,
because its `node_modules` accumulates history: root-level `express` present in
a pnpm repo is a stale artifact, not a dependency. `src/cli/http.ts` imports
express, but no package.json (main OR feat/native-s3) declares it — it enters
the lockfile only transitively via `express-rate-limit@8.6.0(express@5.2.1)`.
pnpm's isolated layout hides transitive deps from application imports, so a
fresh clone + clean `pnpm install --frozen-lockfile` boots straight into
`Cannot find module 'express'`. Proven 09-04 on a throwaway bunker agent
(clean clone of main @ ce936ae): install 32s OK, first boot crash; `pnpm add
express@5.2.1` → /health 200 + full write/read flow 201s. Lesson: on this
project, "works on my machine" proves nothing about the manifest; the
bunker install leg exists precisely to catch this class. Tracked as
DOGFOOD-0904-02; the README prerequisite gap is DOGFOOD-0904-03.

Same class, older sibling: `duckbrain forget` on the CLI hardcodes
`namespace:"default"` (src/cli/human.ts:636) and ignores `--namespace` — it
fails for every non-default namespace while MCP forget works. Found because
the dogfood ran with an isolated scratch config whose default namespace
didn't exist; a dev-box run against the live `default` ns would have masked
it. Isolation finds real bugs. Tracked as DOGFOOD-0904-01.

## 18. Scoped shutdown and daemon lifecycle hardening (OPS-001, 09-12)

On 2026-09-11 a graceful `SIGTERM` to the production daemon exited status 0
and `:3000` stayed dark for 6m57s: the custom unit ran `Restart=on-failure`,
and a graceful stop is not a failure — systemd did exactly what it was told.
The same day's review found the second half of the problem: `pnpm stop` was
`pkill -f 'duckbrain.*http'; pkill -f 'vite'` — a pattern kill that matches
ANY process whose argv mentions the pattern (agents, editors, scratch
daemons on other ports).

Both halves are fixed in-tree; nothing here needs host access:

- **Scoped stop** — `pnpm stop` now runs `scripts/scoped-stop.js`
  (`src/cli/scoped-stop.ts`). It signals only the pid proven by the selected
  port's pidfile (`duckbrain-http-<port>.pid`) to be a live `duckbrain …
  http` command FOR THAT PORT. Missing pidfile → safe no-op (exit 0);
  stale, malformed, pid-reuse, wrong-command, wrong-port, or unreadable-argv
  → refuse, signal nothing, exit nonzero (codes 3/4/5/7; 6 = alive past the
  grace window). Only SIGTERM, never SIGKILL — escalation belongs to
  system. `--port=N` selects the instance; `--socket=PATH` addresses the
  socket-named pidfile of a `--unix-socket` instance; `--json` for scripts.
  Vite/UI is never touched — stop it from its own terminal.
- **Restart=always unit** — `ops/systemd/duckbrain-http.service` (user
  unit). `Restart=always` covers graceful stops AND crashes;
  `StartLimitIntervalSec=300` / `StartLimitBurst=10` rate-limit crash
  loops; `TimeoutStopSec=30` bounds the SIGTERM→SIGKILL window.
- **Dark-port watchdog** — `ops/systemd/duckbrain-http-health.service` +
  `.timer`: probes `/health` every minute through
  `scripts/health-check.js` (`src/cli/health-check.ts`). Contract: HTTP 200
  or 503 = ALIVE (503 degraded is the intentional embedding-health state,
  GAP-030); connection failure or any other status (squatter 404, proxy
  401) = DARK, exit 1. `/health` is auth-exempt, so the check carries no
  keys. This catches the states Restart cannot: unit disabled/masked, port
  squatted by something else.

Install/verify/scratch-isolation commands live in
[docs/guide/deployment.md § systemd hardening](../guide/deployment.md).
`pnpm ops:check` fails the build if a pattern/numeric kill ever re-enters
package scripts.

## 19. The watchdog could see the dark port but could not fix it (GAP-059, 09-19)

The OPS-001 watchdog pair is a correct *detector* and a useless *actuator*: a
static `Type=oneshot` has no restart ability of its own. On 2026-09-19 at
`11:11:51` a maintenance stop of `duckbrain-http.service` left `:3000` dark;
the health watchdog fired on schedule, classified it DARK, exited 1 — and
`:3000` stayed dark until an operator ran `systemctl --user start` by hand at
`11:29:43`. **~18 minutes** of downtime, during which every scheduler sync
call spooled. Nothing was misconfigured: `Restart=always` on the daemon covers
crashes *and* graceful stops, so the only dark state left was exactly the
intentional stop the watchdog saw and no unit was allowed to act on. A
detector with no teeth turns a 3-second stop into an 18-minute outage.

The fix keeps detection and actuation as separate units, so a failed recovery
can never damage the detector:

- **`duckbrain-http-recover.service` + `.timer`** (GAP-059) — a second
  unprivileged pass, `*:*:30` (offset from the watchdog's `:00` so the
  confirming probe reads fresh darkness), running
  `scripts/watchdog-recover.js` (`src/cli/watchdog-recover.ts`, deps-injectable
  like `scoped-stop.ts`). DARK increments a consecutive-dark counter in
  `%h/duckbrain/.watchdog/duckbrain-http.dark-count`; at `--confirm-probes` it
  issues `systemctl --user start duckbrain-http.service`, timestamps the
  attempt, and re-probes `/health` once. ALIVE clears the counter.
- **HUNG is explicit non-action** — a stuck handler means the daemon may still
  be serving `/api/*` and MCP traffic, so the counter is left byte-identical
  and no restart is issued (the OPS-002 split exists for exactly this).
- **Cooldown, not a retry storm** — a recorded attempt suppresses further
  restarts for `--cooldown-s` (600s), so a genuinely broken unit is started at
  most once per 10 minutes instead of once per minute. Intentional long
  downtime therefore stops the timer first (maintenance contract in the
  deployment guide).

Verified live with a stop-drill: the daemon was stopped on purpose, nothing
was started by hand, and the port answered again on its own (the recover unit's
`systemctl --user start` action is in its journal). Design, install,
maintenance contract and the drill command live in
[docs/guide/deployment.md § hardened lifecycle assets](../guide/deployment.md).

## Run 6 — 2026-09-19 dogfood (fresh-install focus + full API re-walk)

This run asked one question the previous runs never did: what happens to a
user who starts from nothing? The control-host checkout cannot answer that —
its node_modules is a year of accretion. The ephemeral bunker (las-bunker-03,
agent 7649b92c, destroyed after) is the honest environment.

Why the two fresh-install breakers were invisible until now:

- DF-0919-01 (express unlinked on fresh store). DOGFOOD-0904-02 fixed the
  declaration (express moved from phantom to direct dep, lockfile updated) —
  but pnpm 12.4.2's isolated linker still skipped ~30 root-level symlinks on
  the fresh store despite the lockfile and .modules.yaml listing express.
  Dev checkouts never hit this: their node_modules predates the pnpm bump, so
  pnpm install is a no-op there. Lesson: an install leg must run on a store
  that never saw the old lockfile. `pnpm add express@5.2.1` repairs it because
  a real add re-runs the linker, which then links everything correctly — the
  package itself was never the problem.
- DF-0919-02 (baseUrl vs TS7). packages/ui/tsconfig.json still carries
  baseUrl, removed in TypeScript 7. Local builds pass because dev
  node_modules holds the old TS. Same root pattern: stale dev environments
  hide fresh-environment breakage. Anything gated only on the dev checkout
  (pre-commit guards, pnpm tsc --noEmit) cannot see it.

Health-signal design (DF-0919-04): the aggregate /health state counts
never-configured providers as unhealthy. On a fresh daemon every write and
recall works, yet HTTP says 503 degraded. Degradation should mean "a
configured capability is down", not "a provider exists in the enum without a
key". GAP-030's 503-for-degraded contract is fine; the degraded computation
is what is off.

What held up: the full usage-skill contract re-verified clean this run —
scoped tokens (403/401), MCP field names, SSE cursor framing, git batching,
validity windows (with the camelCase trap, DF-0919-05). CLI forget in
non-default namespaces now works (DOGFOOD-0904-01 fix confirmed in
src/cli/human.ts forgetCommand — flag resolves via getDefaultNamespace()).

## Run 7 — 2026-09-23 dogfood (namespace deletion lifecycle focus)

The surface (commit e3a9852, 2026-09-22): DuckBrain now has TWO deletion
operations instead of one boolean-flagged one. `delete-from-disk` removes the
local dir + config mapping + the per-ns S3 sync manifest and STOPS scheduled
pushes, but the S3 objects stay retrievable (that was Bane's requirement:
"namespaces removed from disk should turn off but keep the S3 version").
`clear-from-s3` is the reverse: remote-only destruction with an explicit
--yes + --dry-run + who/why. A ghost sweep (`s3 ghosts [--sweep]`) prunes
manifests/mappings whose namespace dir is already gone — the 88-ghost
ENOENT-retry class of 09-21/22. The root cause was that the sync manifest
lives OUTSIDE the namespace dir (<namespaces>/.s3state/<ns>.json), so every
previous delete left dead namespaces on the 15-minute push cadence forever.

How to think about it: disk-deletion is the SAFE operation (S3 = backup that
survives), S3-clear is the destructive one (guarded by dry-run + explicit
--yes + audit). If you delete from disk and want the data back, pull /
git-clone the S3 prefix. Both log to <namespaces>/.s3state/lifecycle.log —
one JSONL line per op, who/why attached.

What the run proved: the CLI path is genuinely good — usage errors exit 1,
the in-flight-push lock guard refuses with an exact reason, the audit line
lands, the daemon behind it stays coherent (deleted ns → 404, no ghosting at
HEAD). The ghost sweep detected and pruned seeded ghost state correctly.

What bit (rows DF-0923-01..05):

- DF-0923-01 (P1) — the guard is CLI-only. The shared core deleteNamespace
  (src/namespaces/delete.ts) that REST DELETE /api/namespaces/:name and MCP
  delete_namespace both call never checks hasInFlightPush. Live-proven: same
  lock that blocks the CLI does NOT block REST (200, dir gone). Half-landed
  S3 pushes — the exact ghost-generating scenario — are reachable through the
  surfaces agents actually use. Lesson: when a safety property is added, the
  wiring must be audited per SURFACE (CLI/REST/MCP), not per function; the
  function was extracted to be shared, but the new property was bolted onto
  one caller.
- DF-0923-02 (P2) — REST/MCP deletion writes no lifecycle.log line. Audit
  coverage follows the same caller-shaped hole. An agent deleting memory
  through MCP leaves no who/why anywhere.
- DF-0923-03 (P2) — zero docs for the whole feature; and plain
  `namespace delete` silently changed semantic (disk-only now; old scripts
  expected purge semantics). Semantic changes need a release note and a
  README ops section, not just --help.
- DF-0923-04 (P2) — compose path broken fresh (probe 000, chaos-shutdown
  rc=1). The compose stack is the documented "production" path and fails its
  own restart lifecycle on a clean machine.
- DF-0923-05 (P3) — no npm artifact; the upgrade cell can never pass.
  Distribution decision, not a bug.

Probe lessons (would have produced two false findings):

- The in-flight lock's ts must be current epoch MILLISECONDS. `date +%s%3N`
  on this box prints nanoseconds; a garbage ts parses as stale-future and the
  guard silently ignores it — first probe falsely read "guard broken".
  Read the ts format the code actually expects before trusting a guard
  probe. Conversely: a lock that LOOKS stale is ignored by design (10-min
  window), which is the correct behavior for a crashed pusher.
- The battery's ui-probe FAIL is a harness misfit, not a product defect:
  duckbrain's root `npm run dev` IS the backend (logged "HTTP server ready");
  the cell probes :3111 expecting a frontend dev server. packages/ui has its
  own build path (vite, works — 2.19s build locally). Read what the harness
  detected vs what the repo's actual UI story is before filing.
- EXIT codes: report the COMMAND's rc, not the pipeline's (PIPESTATUS[0]
  rule again — first exit-code sweep read head's rc).

## Run 8 — 2026-09-24 dogfood (as-of time-travel focus — the flagship never tested)

Angle: runs 1–7 covered CLI/REST/MCP lifecycle, install, deletion — none ever
exercised as-of recall, the README's "Available now" flagship. This run is the
first proof it works as advertised, and the first proof of what a fresh user
actually gets.

**How it was tested.** Scratch daemon `:3793` (config + namespaces + embeddings
cache under `/tmp/dogfood-duckbrain-0924/`, git batching tightened to
maxSeconds=3 so auto-commits land fast). Battery: HTTP `?as_of=` over
{first-commit sha, HEAD sha, tag, branch, same-day date, pre-history date,
unknown ref, commitless namespace, ghost namespace, instant-between-commits,
as_of+q, as_of+historical}; CLI `recall --as-of` (space + equals forms, short
SHA); MCP `recall.asOf` over MCP-over-HTTP (initialize handshake needs
`Accept: application/json, text/event-stream` — the -32000 "Not Acceptable"
error tells you, but nothing documents it); forget→tombstone→as-of-recovery;
`git status` on the namespace worktree after every query (no-checkout claim);
`git show <ref>:raw_note/...` (storage inspectability); curl timings n=20.

**What the battery proved.** On current HEAD the feature is genuinely done:
all ref forms resolve, second-level instant precision, correct 400s at the
edges, tombstoned rows recoverable at pre-forget refs, zero worktree mutation,
30.4ms warm vs 6.1ms current (as-of tax real but invisible). The only dev-side
defect: `as_of+q=` returns 500 where 400 is honest (DF-0924-04); the retr004
test cements the wrong status.

**What the bunker leg proved (the run's real finding).** Fresh clone of the
published origin = ce936ae (Aug 07, 679 commits behind local HEAD; local work
lives on feat/native-s3). Consequences measured end-to-end: (1) the documented
quickstart dies at boot — `Cannot find module 'express'` (DF-0919-01's fix
never reached the branch users clone; express absent from package.json
dependencies on main, `--frozen-lockfile` resolves only the peer edge);
(2) `src/git/asof.ts` does not exist there, and the stale server answers
`?as_of=2026-09-01` (before any commit) with **200 + current-state rows** —
the flagship parameter is accepted and silently lies (DF-0924-02, P0);
(3) the stale pidfile is a hardcoded `/tmp/duckbrain-http.pid`: EACCES on a
shared host, and ENOENT crash when DUCKBRAIN_DATA_DIR names a non-existent
dir — both already fixed at HEAD (per-port pidfile + cleanupStalePidFile +
stale removal). After `pnpm add express@5.2.1` + precreating the data dir, the
README quickstart passed 4/4 on the stale main — the engine underneath was
already good in August; it's the release pipeline that is broken.

**Right way / lessons.**
- Verify "works" claims against the artifact a user can actually obtain: clone
  the published default branch, not the local checkout. Every green test in
  the repo coexisted with a fresh-install boot failure and a missing flagship.
- A silent-success parameter (200 with wrong data) is worse than a 404/501:
  callers cannot detect the version gap. Feature-detect by probing the error
  path (as_of before first commit must 400) before trusting as-of answers.
- Evidence hygiene on shared bunker hosts: `/tmp` files from other agents
  alias your logs (a stale "Done in 38.2s" from a previous agent masqueraded
  as my install result) — write scratch under $HOME; `pkill -f` inside a
  remote one-liner self-kills the ssh (its own command line matches).
- MCP handshake: the streamable transport requires the dual Accept header;
  probe it once, record it in the usage skill.
- append-only storage means the current view legitimately returns superseded
  rows side-by-side with current (latest-per-key is the by-key GET's job, and
  tombstoned rows drop out there); as-of is per-ref, not per-key-latest —
  read them as different questions.
## Run 9 — 2026-09-24 dogfood (web-UI focus — the surface runs 1–8 never drove)

The angle law (skill: change the ANGLE, not the depth) is what found this:
runs 1–8 proved the CLI/REST/MCP/as-of surfaces; the Web UI had been touched
once (08-16, "boots"). This run drove the built UI against a scratch daemon
and the UI's own production bundle.

### How the pieces fit (the "why" of what a user sees)

- `packages/ui` is a Vite React app whose ONLY backend connection is the dev
  proxy (`vite.config.ts` → `http://localhost:3000`, retargetable with
  `DUCKBRAIN_API_PORT`) — and, in production builds, nothing at all: the
  daemon serves no static files, so the built UI must be served by something
  else and pointed at the daemon, but every `apiFetch` call is RELATIVE
  (`API_BASE = "/api"`), which only works when the UI is behind the dev
  proxy. That is a structural one-host assumption nobody documented.
- The auth contract is one-directional: the daemon can require keys, the UI
  can never send one. No token input, no storage, no header. A hardened
  deployment (the README's own recommended mode) renders a permanently
  empty dashboard and says nothing.
- The namespace contract is split-brain by design accident: the on-disk
  namespaces root is the real source of truth for writes (write path joins
  root/name), but GET /api/namespaces and /switch read config
  namespaceMappings only. The UI then hardcodes "default" — the one name
  that typically has no mapping and often no directory — and every panel
  404s forever. The server even reports `directoryMissing: true` for the
  phantom default and the UI ignores the whole field.

### Errors hit this run, and the right way around each

- `--auth-file` must be a PARSED auth-store JSON (`{apiKeys:[{keyHash,name}]}`),
  not a plaintext secret list; DB-GAP-043 makes a missing/unparseable explicit
  file FATAL (good — that hardening worked exactly as designed). Mint the
  token with `duckbrain token --name=X` + `DUCKBRAIN_AUTH_FILE` env so the
  store is created in the right shape.
- `DUCKBRAIN_NAMESPACES_PATH` is a DIRECTORY (the namespaces root), not a
  registry file. Pointing it at a JSON file yields `ENOTDIR: not a directory,
  mkdir '.../namespaces.json/dogfood-ui'` — a confusing error because the
  config path variable in the same docs is a file. The deployment doc
  (docs/guide/deployment.md:253) has this right; nothing else does.
- Headless `--dump-dom` against `vite dev` hangs/returns an empty shell —
  vite dev's HMR websocket keeps virtual time from settling. For headless
  probes, use the PRODUCTION build (`pnpm --filter @duckbrain/ui build` +
  `npx vite preview`); it renders deterministically in ~10s.
- `duckbrain http --help` does not print help — it STARTS A SERVER against
  the resolved (production) config and overwrites /tmp/duckbrain-http-3000.pid
  (the prod daemon reclaimed its pidfile on the next health write, no harm
  done here, but a second prod-shaped daemon on :3000 would have failed to
  bind after the real one died — a real ops trap). The right way: read
  src/cli/http.ts or the usage skill, never `--help` on subcommands.
- The one-run near-miss: `bunker-qa.sh` defaulted to `bunker-las-02`, whose
  bunkerd has been crash-looping 2000+ restarts (refuses non-loopback
  plaintext listeners). Pass `--server bunker-las-03` AND `BUNKER_QA_SERVER`
  env (the script ignores the CLI flag when set after the default line).

### The right way to verify the UI (next run should start here)

1. Build it: `pnpm --filter @duckbrain/ui build` (4.2s, 481KB).
2. Serve it: `npx vite preview --port 8996` from packages/ui (no proxy in
   preview mode — /api calls 401/404 relative; that mismatch is DF-0924-08).
3. Point Lighthouse at the preview URL and READ THE NETWORK TABLE, not the
   score: the 404/401 pattern per panel names the broken contract instantly.

## Run 10 — 2026-09-25 dogfood (SSE change-feed focus — the realtime surface, never driven)

### How the change feed actually works (the one-page version)

- The audit ledger `_audit/current.jsonl` per namespace is the changelog. The
  serializer (`NamespaceWriter.flushOnce`) appends data lines + accepted audit
  lines under the namespace write lock (`src/serialization/lock.ts`), then
  *schedules* a debounced git commit (30s / 100 lines) and wakes the feed.
- The feed (`src/http/realtime/hub.ts` + `replay.ts`) never trusts timers:
  it publishes a change only when a successful reachable `HEAD` proves the
  commit exists. Ordinals are DERIVED per commit by diffing the `_audit` tree
  parent→child (contiguous 1..N), so restarts and multiple flushes in one
  commit cannot corrupt ordering. There is no counter to reset — that is the
  whole trick.
- Cursors are `dbch1.<base64url({v,ns,commit,ordinal})>`, unsigned by design.
  Debuggable by hand; validation proves the commit is reachable and the
  ordinal names exactly one audit record; a pruned commit gives 410 with
  resync guidance.
- Subscription authorization re-checks the table grant before every live
  enqueue — but see DF-0925-05: revocation is only observed on the next event.
- Live filtering (tables/ops) applies in the delivery loop; REPLAY-side
  filtering is missing (DF-0925-01) — treat reconnected streams as unfiltered
  until that row closes.

### Errors hit this run and the right way around them

- `--auth-file` that does not exist is FATAL for `token` too, not just `http`:
  mint the store FIRST with `token --auth-file=<path>` (which creates it), or
  write `{"apiKeys":[]}` yourself. Never copy the production store into a
  scratch file in a path the daemon may re-read.
- A malformed scratch auth.json mid-run makes the daemon log "auth store
  reload failed; retaining last good snapshot" and every new key 401s with NO
  error on the request path — check the daemon log, not the HTTP response.
- The commit debounce (gitBatching.maxSeconds=30) IS the event latency: a
  write acks in ~20ms but the subscriber sees it up to 30s later. That is
  SUPA-5's committed-only trade, documented — don't file it as a bug.
- Replay vs live filtering differ (DF-0925-01). Proven by subscribing
  `ops=insert` live (1 insert, 0 deletes) then reconnecting with a cursor
  (242 events: 241 inserts + 1 delete). Test both sides of any filter.
- To audit data/audit commit parity: for each commit, diff `_audit` line count
  vs data-line count parent→child; any mismatch is a split-commit (DF-0925-02).

### Numbers worth keeping

- subscribe→ready: 68 ms ± 4 ms warm (n=10)
- POST write: 18 ms ± 7.6 ms (n=20)
- write ack → subscriber event: 9.2 s measured (bounded by the 30s debounce)
- 500-write burst through 100 rpm limiter: 103×201 + 97×429; ledger exactly
  equals acked writes; feed replay later delivered 100% of them, contiguous.
