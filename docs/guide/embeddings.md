# Embeddings & Semantic Search

## Design (Bane, 2026-08-02 — resolves DB-001)

> "We need to resolve the embedding store for things... we don't store the
> embeddings on git it might be a lot of space. Different people have or want
> to use different embeddings, so we might need something else — like when you
> pull clone and on hooks it keeps a cache of the embeddings and it uses those
> models for you so it rebuilds with cache assist. This just means old ones can
> take a while."

Three decisions fall out of this:

1. **No vectors in git.** The embedding cache is a per-namespace directory
   (`.embeddings/`, gitignored automatically). JSONL memories are the source of
   truth; vectors are rebuildable artifacts.
2. **Model-agnostic store.** Cache keys are `sha256(modelId + contentHash)`,
   so every model has its own cache namespace. Multiple people on the same
   repo can use different embedding models with zero interference.
3. **Cache-assisted rebuild via git hooks.** `post-checkout` / `post-merge` /
   `post-rewrite` hooks fire a detached rebuild after clone/pull. Unchanged
   content hits the cache (fast); new content or a new model embeds (slow on
   cold start — accepted).

## Components

| File | Role |
|------|------|
| `src/embedding/providers.ts` | Provider registry: lmstudio (default), ollama, openai, auto-probe |
| `src/embedding/cache.ts` | Content-addressed store (`.embeddings/`), atomic writes, gitignore helper |
| `src/embedding/rebuild.ts` | Cache-assisted rebuild: hash → cache hit skip / embed miss |
| `src/embedding/hooks.ts` | Git hook installer (detached rebuild on clone/pull/rewrite) |
| `src/embedding/search.ts` | Cosine ranking over cached vectors + on-the-fly fills |

## CLI

```bash
duckbrain embeddings status                          # stats, models, hooks state
duckbrain embeddings rebuild --namespace=my-ns       # cache-assisted rebuild
duckbrain embeddings rebuild --force                 # re-embed everything
duckbrain embeddings rebuild --concurrency=8         # parallel embeds
duckbrain embeddings install-hooks --namespace=my-ns # install git hooks
duckbrain embeddings providers                       # list providers + env overrides
```

## Configuration

Config block `embedding` (or env vars):

| Field | Env | Default |
|-------|-----|---------|
| `provider` | `DUCKBRAIN_EMBEDDING_PROVIDER` | `auto` (probe lmstudio → ollama → openai) |
| `model` | `DUCKBRAIN_EMBEDDING_MODEL` | `text-embedding-qwen3-embedding-0.6b` |
| `baseUrl` | `DUCKBRAIN_EMBEDDING_BASE_URL` | provider default (`http://localhost:1234/v1` etc.) |
| `apiKey` | `DUCKBRAIN_EMBEDDING_API_KEY` | — (openai) |
| `dimensions` | `DUCKBRAIN_EMBEDDING_DIMENSIONS` | `384` |
| `cacheDir` | — | `.embeddings` (namespace-relative, gitignored) |
| `concurrency` | — | `4` |

## How it works

### Rebuild (cache assist)

1. Walk all JSONL partitions in the namespace; collect unique `embedding_text`
   values (deduped, `.embeddings/` and `.git` skipped).
2. For each text: `contentHash = sha256(text)`.
3. Cache hit for `(modelId, contentHash)` → skip (counts as `cacheHits`).
4. Cache miss → `provider.embed(text)` → atomic write → `embedded++`.
5. Progress callback at each item; result JSON includes total/embedded/
   cacheHits/skipped/failed/errors.

### Hooks

Installed hooks run:

```sh
REPO_ROOT="$(git rev-parse --show-toplevel || pwd)"
"<duckbrain-bin>" embeddings rebuild --namespace "<ns>" \
  --detached --log "${REPO_ROOT}/.embeddings/rebuild.log" &
```

`--detached` re-spawns the rebuild as a disowned child so git never blocks.
Set `DUCKBRAIN_SKIP_EMBED_REBUILD=1` to suppress (e.g. in CI).

### Semantic search (`recall` with `query`)

1. Provider embeds the query text.
2. Candidates fetched WITHOUT the DuckDB embedding filter (JSONL has no vector
   column — vectors live only in the cache).
3. Each candidate's vector looked up by content hash; cache misses are embedded
   on the fly (capped at `limit*10` or 100 candidates, `maxOnTheFlyEmbeds`).
4. Rank by cosine similarity; return top `limit`.

## Git hygiene

- `.gitignore` in each namespace gets `/.embeddings/` appended on first rebuild
  or `install-hooks` (via `ensureCacheGitignored`).
- `duckdb.db` remains tracked (schema/query layer, 12K per namespace) — vectors
  never enter it.

## Boot durability (LM Studio host)

The embedding provider depends on LM Studio serving the model. On the fleet
host, `lmstudio-server.service` (user unit, tracked at `ops/lmstudio-server.service`)
auto-loads `text-embedding-qwen3-embedding-0.6b` after boot via an
`ExecStartPost` retry loop (`lms load ...` up to 30×2s until the LM Link is
ready), so `/health` reports `embedding.healthy=true` without manual `lms load`
after restart/reboot. Deploy: copy the unit to
`~/.config/systemd/user/lmstudio-server.service`, `systemctl --user daemon-reload`,
then `systemctl --user restart lmstudio-server.service` and verify with
`lms ps` + `curl -s http://127.0.0.1:3000/health | jq .embedding`.

## Tests

`src/embedding/*.test.ts` + `src/cli/embeddings.test.ts` — 46 tests covering:
cache round-trip, model isolation, corrupted-entry tolerance, gitignore
idempotence, cold/delta/force rebuilds, provider-failure counting, cosine
ranking, on-the-fly fill caps, hook install/exec bits, CLI arg forms
(`--namespace=X` and `--namespace X`).
