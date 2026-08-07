# AGENTS.md — DuckBrain

## Project Context

DuckBrain is a git-backed persistent memory system for AI agents. It uses DuckDB
for storage, exposes MCP tools for agent integration, provides an HTTP API for
web access, and supports namespace management for memory isolation.

## Tech Stack

- **Language:** TypeScript 7.x (strict mode)
- **Runtime:** Node.js 22+
- **Database:** DuckDB (via node-duckdb)
- **Test Framework:** Vitest (32 suites, 254 tests)
- **Build:** Vite (frontend), tsc (backend)
- **Package Manager:** pnpm 11+

## Key Architecture

- `src/mcp/` — MCP tool implementations (remember, recall, forget, list_keys, namespace, squash)
- `src/http/` — Express HTTP API (routes, middleware)
- `src/duckdb/` — DuckDB query layer
- `src/storage/` — JSONL storage + manifest management
- `src/git/` — Git operations (auto-commit, merge, squash)
- `src/schema/` — Memory schema validation
- `packages/ui/` — React frontend (Vite + Tailwind)

## Development

```bash
pnpm install
pnpm build
pnpm test          # 254 tests, 32 suites
pnpm tsc --noEmit  # TypeScript check
```

## Foreman

The `.coding-hermes/board/` DuckDB board (`board.db` with `tasks.parquet` and
`events.parquet`) is the single source of truth for project state. The legacy
`.coding-hermes/tasks.md` board was archived to `tasks.md.bak` during the
DuckDB migration. See the coding-hermes-cron skill for the foreman workflow.
