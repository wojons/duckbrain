# Agentic Memory Roadmap — Time-Based & Query-Based Features

**Status:** Draft for Bane review · **Date:** 2026-08-18 · **Author:** KaraHermes

## 0. Current state (verified against code, 2026-08-18)

DuckBrain's architecture is **file-first, not database-first**:

```
git (canonical truth, S3-mirrored)
  └─ JSONL partitions per namespace (the memory)
       ├─ DuckDB = stateless query container that READS the JSONL directly
       │   (nothing to rebuild — the DB file is an empty shell)
       └─ Embedding cache = gitignored, content-addressed, REBUILDABLE
           (`duckbrain embeddings rebuild` + post-checkout/merge/rewrite hooks)
```

Retrieval surface today (all verified in src/):

| Path | Capability |
|---|---|
| Exact key | `recall key=/a/b` — precise addressing |
| Prefix glob | `recall key=/projects/*` / `list-keys --prefix` |
| Domain filter | `recall domain=config` |
| Semantic | `?q=` / `recall q=` — embeddings, cosine, min-score 0.25 (DOGFOOD-011) |
| **Missing** | ❌ Keyword/FTS search · ❌ SQL query surface · ❌ Cross-namespace text search · ❌ Time-scoped queries · ❌ Attribute filters in recall |

**Why day-to-day feels complete:** the working paths are key-addressed (structured keys like `/project/duckbrain/status`, dated chat-archive keys). That's precise and fast — it's a well-organized filesystem. What's absent is the *free-text and time* query surface: "find everything mentioning GAP-020", "what did we know on Aug 10".

---

## 1. Time-Based Features

### T-1. Time-scoped recall — Effort S
`recall`/`GET /api/memories` gain `before` / `after` / `between` ISO params. Filters on the existing `timestamp` column in queries.ts.
*Unlocks:* "what happened this week", "incidents since Aug 10".

### T-2. Memory-as-of: git time travel — Effort M ⭐
JSONL is git-tracked and S3-mirrored. `recall --as-of <date|commit>` reads partition state **at that git ref** (git show per partition, merged via manifest).
*Why this is special:* no other agent-memory system (Mem0, Zep, Letta) can reconstruct *what memory looked like at a point in time* — they keep current state only. Git gives it to us for free. Post-incident forensics, "what did we know before the outage", rollback of a bad write.
*Notes:* read-only; needs a `git archive`-style resolver; S3 clone still works (full history in bundles).

### T-3. Recency-aware ordering — Effort S
- Exact-key/glob lists: **newest-first by default** (today: oldest-first — live-probed 08-02 before 08-18).
- Semantic fusion: recency tiebreak / decay factor so a 3-day-old memory outranks a 90-day-old one at equal similarity.

### T-4. Fact versioning convention — Effort S–M
Optional write-side attributes `valid_from` / `valid_until`; recall surfaces `current` vs `historical` views. Lightweight prelude to temporal knowledge — no graph needed. Pairs with T-2 for "what changed and when".

### T-5. Temporal facets on chat archive — Effort S
Chat-archive keys are already dated (`/chats/karahermes-set/2026-08-08`). Add `date=` / `since=` filters + "last N days" aggregation to the recall path.

### T-6. Time-series query surface — Effort M
Expose read-only SQL (`duckbrain query`) with template helpers: status changes per day, telemetry cost series, incident counts by day. DuckDB already reads the JSONL — the surface just isn't wired to CLI/HTTP yet.

---

## 2. Query-Based Features

### Q-1. Keyword search (FTS) — Effort M ⭐ (highest-value gap)
FTS index over `embedding_text` + `key` + `attributes` (SQLite FTS5 sidecar or DuckDB FTS). New `recall --contains` / `duckbrain search "GAP-020"`. Nails exact tokens — ticket IDs, UUIDs, cron ids, names, commands — the corpus's dominant regime.

### Q-2. Hybrid fusion — Effort M
BM25 (from Q-1) + semantic vectors, fused via Reciprocal Rank Fusion (rrf_k=60, per-retriever top-k=20), recency as tiebreak. Optional cross-encoder rerank (LM Studio bge-reranker) as a later stage. This is the 2026 standard recipe; works offline (no provider dependency for keyword half).

### Q-3. Attribute filters — Effort S
`recall attr.domain=config` / `attr.tick=403`. Attributes already stored as JSON; add filter params to queries.ts + recall/HTTP. Enables "all status writes", "all GAP-020 mentions".

### Q-4. Cross-namespace search — Effort S–M
`--all-namespaces` flag / namespace facet in results. The fleet-memory question: "where did we ever talk about S3?" across duckbrain + chat-archive + telemetry + project namespaces. Index is per-namespace; a union query over manifests is enough.

### Q-5. Chat-archive full-text — Effort M (rides Q-1)
FTS over the 70+ days of archived chat with snippet/highlight. Turns the conversation log into a searchable corpus — currently only key-addressed per day.

### Q-6. SQL query surface + saved queries — Effort M
`duckbrain query "SELECT ..."` (read-only, namespace-scoped, LIMIT-capped — reuses GAP-023/024 guards). Saved query templates: incidents-by-day, per-project status, cost series, gap reports.

### Q-7. Index-as-cache doctrine — Effort S (rides Q-1)
Search index is a **gitignored, rebuildable cache** — `duckbrain search-index rebuild` + git hooks (mirror of `embeddings rebuild`). Consistent with the file-first architecture: git is truth, indexes are derived, S3 clone → hooks → fully rebuilt.

---

## 3. Recommended sequencing

| Phase | Items | Why |
|---|---|---|
| 1 (now) | Q-1 + Q-2 + T-3 | Kills the "can't find exact tokens" class; recency fix is tiny; no provider needed for keyword half |
| 2 | T-1 + T-2 + Q-4 | Time travel is our unfair advantage; time-scope is trivial; cross-namespace rounds out query |
| 3 | Q-5 + Q-6 | Chat corpus search + SQL surface = power-user depth |
| 4 (later) | T-4 + T-6 + rerank | Fact versioning + time-series + rerank — the "memory quality" layer |

## 4. Where features land

- **MCP:** `recall` gains `before/after/between/as_of/contains/attr` params (schema in `src/mcp/tools/recall.ts`)
- **HTTP:** `GET /api/memories` gains the same query params (routes in `src/http/routes/memories.ts`)
- **CLI:** new `duckbrain search` + `duckbrain query` commands (allowlist in `bin/duckbrain.ts` + `src/cli/human.ts` — both must be updated together)
- **Indexes:** `src/embedding/` pattern extended with `src/search/` (index + rebuild + hooks)
- **Fusion:** shared `rankFused()` in the search layer; recency decay constants alongside `DEFAULT_MIN_SCORE`
