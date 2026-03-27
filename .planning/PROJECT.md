# DuckBrain

A distributed, event-sourced, version-controlled memory system for AI agents. Built on DuckDB + Git.

## What This Is

DuckBrain is a TypeScript MCP server + CLI that provides AI agents with persistent, queryable, version-controlled memory. Memories are stored as append-only JSONL files, queried via DuckDB (including vector search), and fully versioned by Git — giving agents time-travel, branching experiments, and collaborative sharing without running a traditional database.

## Core Value

**Agents can remember and learn across sessions with full history, zero-cost branching, and collaborative sharing — all without database operations.**

If everything else fails, this must work: `remember()` appends to disk, `recall()` queries via DuckDB, Git tracks everything.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] **CORE-01**: `remember()` tool — appends memory to JSONL, batches git commits by lines/time
- [ ] **CORE-02**: `recall()` tool — DuckDB queries with semantic search (vss extension), path globs, exact key lookup
- [ ] **CORE-03**: `list_keys()` tool — hierarchical key explorer with pagination and depth limits
- [ ] **CORE-04**: `forget()` tool — appends tombstone records (never deletes)
- [ ] **SCHEMA-01**: Hybrid schema — strict base fields (id, key, domain, timestamp, author, action, embedding_text) + flexible attributes JSON
- [ ] **SCHEMA-02**: Hierarchical key field — filesystem-style paths (`/projects/mcp/schema`) for glob queries and partitioning
- [ ] **STORAGE-01**: Partitioned storage — domains map to folders (`memory/person/`, `memory/event/`, etc.)
- [ ] **STORAGE-02**: Manifest file — lightweight index tracking active partition paths
- [ ] **GIT-01**: Async commit batching — background worker commits when N lines or T seconds elapsed
- [ ] **GIT-02**: Squash process — compacts JSONL to Parquet, cleans tombstones, squash-commits old history
- [ ] **GIT-03**: Merge conflict resolution — UUID-based rows, append-only merges, script-assisted conflict handling
- [ ] **NAMESPACE-01**: Multi-repo support — each namespace is a separate git repo, queried independently
- [ ] **NAMESPACE-02**: Multi-user attribution — stamps writes with git email, enables shared namespaces
- [ ] **CLI-01**: Stdio MCP — local Claude integration
- [ ] **CLI-02**: HTTP MCP — remote hosting for multiple agents
- [ ] **CLI-03**: SSH tunneling — transparent remote access without opening ports
- [ ] **UI-01**: Web interface — file-explorer-style UI showing memory tree and timeline (DuckDB-WASM or embedded Express + React)

### Out of Scope

- Traditional database backend — DuckDB is stateless, file-backed
- Real-time sync across replicas — eventual consistency via Git push/pull
- Heavy authentication/authorization — git email attribution only (not security)
- Mobile apps — MCP + CLI first, web UI second

## Context

**Technical Environment:**
- TypeScript (Node.js runtime)
- DuckDB with vss extension for vector search
- Git worktrees for multi-agent HTTP mode
- JSONL for active writes, Parquet for compacted history

**Design Philosophy:**
- Append-only = clean merges, full history
- Hierarchical keys = intuitive organization, glob queries
- Hybrid schema = structure where valuable, freedom elsewhere
- Git as the source of truth = versioning, branching, sharing built-in

**Key Insights:**
- Git concurrency limits → single-threaded write queue, batch commits
- Repository bloat → aggressive compaction, Parquet archival
- JSONL scan times → partitioned folders, manifest-indexed queries
- AI path hallucinations → `list_keys()` guardrail tool

## Constraints

- **[Latency]**: Git commits add 10-50ms per operation → batch by lines/time, async worker
- **[Concurrency]**: Git `index.lock` prevents parallel commits → single-threaded writer
- **[Repository Size]**: Continuous appends bloat `.git/` → squash old history, use Parquet + Git LFS
- **[Schema Consistency]**: AI may hallucinate attribute keys → Zod schemas, `list_keys()` exploration tool

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| **Hybrid Schema (Mullet)**: Strict base + flexible attributes | AI needs freedom but queries need structure | Enforced base fields (id, key, domain, etc.) + JSON attributes |
| **Hierarchical Key Field**: Filesystem-style paths | Enables glob queries, intuitive organization, partitioning | Keys like `/projects/mcp/schema` map to folder structure |
| **Append-Only + Tombstones**: No row updates, insert new rows with same UUID | Git merges are clean, full audit log, time-travel possible | Squash process cleans tombstones and compacts history |
| **Async Git Batching**: Write to disk immediately, commit in background | Prevents data loss on crash, avoids blocking agent | Background worker commits when N lines or T seconds |
| **Git Worktrees for HTTP Mode**: Separate worktree per agent/branch | Multi-agent HTTP server needs isolated branch checkouts | Each agent gets own worktree directory |
| **Manifest Index**: Lightweight file tracking active partitions | DuckDB globs need to know which files to query | `manifest.json` tracks active partition paths |
| **SSH Tunneling**: Remote access via SSH, no open ports | Simpler security model, no port forwarding needed | CLI runs `ssh user@host "mcp-memory-cli stdio"` |
| **Namespace = Git Repo**: Each namespace is separate repo | Enables sharing, collaboration, independent queries | Pull friends' repos, push to shared origins |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-03-27 after initialization*
