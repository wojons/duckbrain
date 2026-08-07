# Dogfood Log

Real-use field tests of DuckBrain. Each entry: date, verdict, promise, top findings, time-to-first-success.

## 2026-08-07 — Verdict: 🟡 PROMISING-BUT-ROUGH

- **Promise:** "AI agents get persistent, queryable, version-controlled memory — MCP server, HTTP API, CLI, Web UI; append-only JSONL + DuckDB (incl. vector search) + Git."
- **What was exercised:** live daemon (127.0.0.1:3000, running since 03:12) via REST + MCP-over-HTTP (full handshake); CLI on the live repo; full lifecycle (create namespace, remember ×4, recall, key lookup, update→tombstone+add, forget, delete namespace, semantic recall ×3) on a throwaway namespace; isolated scratch instance (`DUCKBRAIN_NAMESPACES_PATH=/tmp/dogfood-duckbrain`) for restart-persistence + git-versioning checks.
- **Top findings:**
  1. REST `GET /api/memories?q=` is parsed then dropped — search endpoint returns the full list for any q (DOGFOOD-001, P0).
  2. Semantic recall fails silently (200, `memories: []`, error string in payload) when the LM Studio model is unloaded; `auto` provider never falls back to a working ollama (DOGFOOD-002, P1).
  3. CLI `remember` cannot store content (no content flag; key becomes the memory text) and `delete_namespace` "succeeds" while leaving all data on disk (DOGFOOD-003/-004, P1).
- **What held up:** REST lifecycle, MCP tools, semantic ranking when embeddings are warm, persistence across restart, batched git auto-commit for API-created namespaces, health/status.
- **Time-to-first-success:** ~3 min (health + namespace list + first memory write; one doc-vs-server detour on the domain enum).
- **Friction count:** 11 distinct frictions → 9 board tasks (DOGFOOD-001..009).
- **Foreman:** not woken (cooldown 7200s < 14400s; Enabled=true). Board had 0 open tasks before this run — now 9.
