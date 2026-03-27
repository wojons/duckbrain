# Requirements: DuckBrain

**Defined:** 2026-03-27
**Core Value:** Agents can remember and learn across sessions with full history, zero-cost branching, and collaborative sharing — all without database operations.

## v1 Requirements

### Core Tools

- [ ] **CORE-01**: `remember()` — Appends memory to JSONL, batches git commits by lines/time
- [ ] **CORE-02**: `recall()` — DuckDB queries with semantic search (vss), path globs, exact key lookup
- [ ] **CORE-03**: `list_keys()` — Hierarchical key explorer with pagination and depth limits
- [ ] **CORE-04**: `forget()` — Appends tombstone records (never deletes)

### Schema

- [x] **SCHEMA-01**: Hybrid schema — Strict base (id, key, domain, timestamp, author, action, embedding_text) + flexible attributes JSON
- [x] **SCHEMA-02**: Hierarchical key field — Filesystem-style paths (`/projects/mcp/schema`) for glob queries and partitioning
- [ ] **SCHEMA-03**: Zod validation — Enforce schemas on all MCP tool inputs

### Storage

- [x] **STORAGE-01**: Partitioned storage — Domains map to folders (`memory/person/`, `memory/event/`, etc.)
- [x] **STORAGE-02**: Manifest file — Lightweight index tracking active partition paths
- [ ] **STORAGE-03**: DuckDB initialization — Load vss extension, configure for JSONL/Parquet queries

### Git

- [ ] **GIT-01**: Async commit batching — Background worker commits when N lines or T seconds elapsed
- [ ] **GIT-02**: Squash process — Compacts JSONL to Parquet, cleans tombstones, squash-commits old history
- [ ] **GIT-03**: Merge conflict resolution — UUID-based rows, append-only merges, script-assisted handling

### CLI

- [ ] **CLI-01**: Stdio MCP — Local Claude integration
- [ ] **CLI-02**: CLI commands — Human operators, SSH support

## v2 Requirements

### Namespaces

- **NAMESPACE-01**: Multi-repo support — Each namespace is a separate git repo, queried independently
- **NAMESPACE-02**: Multi-user attribution — Stamps writes with git email, enables shared namespaces
- **NAMESPACE-03**: Pull/push shared origins — Collaborative memory sharing

### Remote Access

- **REMOTE-01**: HTTP MCP — Remote hosting for multiple agents
- **REMOTE-02**: SSH tunneling — Transparent remote access without opening ports
- **REMOTE-03**: Git worktrees — Multi-agent isolation on shared servers

### Web UI

- **UI-01**: Web interface — File-explorer-style UI showing memory tree and timeline
- **UI-02**: DuckDB-WASM mode — Browser-only querying, zero hosting costs
- **UI-03**: Embedded Express — Optional bundled web server with MCP

## Out of Scope

| Feature | Reason |
|---------|--------|
| Traditional database backend | DuckDB is stateless, file-backed — no server needed |
| Real-time sync across replicas | Eventual consistency via Git push/pull is sufficient |
| Heavy authentication/authorization | Git email attribution only (not security) — this is a trust tool |
| Mobile apps | MCP + CLI first, web UI second — focus on agent users |
| Complex permission systems | Out of scope for v1/v2 — sharing is via Git, not ACLs |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| CORE-01 | Phase 1 | Pending |
| CORE-02 | Phase 1 | Pending |
| CORE-03 | Phase 1 | Pending |
| CORE-04 | Phase 1 | Pending |
| SCHEMA-01 | Phase 1 | **Complete** |
| SCHEMA-02 | Phase 1 | **Complete** |
| SCHEMA-03 | Phase 1 | Pending |
| STORAGE-01 | Phase 1 | **Complete** |
| STORAGE-02 | Phase 1 | **Complete** |
| STORAGE-03 | Phase 1 | Pending |
| GIT-01 | Phase 2 | Pending |
| GIT-02 | Phase 2 | Pending |
| GIT-03 | Phase 2 | Pending |
| CLI-01 | Phase 1 | Pending |
| CLI-02 | Phase 1 | Pending |
| NAMESPACE-01 | Phase 3 | Pending |
| NAMESPACE-02 | Phase 3 | Pending |
| NAMESPACE-03 | Phase 3 | Pending |
| REMOTE-01 | Phase 3 | Pending |
| REMOTE-02 | Phase 3 | Pending |
| REMOTE-03 | Phase 3 | Pending |
| UI-01 | Phase 4 | Pending |
| UI-02 | Phase 4 | Pending |
| UI-03 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 15 total
- v2 requirements: 9 total
- Mapped to phases: 24
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-27*
*Last updated: 2026-03-27 after Plan 01 completion*
