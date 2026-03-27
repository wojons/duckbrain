# DuckBrain Roadmap

**Created:** 2026-03-27
**Core Value:** Agents can remember and learn across sessions with full history, zero-cost branching, and collaborative sharing — all without database operations.

## Phase Overview

**4 phases** | **24 requirements mapped** | All v1/v2 requirements covered ✓

| # | Phase | Goal | Requirements | Success Criteria |
|---|-------|------|--------------|------------------|
| 1 | Core MVP | Working MCP server with basic remember/recall, JSONL storage, DuckDB queries | CORE-01..04, SCHEMA-01..03, STORAGE-01..03, CLI-01..02 | Agent can remember and recall memories, queries work via DuckDB |
| 2 | Git Automation | Async commits, squash process, merge handling | GIT-01..03 | Background commits work, squash compacts history, merges are clean |
| 3 | Multi-User & Remote | Namespaces, SSH tunneling, HTTP hosting | NAMESPACE-01..03, REMOTE-01..03 | Multiple repos supported, SSH tunneling works, HTTP mode with worktrees |
| 4 | Web UI | File-explorer interface for browsing memories | UI-01..03 | Web UI shows memory tree, DuckDB-WASM or embedded server works |

---

## Phase Details

### Phase 1: Core MVP

**Goal:** Working MCP server with basic `remember()`/`recall()` tools, JSONL storage, and DuckDB queries.

**Requirements:**
- CORE-01: `remember()` — Appends memory to JSONL, batches git commits by lines/time
- CORE-02: `recall()` — DuckDB queries with semantic search (vss), path globs, exact key lookup
- CORE-03: `list_keys()` — Hierarchical key explorer with pagination and depth limits
- CORE-04: `forget()` — Appends tombstone records (never deletes)
- SCHEMA-01: Hybrid schema — Strict base + flexible attributes JSON
- SCHEMA-02: Hierarchical key field — Filesystem-style paths
- SCHEMA-03: Zod validation — Enforce schemas on all MCP tool inputs
- STORAGE-01: Partitioned storage — Domains map to folders
- STORAGE-02: Manifest file — Lightweight index tracking active partition paths
- STORAGE-03: DuckDB initialization — Load vss extension, configure for JSONL/Parquet queries
- CLI-01: Stdio MCP — Local Claude integration
- CLI-02: CLI commands — Human operators, SSH support

**Success Criteria:**
1. Agent can call `remember()` and memory is appended to correct JSONL partition
2. Agent can call `recall()` and get results via DuckDB (exact key, glob, semantic)
3. Agent can call `list_keys()` and explore existing memory structure
4. Agent can call `forget()` and memory is tombstoned
5. All tool inputs validated by Zod schemas
6. DuckDB queries work across JSONL files with vss extension loaded
7. MCP stdio mode works with local Claude

**Plans:** 4 plans

**Plan list:**
- [x] 01-core-mvp-01-PLAN.md — Schema + storage foundation (SCHEMA-01..03, STORAGE-01..02)
- [ ] 01-core-mvp-02-PLAN.md — DuckDB + remember/forget tools (CORE-01, CORE-04, STORAGE-03)
- [ ] 01-core-mvp-03-PLAN.md — Recall/list_keys + MCP server (CORE-02, CORE-03, SCHEMA-03)
- [ ] 01-core-mvp-04-PLAN.md — CLI entry points (CLI-01, CLI-02)

**Canonical refs:**
- `specs/` — Project specifications (if created)

---

### Phase 2: Git Automation

**Goal:** Background git commits, squash process for compaction, merge conflict resolution.

**Requirements:**
- GIT-01: Async commit batching — Background worker commits when N lines or T seconds elapsed
- GIT-02: Squash process — Compacts JSONL to Parquet, cleans tombstones, squash-commits old history
- GIT-03: Merge conflict resolution — UUID-based rows, append-only merges, script-assisted handling

**Success Criteria:**
1. Background worker commits automatically based on line count threshold
2. Background worker commits automatically based on time threshold
3. Squash script compacts old JSONL to Parquet format
4. Squash script removes tombstoned records
5. Merge conflicts are resolved by appending both versions (UUIDs prevent collisions)
6. Repository stays lean after compaction

**Canonical refs:**
- `.planning/codebase/ARCHITECTURE.md` — Git workflow patterns (after Phase 1)
- `.planning/codebase/CONVENTIONS.md` — Code patterns (after Phase 1)

---

### Phase 3: Multi-User & Remote

**Goal:** Namespaces (multi-repo), SSH tunneling, HTTP hosting with git worktrees.

**Requirements:**
- NAMESPACE-01: Multi-repo support — Each namespace is a separate git repo, queried independently
- NAMESPACE-02: Multi-user attribution — Stamps writes with git email, enables shared namespaces
- NAMESPACE-03: Pull/push shared origins — Collaborative memory sharing
- REMOTE-01: HTTP MCP — Remote hosting for multiple agents
- REMOTE-02: SSH tunneling — Transparent remote access without opening ports
- REMOTE-03: Git worktrees — Multi-agent isolation on shared servers

**Success Criteria:**
1. Multiple namespaces can be loaded and queried independently
2. Writes are stamped with author's git email
3. Agent can pull memories from a shared remote repo
4. HTTP MCP endpoint serves multiple agents simultaneously
5. SSH tunneling works transparently (`ssh user@host "duckbrain stdio"`)
6. Git worktrees isolate agent branches in HTTP mode

**Canonical refs:**
- `.planning/codebase/INTEGRATIONS.md` — SSH, HTTP patterns (after Phase 1)

---

### Phase 4: Web UI

**Goal:** File-explorer-style web interface for browsing and querying memories.

**Requirements:**
- UI-01: Web interface — File-explorer-style UI showing memory tree and timeline
- UI-02: DuckDB-WASM mode — Browser-only querying, zero hosting costs
- UI-03: Embedded Express — Optional bundled web server with MCP

**Success Criteria:**
1. Web UI displays hierarchical memory tree (parsed from keys)
2. Clicking a folder shows timeline of memories in that partition
3. DuckDB-WASM can query local files in browser (no server needed)
4. Embedded Express server optionally serves UI alongside MCP
5. Search and filter work via DuckDB queries

**Canonical refs:**
- TBD — UI framework decision during Phase 3

---

## Dependencies

```
Phase 1 (Core MVP)
    ↓
Phase 2 (Git Automation) — requires Phase 1 storage + CLI
    ↓
Phase 3 (Multi-User & Remote) — requires Phase 2 git patterns
    ↓
Phase 4 (Web UI) — can run in parallel with Phase 3, depends on Phase 1 queries
```

---
*Roadmap created: 2026-03-27*
*Last updated: 2026-03-27 after initialization*
