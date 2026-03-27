# Phase 01: Core MVP - Context

**Gathered:** 2026-03-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Working MCP server with basic `remember()`/`recall()`/`list_keys()`/`forget()` tools, JSONL partitioned storage, and DuckDB queries. Multi-namespace support (each namespace = separate git repo). CLI with stdio MCP for local Claude and HTTP MCP for remote hosting.

</domain>

<decisions>
## Implementation Decisions

### Storage Structure
- **D-01:** Three-level hierarchy: `namespace/domain/partition/` — enables clean separation for multi-repo and domain-based organization
- **D-02:** Support both time-based AND key-based partitioning — time-based by default (e.g., `2026-03/`, `2026-W14/`), key-based for categorical grouping (e.g., `projects/`, `contacts/`)
- **D-03:** Files chunked within partition folders — prevents massive files that are hard to parse, size-based splits when files exceed threshold
- **D-04:** Manifest file (`manifest.json`) tracks active partition paths — lightweight index for efficient DuckDB glob queries

### MCP Tool Interfaces
- **D-05:** Hybrid response format — success responses include `{success, id, key, partition}` for debugging, full record available on request
- **D-06:** Hierarchical key field uses filesystem-style paths (e.g., `/projects/mcp/schema`, `/contacts/alice`) — enables glob queries and intuitive organization
- **D-07:** `list_keys()` supports prefix filtering, depth limits, and pagination — guardrail tool prevents AI path hallucinations

### Schema Design (Mullet Schema)
- **D-08:** Strict base fields: `id` (UUID), `key` (hierarchical path), `domain` (enum), `timestamp` (ISO-8601), `author` (git email), `action` (add/update/tombstone), `embedding_text` (for vectorization)
- **D-09:** Flexible `attributes` JSON field — AI has freedom for domain-specific data, DuckDB queries JSON on the fly
- **D-10:** Domains partition storage: `person/`, `event/`, `concept/`, `message/`, `config/`, `raw_note/` — maps to folder structure
- **D-11:** Tombstone-based deletion — `forget()` appends tombstone record, never deletes (preserves git history, clean merges)

### DuckDB Setup
- **D-12:** Support multiple connection modes based on deployment: per-query (simple), connection pool (concurrent HTTP), singleton per namespace (lightweight)
- **D-13:** Use embedded DuckDB (duckdb-node) — no server, opens files directly, loads vss extension for vector search
- **D-14:** DuckDB queries target specific partitions via manifest — doesn't scan entire database, uses glob patterns on partition folders

### Git Batching Strategy
- **D-15:** Configurable thresholds for commits — user sets line count (N) and time interval (T seconds) based on their needs
- **D-16:** Write to disk synchronously, commit to git asynchronously — prevents data loss on crash, avoids blocking agent
- **D-17:** Single-threaded write queue — avoids `index.lock` collisions, serializes git operations
- **D-18:** Author attribution from git email — not security, just attribution for multi-user/shared namespaces

### Multi-Namespace Support
- **D-19:** Each namespace is a separate git repo — queried independently, enables sharing with friends via GitHub
- **D-20:** Multiple namespaces can be loaded simultaneously — agent can pull from shared repos, push to different origins
- **D-21:** Git worktrees for HTTP mode — isolates branches per agent when hosting remotely

### CLI & Remote Access
- **D-22:** SSH tunneling support — transparent remote access without opening ports (`ssh user@host "duckbrain stdio"` pipes local stdin/stdout)
- **D-23:** Dual interface: stdio MCP (local Claude) + HTTP MCP (remote hosting) + CLI (human operators)

### Configuration System
- **D-24:** Config file (`~/.duckbrain/config.json`) — namespaces, git thresholds, HTTP/SSH settings, default namespace
- **D-25:** MCP server accepts `--namespaces` flag — loads multiple namespaces, routes per-tool requests
- **D-26:** Opencode skill provided — teaches CLI usage, connection setup, troubleshooting

### HTTP API (Multi-User Ready)
- **D-27:** HTTP endpoints beyond MCP: `/health`, `/stats`, `/namespaces`, `/users`, `/activity` — admin & monitoring
- **D-28:** Web UI prep endpoints: `/api/tree` (memory tree), `/api/timeline` (chronological feed), `/api/search` (filtered search)
- **D-29:** Git worktrees per user/session — isolates branches in HTTP mode for multi-agent hosting

### list_keys() Enhanced
- **D-30:** Supports glob patterns (`/projects/*/schema`), regex filters (`^/projects/[^/]+/schema$`), pagination (page, limit, hasMore)

### the agent's Discretion
- Exact chunk size thresholds within partitions
- Specific default values for configurable thresholds (line count, time interval)
- DuckDB connection mode selection logic (when to use which mode)
- Manifest file format details (JSON structure)
- Partition chunking strategy (size-based vs count-based)

</decisions>

<canonical_refs>
## Canonical References

### Core Architecture
- `.planning/PROJECT.md` — Full project vision, requirements, key decisions (hybrid schema, hierarchical keys, append-only + tombstones)
- `.planning/REQUIREMENTS.md` — 12 Phase 1 requirements: CORE-01..04, SCHEMA-01..03, STORAGE-01..03, CLI-01..02
- `.planning/ROADMAP.md` — Phase 1 goal, success criteria, canonical refs

### Chatlog Reference
- `chatlog.md` — Full architecture discussion with Gemini (storage structure, schema design, multi-namespace, SSH tunneling, batching strategy)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- None yet — this is Phase 1, greenfield implementation

### Established Patterns
- GSD workflow system — use `/gsd-plan-phase`, `/gsd-execute-phase` for downstream work
- TypeScript MCP server pattern — follow conventions from PROJECT.md

### Integration Points
- Opencode AI platform — MCP server integrates as tool provider
- DuckDB with vss extension — core query engine
- Git worktrees — multi-agent isolation in HTTP mode

</code_context>

<specifics>
## Specific Ideas

- "Agents won't even understand that memory was solved for them" — system should feel invisible and automatic
- Inspired by chat with Gemini about embedded databases and git-backed architecture
- Named "DuckBrain" — memorable, indicates DuckDB + AI memory stack
- Should be buildable "in a few hours with an LLM" — quick memory system for many use cases

</specifics>

<deferred>
## Deferred Ideas

### Future Phases (from ROADMAP.md)
- Git automation (async commits, squash process, merge handling) — Phase 2
- Multi-user attribution enhancements — Phase 3
- SSH tunneling polish and formalization — Phase 3
- Web UI (file-explorer interface) — Phase 4

### Noted from Chatlog
- Advanced features mentioned but not in Phase 1 scope: Time Machine (checkout_memory), Multiverse branching, Human-in-the-Loop PRs, Agent Time Machine — future enhancements

</deferred>

---

*Phase: 01-core-mvp*
*Context gathered: 2026-03-27*
