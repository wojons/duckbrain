# DuckBrain Documentation

Welcome to the DuckBrain documentation! DuckBrain is an AI Memory System with Git-versioned persistence.

## What is DuckBrain?

DuckBrain provides AI agents with **persistent, queryable, version-controlled memory** — without running a traditional database. Memories are stored as append-only JSONL files, queried via DuckDB (including vector search), and fully versioned by Git.

**Core Value:** Agents can remember and learn across sessions with full history, zero-cost branching, and collaborative sharing — all without database operations.

## Quick Links

- [Getting Started](guide/getting-started) - Installation and first steps
- [AI Agent Configuration](guide/ai-configure) - Configure DuckBrain for Claude, Cursor, and other AI agents
- [MCP Tools Reference](api/mcp-tools) - Complete MCP tool documentation
- [HTTP API](api/http-api) - REST API endpoints
- [Configuration](guide/configuration) - Environment variables and settings
- [Deployment](guide/deployment) - Docker, production setup

## Features

- 🧠 **Hierarchical Memory Keys** — Filesystem-style paths (`/projects/mcp/schema`)
- 🔍 **Vector Search** — Built-in similarity search with DuckDB VSS
- 🌳 **Git Version Control** — Full audit trail, branching, time-travel
- 🚀 **Multiple Interfaces** — MCP server, HTTP API, CLI, Web UI
- 👥 **Multi-Agent Ready** — HTTP mode with worktrees for concurrent access
- 🎨 **Beautiful Web UI** — Glassmorphism theme, real-time updates
- 📱 **Keyboard Shortcuts** — Power-user friendly navigation

## Architecture

DuckBrain uses a layered architecture:

- **MCP Layer** - Model Context Protocol server for AI agent integration
- **HTTP Layer** - REST API for web UI and remote access
- **CLI Layer** - Command-line interface for scripting and automation
- **Storage Layer** - JSONL files with DuckDB query layer
- **Git Layer** - Automatic versioning and branching

## Getting Help

- 💬 [GitHub Discussions](https://github.com/wojons/duckbrain/discussions)
- 🐛 [Report Issues](https://github.com/wojons/duckbrain/issues)
- 📧 Contact: [Your email/contact]

## License

- **Code**: Apache License 2.0
- **Brand Assets**: CC BY-NC-ND 4.0
- See [License Information](guide/license) for details
