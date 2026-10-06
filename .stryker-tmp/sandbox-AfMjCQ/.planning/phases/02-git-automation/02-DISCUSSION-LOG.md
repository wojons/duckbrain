# Phase 02: Git Automation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-30
**Phase:** 02-git-automation
**Areas discussed:** Git batching strategy, Squash/compaction process, Merge conflict resolution, Multi-namespace management

---

## Git Batching Strategy (GIT-01)

### Commit Trigger Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Adaptive batching | Dynamic adjustment based on load, multiple triggers | |
| Write-ahead log pattern | Immediate log, batched commits, periodic checkpoint | |
| Delayed durability | Write sync, ack immediately, batch flush | |
| Priority-based queuing | Critical writes immediate, normal batched | |
| **Simple hybrid** | **Size OR timeout triggers** | ✓ |

**User's choice:** Keep it simple — size + timeout triggers only

**Notes:** User noted that WAL-style is already achieved through append-only JSONL writes. Didn't want to over-engineer with adaptive batching or priority systems.

### Default Thresholds

| Option | Description | Selected |
|--------|-------------|----------|
| 100 lines or 30 seconds | Balanced defaults | |
| 50 lines or 15 seconds | Aggressive, more overhead | |
| **200 lines or 60 seconds** | **Conservative, configurable** | ✓ |
| Configurable only | No defaults, force user choice | |

**User's choice:** 200 lines or 60 seconds as defaults, but definitely configurable

**Notes:** Emphasized that these are just sensible defaults — users should be able to tune via config.

---

## Squash/Compaction Process (GIT-02)

### Compaction Strategy

**User's guidance:** Multiple trigger modes should be supported:
- Manual trigger (`duckbrain squash` command)
- Size-based (when partition exceeds X MB)
- Commit-count-based (when > N commits accumulated)
- Tombstone-threshold-based (when > X% are tombstones)
- Time-based (nightly schedule)

**Decision:** All trigger modes should be available and configurable. User explicitly said "dont box people into fixed concepts give them the choice to control it."

**Notes:** User trusts the Parquet conversion decision but wants maximum flexibility in when/how compaction happens. This is a "portable personal and shared AI database" — needs to work for different usage patterns.

---

## Merge Conflict Resolution (GIT-03)

### Merge Strategy

**User's guidance:** All of the following should be supported:
- Auto-merge by default (append both versions)
- Always maintain a log of merge activity
- Provide script-assisted resolution tool
- Goal is append-only by default, never fail a merge

**Decision:** Auto-merge is the default behavior (D-11), always log merges (D-12), provide `duckbrain merge-resolve` script (D-13), and never fail a merge (D-14).

**Notes:** User emphasized that append-only architecture means conflicts are always resolvable — just append both versions. Logging is important for audit trail.

---

## Multi-Namespace Management

### Scope Decision

| Option | Description | Selected |
|--------|-------------|----------|
| **Full multi-interface support** | **CLI + MCP + API** | ✓ |
| CLI only | Defer MCP/API to Phase 03 | |
| MCP tools priority | Focus on agents first | |
| Defer to Phase 03 | Keep Phase 02 git-focused | |

**User's choice:** Complete multi-namespace support across all interfaces

**Notes:** User said "we don't do partial features here" — namespace management must work in CLI, MCP tools, API endpoints, and eventually Web UI. Phase 01 has partial support (config schema, path resolution, namespace param in tools), Phase 02 completes it.

### What Was Built in Phase 01

Research showed:
- ✅ Config schema with `namespaceMappings` field
- ✅ `registerNamespace()` helper function
- ✅ All MCP tools accept `namespace` parameter
- ✅ Path resolution in all tools
- ⚠️ Basic CLI `namespaces list|add` command (incomplete)
- ❌ No `create`, `delete`, `switch` commands
- ❌ No MCP tools for namespace management
- ❌ No API endpoints

**Decision:** Phase 02 adds full CLI commands, MCP tools, and API endpoints for complete namespace lifecycle management.

---

## the agent's Discretion

Areas where user deferred to implementation judgment:
- Exact Parquet compression algorithm choice
- Specific default values for compaction triggers (to be documented as config options)
- Merge log file format details
- Namespace directory structure conventions

---

## External Research Applied

Research on database commit strategies informed the decision to keep triggers simple:
- WAL (Write-Ahead Logging) pattern already achieved via append-only JSONL
- Adaptive batching is overkill for current use case
- SQL Server delayed durability pattern interesting but not needed yet
- Simple size + timeout covers 95% of use cases

---

## Summary

**Total areas discussed:** 4
**Decisions captured:** 22 (D-01 through D-22)
**Deferred ideas:** SSH tunneling, git worktrees, Web UI (future phases)
**Key principle:** Flexibility and configurability — users should be able to tune all thresholds and choose their own balance of performance vs. durability vs. repo size.

---

*Discussion completed: 2026-03-30*
*Mode: discuss*
