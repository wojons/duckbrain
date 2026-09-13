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
| `src/embedding/preflight.ts` | OPS-004 preflight: reachability vs real usability, classed failures, secret-safe report |
| `scripts/embedding-preflight.js` | CLI wrapper (`pnpm ops:embedding-preflight`); exit 0 usable / 1 fail closed / 2 usage |

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

## Ollama deployment (recommended)

The default model id `text-embedding-qwen3-embedding-0.6b` is a **deployment
alias** of the real Ollama library tag `qwen3-embedding:0.6b`. Deploy with:

```bash
ollama pull qwen3-embedding:0.6b          # ~500MB, the real library tag
ollama cp qwen3-embedding:0.6b text-embedding-qwen3-embedding-0.6b   # alias under the configured id
```

**Why the alias — never rename the model id in config.** The `.embeddings`
cache keys are `sha256(modelId + contentHash)` (see Design above), so the
cache is keyed by `provider/model`. Renaming the model id in
`duckbrain.config.json` / `src/config/index.ts` invalidates every namespace's
`.embeddings` cache and forces a fleet-wide cold rebuild. `ollama cp` creates
a second name for the **same weights**, so the configured id resolves against
the live server while every existing cache key stays valid.

**Dimensions note.** `qwen3-embedding:0.6b` emits 1024-dim vectors. The
config `dimensions=384` is metadata-only: `cache.ts` stores
`vector.length` and search ranks by cosine over the stored vectors, so
there is no dimension mismatch. `duckbrain embeddings status` reports the
real dims (1024) from a live embed.

**Warmup before health.** Ollama unloads models after idle (default 5m), and
the first embed after load pays model-load latency (seconds). Warm the model
once after deploy so the first real query — and the daemon's health probe —
don't pay load latency:

```bash
curl -s -m 120 http://localhost:11434/api/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"text-embedding-qwen3-embedding-0.6b","input":"ping"}'
```

Verify the alias is live: `ollama list` and `http://localhost:11434/api/tags`
must both show `text-embedding-qwen3-embedding-0.6b` with capabilities
`["embedding"]`.

## Preflight & provider diagnosis (OPS-004)

**Reachable is not usable.** A provider can answer its reachability route with
HTTP 200 while every embed fails. Live on 2026-09-12: `GET /v1/models` answered
`200` with the deployment's own key, `POST /v1/embeddings` answered `401`, and
`/health` reported `embedding.healthy=false` — while an authenticated `?q=`
query still returned `200` in 5–8s (and, in a later degraded window, `500`
`Semantic search timed out after 30s`). `/health` alone cannot separate those
cases, so probe the path end to end:

```bash
pnpm ops:embedding-preflight                               # human report
node scripts/embedding-preflight.js --json                 # machine-readable report
node scripts/embedding-preflight.js --provider=lmstudio    # compare a LOCAL provider (no daemon change)
node scripts/embedding-preflight.js --provider=ollama
node scripts/embedding-preflight.js --expect-dims=4096     # declare dimensions as a contract
```

Exit **0** = a real embed succeeded through the effective provider. Exit **1** =
FAIL CLOSED: usability was not proven (auth, timeout, empty vector, wrong
dimensions, unreachable, upstream error) — including the OPS-004 asymmetric
condition where reachability passes and the embed does not. Exit **2** = usage
error. Gate on the exit code; read `summary` for the verdict.

With no `--provider` and no `DUCKBRAIN_EMBEDDING_PROVIDER`, the effective
provider is `auto` (the documented default): the preflight probes the registry
in priority order — lmstudio → ollama → openai — continues past a
reachable-but-unusable candidate, and selects the first provider whose **real
embed** succeeds (the same fallback the runtime applies at recall time). The
report names the concrete winner; `auto` fails closed only when **no**
candidate proves usability — reachability alone never counts. An explicit
provider remains a hard requirement: one candidate, no fallback.

