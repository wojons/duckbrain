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
