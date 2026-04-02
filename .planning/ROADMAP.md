# DuckBrain Roadmap

## Phase 1: Core MVP ✓ COMPLETE

**Goal:** Working MCP server with basic remember/recall, JSONL storage, DuckDB queries

| Plan | Description | Status | Commits |
|------|-------------|--------|---------|
| 01 | Memory Schema & Storage | ✅ Complete | 5 commits |
| 02 | 7/6 | Complete    | 2026-04-02 |
| 03 | 4/4 | Complete    | 2026-03-31 |
| 04 | 2/3 | In Progress|  |

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

## Phase 3: Multi-User & Remote — In Progress

**Goal:** Namespace support, SSH tunneling, remote access

**Plans:** 4 plans

| Plan | Description | Status | Wave |
|------|-------------|--------|------|
| 01 | SSH Tunneling | ✓ Complete | 1 |
| 02 | Docker Containerization | ✓ Complete | 1 |
| 03 | HTTP Auth & Service Management | ✓ Complete | 1 |
| 04 | Gap Closure: Wire CLI Flags to HTTP Server | 📝 Planned | 2 |

**Success Criteria:**
- [x] SSH tunneling for secure remote access (REMOTE-02, REMOTE-03)
- [x] Docker deployment with Alpine and Debian variants
- [ ] HTTP server with auth, rate limiting, systemd service (CLI flags not wired — gap closure pending)

**Plan Files:**
- `.planning/phases/03-multi-user-remote/03-01-PLAN.md` — SSH tunneling with named Unix sockets
- `.planning/phases/03-multi-user-remote/03-02-PLAN.md` — Docker images and compose configurations
- `.planning/phases/03-multi-user-remote/03-03-PLAN.md` — HTTP auth, rate limiting, systemd service
- `.planning/phases/03-multi-user-remote/03-04-PLAN.md` — Gap closure: wire --auth/--rate-limit/--bind-all CLI flags

---

## Phase 4: Web UI — COMPLETE

**Goal:** Browser-based interface for memory exploration

**Plans:** 3 plans in 3 waves — ALL COMPLETE

| Wave | Plans | Description | Status |
|------|-------|-------------|--------|
| 1 | 01 | UI Foundation — Vite, React, Tailwind with glassmorphism theme | ✅ Complete 2026-04-02 |
| 2 | 02 | API Backend — Express routes wrapping MCP tools | ✅ Complete 2026-04-02 |
| 3 | 03 | Memory Explorer UI — Tree, Timeline, Inspector, SSE | ✅ Complete 2026-04-02 |

**Requirements:** [UI-01, UI-02, UI-03, UI-04, UI-05]

**Success Criteria:**
- [✓] File-explorer-style memory tree navigation with expand/collapse
- [✓] Timeline view of memories with virtual scrolling
- [✓] Search and filtering capabilities
- [✓] Memory inspection with JSON viewer
- [✓] Namespace management via UI
- [✓] Real-time updates via SSE

**Summary Files:**
- `.planning/phases/04-web-ui/04-01-SUMMARY.md` — UI Foundation Complete
- `.planning/phases/04-web-ui/04-02-SUMMARY.md` — API Backend Complete
- `.planning/phases/04-web-ui/04-03-SUMMARY.md` — Memory Explorer UI Complete

**Plan Files:**
- `.planning/phases/04-web-ui/04-01-PLAN.md` — UI Foundation
- `.planning/phases/04-web-ui/04-02-PLAN.md` — API Backend
- `.planning/phases/04-web-ui/04-03-PLAN.md` — Memory Explorer UI

---

## Version History

### v1.0 — Core MVP (In Progress)

**Target:** Working MCP server with basic remember/recall

- Phase 1: ✓ Complete
- Phase 2: In Progress (1/3 plans partial)
- Phase 3: In Progress (2/3 plans complete)
- Phase 4: In Progress (1/3 plans complete)

**Requirements Validated:**
- CORE-01: remember() tool — Partially implemented
- CORE-02: recall() tool — ✓ Implemented
- CORE-03: list_keys() tool — ✓ Implemented
- CORE-04: forget() tool — Stub implemented
- STORAGE-01: Partitioned storage — ✓ Implemented
- STORAGE-02: Manifest file — ✓ Implemented
- GIT-01: Async commit batching — Core implemented, integration deferred
- UI-01: Web interface foundation — ✓ Implemented 2026-04-02

---

*Milestones tracked in STATE.md*
*Last updated: 2026-04-02*