The report never contains the API key. There is deliberately **no `--api-key`
flag**: a credential on a command line is visible to every process on the host
(`ps`) and lands in shell history. The key is read from
`DUCKBRAIN_EMBEDDING_API_KEY` / the config file, the endpoint is
credential-stripped, and provider text is redacted — the report carries only
`key_present: yes|no`.

| check | pass | warn | fail |
|-------|------|------|------|
| `reachability` | the route the daemon's cheap gate probes answered 2xx | — | non-2xx or transport failure (the `auto` path drops such a provider) |
| `usability` | real 1-token embed returned a vector, through the provider's own `build()` — the same code path recall uses | — | any embedding failure (class below) |
| `dimensions` | live vector length equals the declared count | declared count is only the schema default (384) — documented metadata-only case | operator declared dims (`DUCKBRAIN_EMBEDDING_DIMENSIONS` / `--expect-dims`) and the live model returns a different length |
| `health_budget` | embed finished inside the 3000ms `/health` probe budget | slower than that budget → `/health` can flap to `degraded` while `?q=` still works | — (never a fail; it is a probe-budget fact, not an outage) |

A `skip` verdict is an honest non-attempt, not a pass: under `auto`, a
candidate whose cheap reachability gate failed (non-2xx or transport error)
is excluded **without its embeddings route ever being called** — the same
`isHealthy` filter the runtime applies in `createAutoProviders` — and
`dimensions`/`health_budget` skip whenever no vector was produced.

### What each signal means (verified against the live provider, 2026-09-12)

| signal | class | what it actually means |
|--------|-------|------------------------|
| `401 Missing Authentication header` | `credential_not_presented` | the request carried **no usable credential** — empty or scheme-less `Authorization`. It can NEVER mean "the key lacks embeddings scope": a presented-but-rejected key reports differently |
| `401 No cookie auth credentials found` | `credential_not_presented` | no `Authorization` header at all |
| `401 User not found.` | `credential_rejected` | a credential WAS presented and the provider did not recognize it |
| `The operation was aborted due to timeout` | `timeout` | the **health probe's 3000ms budget** expired — not `DUCKBRAIN_EMBEDDING_TIMEOUT_MS`, and not proof the provider is broken |
| `429` / `5xx` | `rate_limited` / `upstream_error` | upstream condition: retry/backoff, not config |
| `404` | `route_or_model_missing` | wrong base URL or model id |
| `200` with an empty vector | `empty_vector` | the server answered without a vector (e.g. a chat-only model) |

Since OPS-004 the `/health` note names the class for the auth, timeout and
empty-vector cases ("auth: credential not presented …", "timeout: the embed
probe exceeded its 3000ms health budget …"); every other class keeps the raw
provider string verbatim.

### Config precedence (highest first)

1. **explicit** — preflight `--provider` / `--model` / `--base-url`, probe parameter
2. **env** `DUCKBRAIN_EMBEDDING_*` — where a systemd drop-in's `Environment=` lands
3. **config file** `duckbrain.config.json` → `embedding{}`
4. **schema defaults** — provider `auto`, model `text-embedding-qwen3-embedding-0.6b`, dimensions `384`, timeout `10000`ms

Two precedence facts that made OPS-004 expensive:

- **systemd captures `Environment=` at process START.** `systemctl --user
  daemon-reload` re-reads unit files but does NOT change a running process's
  environment — a drop-in edit needs `restart` to take effect. A daemon still
  running a pre-edit environment reports the old config forever, and an empty
  key produces exactly the `401 Missing Authentication header` signature (the
  provider code sends `Authorization: Bearer ${key || ""}`, so an unset key
  still reaches the wire as an empty credential).
- **The config FILE's `embedding` block is read by `/health` (and by this
  preflight) only.** Recall and rebuilds resolve env + defaults
  (`resolveEmbeddingConfig`). A provider/base URL set in the file but not in env
  can therefore show up in `/health` without affecting `?q=` — set the ENV layer
  for anything both paths must honour.

### Remote vs local (measured on this host, 2026-09-12)

