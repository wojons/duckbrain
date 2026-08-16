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
