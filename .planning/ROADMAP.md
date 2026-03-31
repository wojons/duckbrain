# DuckBrain Roadmap

## Phase 1: Core MVP ✓ COMPLETE

**Goal:** Working MCP server with basic remember/recall, JSONL storage, DuckDB queries

| Plan | Description | Status | Commits |
|------|-------------|--------|---------|
| 01 | Memory Schema & Storage | ✅ Complete | 5 commits |
| 02 | 3/2 | Complete    | 2026-03-31 |
| 03 | MCP Server & Tools | ✅ Complete | 1 commit |
| 04 | CLI Entry Points | ✅ Complete | 6 commits |

**Success Criteria:**
- [x] JSONL partitioned storage with manifest
- [x] DuckDB connection and query layer
- [x] MCP tools: remember, recall, list_keys, forget
- [x] CLI: stdio, http, human operator commands

**Summary Files:**
- `.planning/phases/01-core-mvp/01-core-mvp-01-SUMMARY.md`
- `.planning/phases/01-core-mvp/01-core-mvp-02-SUMMARY.md`
- `.planning/phases/01-core-mvp/01-core-mvp-03-SUMMARY.md`
- `.planning/phases/01-core-mvp/01-core-mvp-04-SUMMARY.md`

---

## Phase 2: Git Automation — In Progress

**Goal:** Async commit batching, squash process, merge conflict resolution

| Plan | Description | Status | Commits |
|------|-------------|--------|---------|
| 01 | Git Batching Worker | 🟡 Partial | 2 commits |
| 02 | Squash Process | ✅ Complete | 2026-03-31 |
| 03 | Merge Conflict Resolution | ✅ Complete | 2026-03-31 |
| 04 | Gap Closure: Namespace MCP Tools | ✅ Complete | 2026-03-31 |
| 05 | Gap Closure: Config CLI Alignment | ⏳ Pending | - |
| 06 | Gap Closure: CLI Wiring Fixes | ⏳ Pending | - |

**Success Criteria:**
- [🟡] Background worker commits when N lines or T seconds elapsed (GIT-01) — Core implemented, integration deferred
- [✓] Squash process compacts JSONL to Parquet (GIT-02)
- [✓] Script-assisted merge conflict resolution (GIT-03)
- [✓] Namespace MCP tools registered and callable (NAMESPACE-01, NAMESPACE-02)
- [ ] Config CLI keys aligned with schema
- [ ] All CLI commands accessible (squash --help, namespace alias, pull/push)

**Summary Files:**
- `.planning/phases/02-git-automation/02-git-auto-01-SUMMARY.md`
- `.planning/phases/02-git-automation/02-git-auto-02-SUMMARY.md`
- `.planning/phases/02-git-automation/02-git-auto-03-SUMMARY.md`
- `.planning/phases/02-git-automation/02-git-auto-04-SUMMARY.md`

---

## Phase 3: Multi-User & Remote — Planned

**Goal:** Namespace support, SSH tunneling, remote access

**Plans:** 3 plans

| Plan | Description | Status | Wave |
|------|-------------|--------|------|
| 01 | SSH Tunneling | 📝 Planned | 1 |
| 02 | Docker Containerization | 📝 Planned | 1 |
| 03 | HTTP Auth & Service Management | 📝 Planned | 1 |

**Success Criteria:**
- [ ] SSH tunneling for secure remote access (REMOTE-02, REMOTE-03)
- [ ] Docker deployment with Alpine and Debian variants
- [ ] HTTP server with auth, rate limiting, systemd service

**Plan Files:**
- `.planning/phases/03-multi-user-remote/03-01-PLAN.md` — SSH tunneling with named Unix sockets
- `.planning/phases/03-multi-user-remote/03-02-PLAN.md` — Docker images and compose configurations
- `.planning/phases/03-multi-user-remote/03-03-PLAN.md` — HTTP auth, rate limiting, systemd service

---

## Phase 4: Web UI — Pending

**Goal:** Browser-based interface for memory exploration

| Plan | Description | Status | Commits |
|------|-------------|--------|---------|
| 01 | UI Foundation | ⏳ Pending | - |
| 02 | Memory Explorer | ⏳ Pending | - |
| 03 | Timeline View | ⏳ Pending | - |

**Success Criteria:**
- [ ] File-explorer-style memory tree navigation
- [ ] Timeline view of memories
- [ ] Search and filtering capabilities

---

## Version History

### v1.0 — Core MVP (In Progress)

**Target:** Working MCP server with basic remember/recall

- Phase 1: ✓ Complete
- Phase 2: In Progress (1/3 plans partial)
- Phase 3: Pending
- Phase 4: Pending

**Requirements Validated:**
- CORE-01: remember() tool — Partially implemented
- CORE-02: recall() tool — ✓ Implemented
- CORE-03: list_keys() tool — ✓ Implemented
- CORE-04: forget() tool — Stub implemented
- STORAGE-01: Partitioned storage — ✓ Implemented
- STORAGE-02: Manifest file — ✓ Implemented
- GIT-01: Async commit batching — Core implemented, integration deferred

---

*Milestones tracked in STATE.md*
*Last updated: 2026-03-31*