| provider | model | dims | observed embed latency | `/health` budget risk |
|----------|-------|------|------------------------|-----------------------|
| `openai` → `https://openrouter.ai/api/v1` | `qwen/qwen3-embedding-8b` | 4096 | 29 real calls, every one HTTP 200 with a 4096-dim vector: healthy window median ~0.74s; 3 calls 5.3–16.5s; one degraded-window burst 22.9s, 24.0s, 4.5s, 1.0s, 3.3s | **yes** — ~12% of calls exceed the 3000ms probe budget, so `embedding.healthy=false` flaps while `?q=` succeeds |
| `lmstudio` → `http://localhost:1234/v1` | `text-embedding-qwen3-embedding-0.6b` | 1024 | ~1.8s (includes model load) | no |
| `ollama` → `http://localhost:11434` | same alias | 1024 | ~1.5s | no |

Observed live while writing this runbook — the two readings side by side:

```text
GET /health            → 503 {"status":"degraded",
                              "embedding":{"provider":"","healthy":false,
                              "providers":[{"id":"openai","healthy":false,
                              "note":"The operation was aborted due to timeout"}]}}
?q= query              → 500 {"error":"Semantic search timed out after 30s"}
pnpm ops:embedding-preflight → exit 0: real embed OK, 4096 dims in 7273ms,
                              health_budget WARN (7273ms > 3000ms budget)
```

The provider was **slow, not broken, and no credential was involved** — `/health`
alone could not say that. When the tail reaches ~23s per embed, `?q=` can also
exceed `SEMANTIC_TIMEOUT_MS` (30s, `src/mcp/tools/recall.ts`) and fail with 500,
because the on-the-fly cache fill embeds candidates sequentially and a slow
provider multiplies: the same slow-provider root cause surfaces as a 503 from
`/health` and a 500 from `?q=`. Neither is an auth or config failure.

Decision: the remote provider is chosen deliberately (4096-dim vectors, no local
model load) and its **tail** latency means `/health` may report `degraded`
intermittently — that is a probe-budget artifact, not an outage. Confirm with
this preflight (it reports `health_budget: warn` and the measured ms) plus a
real `?q=` query before treating a degraded reading as an incident. If a
consistently green `/health` is required, prefer a local provider (see the
Ollama deployment section). Do **not** raise the health-probe budget to mask a
slow provider: `/health` must answer inside its 4000ms handler deadline, and a
health check that waits for the slowest call stops being a health check.

### Rollback / fallback (ops-owned — documented here, never applied by a worker)

1. Edit the drop-in (`systemctl --user edit duckbrain-http.service`, or the
   existing `~/.config/systemd/user/duckbrain-http.service.d/override.conf`) and
   **remove all six** `Environment=DUCKBRAIN_EMBEDDING_*` lines. Removing only
   the provider is not enough: `baseUrl` is a single field shared by every
   provider, so a leftover remote base URL would send a local provider to the
   remote host.
2. `systemctl --user daemon-reload && systemctl --user restart duckbrain-http.service`
   — the restart is what re-reads the environment.
3. Verify, in this order: `pnpm ops:embedding-preflight` (exit 0, provider
   `lmstudio` or `ollama`), then `curl -s http://127.0.0.1:3000/health | jq
   .embedding` (`healthy: true`), then one real `?q=` query.
4. Fallback to a specific local provider instead of `auto` by setting
   `DUCKBRAIN_EMBEDDING_PROVIDER=ollama` (env) and nothing else.
5. Rolling back the rollback = restore the drop-in lines and restart again.

Switching provider/model does **not** corrupt existing vectors: the cache is
keyed `sha256(modelId + contentHash)`, so the new model gets its own cold
namespace — warm it with `duckbrain embeddings rebuild --namespace=<ns>` (the
git hooks do this detached after checkout/merge).

## Tests

`src/embedding/*.test.ts` + `src/cli/embeddings.test.ts` — 46 tests covering:
cache round-trip, model isolation, corrupted-entry tolerance, gitignore
idempotence, cold/delta/force rebuilds, provider-failure counting, cosine
ranking, on-the-fly fill caps, hook install/exec bits, CLI arg forms
(`--namespace=X` and `--namespace X`).
