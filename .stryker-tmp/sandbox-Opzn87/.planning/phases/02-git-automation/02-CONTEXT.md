# Phase 02: Git Automation - Context

**Gathered:** 2026-03-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Background git commits (batched by size/time), squash/compaction process for reducing repo bloat, merge conflict resolution for collaborative sharing, and complete multi-namespace management across CLI, MCP, and API.

</domain>

<decisions>
## Implementation Decisions

### Git Batching Strategy (GIT-01)
- **D-01:** Simple hybrid triggers — commit when N lines queued OR T seconds elapsed (whichever comes first)
- **D-02:** Default thresholds: 200 lines or 60 seconds — conservative batching, configurable via `duckbrain config set`
- **D-03:** Single-threaded writer queue — prevents `index.lock` collisions, serializes git operations
- **D-04:** Graceful shutdown flushes pending commits — no data loss on process exit
- **D-05:** Worker lifecycle: `start()`, `stop()`, `enqueue(operation)` — singleton pattern exported from `src/git/worker.ts`

### Squash/Compaction Process (GIT-02)
- **D-06:** Multiple trigger modes (configurable) — manual (`duckbrain squash`), size-based (partition > X MB), commit-count-based (> N commits), tombstone-threshold-based (> X% tombstones), time-based (nightly schedule)
- **D-07:** Convert JSONL to Parquet for old partitions — reduces file size, faster DuckDB queries
- **D-08:** Remove tombstoned records during compaction — cleans up deleted memories
- **D-09:** Squash git history for compacted partitions — rewrites old history into single commit
- **D-10:** Aggressiveness is user-configurable — from conservative (manual only) to aggressive (continuous background compaction)

### Merge Conflict Resolution (GIT-03)
- **D-11:** Auto-merge by default (append-only) — both versions appended, UUIDs prevent duplicates, tombstones handle deletions
- **D-12:** Always log merge activity — `conflicts.log` tracks what was merged for audit trail
- **D-13:** Provide `duckbrain merge-resolve` script — analyzes conflicts, suggests resolution, user approves before applying
- **D-14:** Never fail a merge — append-only architecture means conflicts are always resolvable

### Multi-Namespace Management (NAMESPACE-01..03)
- **D-15:** Full CLI commands — `namespace create <name>`, `namespace list`, `namespace delete <name>`, `namespace use <name>`
- **D-16:** MCP tools for agents — `create_namespace`, `list_namespaces`, `delete_namespace`, `switch_namespace`
- **D-17:** API endpoints — `POST /namespaces`, `GET /namespaces`, `DELETE /namespaces/:name`, `PUT /namespaces/:default`
- **D-18:** Config file sync — all interfaces update `duckbrain.config.json` with `namespaceMappings`
- **D-19:** Namespace auto-creation on first write — zero-config option, namespace created when first memory written
- **D-20:** Each namespace is separate git repo — queried independently, enables sharing via GitHub

### Configuration System
- **D-21:** All thresholds configurable via `duckbrain config set` — git batching, compaction triggers, merge behavior
- **D-22:** Sensible defaults provided — users can start immediately, tune as needed

### the agent's Discretion
- Exact Parquet compression algorithm choice
- Specific default values for compaction triggers (will be documented as config options)
- Merge log file format details
- Namespace directory structure conventions

</decisions>

<canonical_refs>
## Canonical References

### Git Automation
- `.planning/ROADMAP.md` — Phase 2 requirements (GIT-01, GIT-02, GIT-03), success criteria
- `.planning/REQUIREMENTS.md` — Detailed requirement definitions for git batching, squash, merge handling
- `.planning/PROJECT.md` — Core value proposition, append-only architecture, git-backed design

### Codebase Patterns
- `.planning/codebase/ARCHITECTURE.md` — Git workflow patterns, single-threaded writer constraint
- `.planning/codebase/CONVENTIONS.md` — Code patterns, module structure for Phase 02

### Prior Phase Context
- `.planning/phases/01-core-mvp/01-CONTEXT.md` — Namespace config schema, path resolution already built
- `.planning/phases/01-core-mvp/01-UAT.md` — Verified namespace param working in all MCP tools

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/config/index.ts` — `DuckBrainConfigSchema` with `namespaceMappings`, `updateConfig()`, `registerNamespace()` functions
- `src/mcp/tools/*.ts` — All tools already accept `namespace` parameter with path resolution
- `src/cli/human.ts` — Partial `namespaces list|add` command implementation
- `src/storage/jsonl.ts` — Append-only JSONL writes (WAL-style pattern already in place)

### Established Patterns
- MCP tool registration pattern — new namespace tools should follow existing tool structure
- CLI command routing — `namespacesCommand()` pattern can be extended
- Config file atomic writes — tmp + rename pattern for durability

### Integration Points
- Git worker will integrate with `src/mcp/tools/remember.ts` — replace direct git calls with `worker.enqueue()`
- Squash process will read from manifest file — compact partitions tracked there
- Namespace commands will update `duckbrain.config.json` — shared config across all interfaces

</code_context>

<specifics>
## Specific Ideas

- "Don't box people into fixed concepts — give them the choice to control it" — all compaction triggers should be configurable
- "This is a portable personal and shared AI database" — design for both single-user and multi-user scenarios
- "We don't do partial features here" — multi-namespace must work across CLI, MCP, API, and eventually Web UI
- "The goal is to append only by default" — merge conflicts should auto-resolve by appending both versions

</specifics>

<deferred>
## Deferred Ideas

### Reviewed Todos (not folded)
- None — all discussed features are in scope for Phase 02

### Future Phases (from ROADMAP.md)
- SSH tunneling formalization — Phase 3 (Multi-User & Remote)
- Git worktrees for HTTP mode — Phase 3
- Web UI for namespace management — Phase 4
- Advanced compaction scheduling (cron-like) — can be added later if basic triggers insufficient

</deferred>

---

*Phase: 02-git-automation*
*Context gathered: 2026-03-30*
