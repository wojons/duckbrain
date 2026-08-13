# AGENTS.md — DuckBrain

## Project Context

DuckBrain is a git-backed persistent memory system for AI agents. It uses DuckDB
for storage, exposes MCP tools for agent integration, provides an HTTP API for
web access, and supports namespace management for memory isolation.

## Tech Stack

- **Language:** TypeScript 7.x (strict mode)
- **Runtime:** Node.js 22+
- **Database:** DuckDB (via node-duckdb)
- **Test Framework:** Vitest (50 suites, 370 tests)
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
pnpm test          # 370 tests, 50 suites
pnpm tsc --noEmit  # TypeScript check
```

## Skills

The [DuckBrain Usage Skill](skills/duckbrain-usage/SKILL.md) is the primary
guide for day-to-day usage — CLI commands, MCP tools, and HTTP API recipes.
See also the [AI-Agent Integration Guide](docs/guide/ai-configure.md) for
configuring DuckBrain as an agent memory backend.

## Foreman

The `.coding-hermes/board/` JSONL board (`tasks.jsonl` + `events.jsonl`,
git-tracked, DuckDB-native via `read_json_auto`) is the single source of truth
for project state. `board.db` and `*.parquet` are untracked rebuildable caches
(JSONL canonical, Bane directive 08-07). The legacy
`.coding-hermes/tasks.md` board was archived to `tasks.md.bak` during the
DuckDB migration. See the coding-hermes-cron skill for the foreman workflow.
