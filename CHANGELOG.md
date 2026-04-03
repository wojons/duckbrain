# Changelog

All notable changes to DuckBrain will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.0.0] - 2026-04-03

### Added

#### Core Features
- **MCP Server** - Full MCP protocol implementation with stdio and HTTP transports
- **Memory Storage** - JSONL-based append-only storage with DuckDB querying
- **Vector Search** - Built-in similarity search using DuckDB VSS extension
- **Git Versioning** - Complete version control with branching and time-travel

#### MCP Tools
- `remember()` - Store memories with hierarchical keys
- `recall()` - Query memories with semantic search
- `list_keys()` - Discover available memory keys
- `forget()` - Mark memories as tombstoned

#### Web UI
- **Memory Tree** - File-explorer-style navigation with expand/collapse
- **Timeline View** - Chronological memory browser with virtual scrolling
- **Inspector Panel** - Detailed memory viewing with JSON viewer
- **Real-time Updates** - SSE-based live updates
- **Keyboard Shortcuts** - Power-user navigation (`?` for help, `Esc` to close)
- **Glassmorphism Theme** - Beautiful dark UI with Tailwind CSS v4

#### Technical Features
- **HTTP API** - Express routes wrapping MCP tools
- **Multi-Agent Support** - Git worktrees for concurrent access
- **SSH Tunneling** - Remote access without open ports
- **Docker Support** - Multi-stage builds with Alpine and Debian variants
- **Type Safety** - Full TypeScript implementation

#### Documentation
- Comprehensive README with badges and screenshots
- Generated logo and mascot assets
- UI screenshots for Tree, Timeline, and Keyboard Shortcuts
- Architecture diagrams
- Contributing guidelines

### Technical Stack
- Vite + React + TypeScript
- TanStack Query v5 + TanStack Table v8
- Zustand for state management
- Tailwind CSS v4 with custom glassmorphism theme
- DuckDB with VSS extension
- Git for version control

## [0.1.0] - 2026-03-15

### Added
- Initial project setup
- Core MCP server implementation
- Basic memory storage with JSONL
- DuckDB integration
- CLI commands (stdio, http)

---

## Future Roadmap

### Planned for v1.1.0
- [ ] Web-based memory editor
- [ ] Import/export functionality
- [ ] Advanced search filters
- [ ] Memory templates
- [ ] Collaborative editing

### Planned for v1.2.0
- [ ] Plugin system
- [ ] Custom embedding providers
- [ ] Advanced analytics dashboard
- [ ] Memory compression strategies

## Migration Guide

### Upgrading to 1.0.0

**Breaking Changes:**
- Storage format updated to JSONL v2
- API endpoints reorganized under `/api/v1/`
- Configuration file format changed

**Migration Steps:**
1. Backup your data: `cp -r data/ data-backup/`
2. Run migration: `npm run migrate:v1`
3. Verify data integrity
4. Update configuration files

## Security Notes

### v1.0.0
- Authentication via JWT tokens
- Rate limiting on HTTP endpoints
- Input validation on all MCP tools
- CORS configured for localhost development

---

For the complete list of changes, see the [commit history](https://github.com/wojons/duckbrain/commits/main).
