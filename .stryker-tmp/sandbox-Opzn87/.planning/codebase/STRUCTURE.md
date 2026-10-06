# Codebase Structure

**Analysis Date:** 2026-03-27

## Directory Layout

```
/Users/lexykwaii/Code/duckbrain/
├── .opencode/                    # Opencode AI agent configuration
│   ├── agents/                   # Specialized AI agent prompts
│   ├── command/                  # User-facing slash commands
│   ├── get-shit-done/            # GSD framework core
│   ├── hooks/                    # Runtime hooks for monitoring
│   ├── node_modules/             # Opencode plugin dependencies
│   ├── opencode.json             # Opencode permissions config
│   └── gsd-file-manifest.json    # Generated file manifest
├── .planning/                    # Project state and documentation
│   └── codebase/                 # Codebase analysis documents
└── .git/                         # Git repository
```

## Directory Purposes

**.opencode/agents/:**
- Purpose: AI agent instruction prompts for specialized tasks
- Contains: Markdown files (`gsd-*.md`) defining agent behaviors
- Key files: `gsd-planner.md`, `gsd-executor.md`, `gsd-phase-researcher.md`, `gsd-verifier.md`
- Subdirectories: None (flat structure)

**.opencode/command/:**
- Purpose: User-facing slash command definitions
- Contains: Markdown files mapping `/gsd-*` to workflows
- Key files: `gsd-plan-phase.md`, `gsd-execute-phase.md`, `gsd-map-codebase.md`, `gsd-new-project.md`
- Subdirectories: `gsd/` (additional command metadata)

**.opencode/get-shit-done/:**
- Purpose: GSD framework implementation
- Contains: CLI tools, templates, workflows, references
- Key files: `VERSION`, directory structure for organization
- Subdirectories:
  - `bin/` - Executable CLI tools
  - `commands/` - Command metadata
  - `references/` - Internal documentation
  - `templates/` - Document templates
  - `workflows/` - Agent workflow definitions

**.opencode/get-shit-done/bin/:**
- Purpose: CLI executable and shared libraries
- Contains: `gsd-tools.cjs` (main CLI), `lib/` (modules)
- Key files: `gsd-tools.cjs` (918 lines), module files in `lib/`
- Subdirectories: `lib/` (17 module files)

**.opencode/get-shit-done/bin/lib/:**
- Purpose: Shared utility modules for CLI
- Contains: CommonJS modules (`.cjs`) for reusable logic
- Key files: `core.cjs`, `commands.cjs`, `phase.cjs`, `state.cjs`, `frontmatter.cjs`, `verify.cjs`
- Subdirectories: None

**.opencode/get-shit-done/templates/:**
- Purpose: Standardized document structures
- Contains: Template markdown files for various artifacts
- Key files: `phase-prompt.md`, `project.md`, `roadmap.md`, `summary.md`
- Subdirectories: `codebase/`, `research-project/`

**.opencode/get-shit-done/templates/codebase/:**
- Purpose: Templates for codebase analysis documents
- Contains: `architecture.md`, `structure.md`, `conventions.md`, `testing.md`, `stack.md`, `integrations.md`, `concerns.md`
- Key files: All template files for `.planning/codebase/` output

**.opencode/get-shit-done/workflows/:**
- Purpose: Agent workflow definitions
- Contains: Markdown files defining multi-step processes
- Key files: `execute-phase.md`, `plan-phase.md`, `autonomous.md`, `manager.md`
- Subdirectories: None

**.opencode/get-shit-done/references/:**
- Purpose: Internal documentation for GSD framework
- Contains: Markdown files explaining patterns and configs
- Key files: `planning-config.md`, `git-integration.md`, `verification-patterns.md`, `user-profiling.md`
- Subdirectories: None

**.opencode/hooks/:**
- Purpose: Runtime monitoring and intervention
- Contains: JavaScript files for Opencode hooks
- Key files: `gsd-context-monitor.js`, `gsd-statusline.js`, `gsd-workflow-guard.js`, `gsd-check-update.js`
- Subdirectories: None

**.planning/:**
- Purpose: Project state, roadmap, and phase documentation
- Contains: `STATE.md`, `ROADMAP.md`, `config.json`, `phases/`, `codebase/`
- Key files: Created per-project (empty in this repo - this is the framework itself)
- Subdirectories: `codebase/` (codebase analysis outputs)

## Key File Locations

**Entry Points:**
- `.opencode/get-shit-done/bin/gsd-tools.cjs`: Main CLI executable (918 lines)
- `.opencode/hooks/gsd-*.js`: Hook entry points (5 hooks)
- `.opencode/agents/gsd-*.md`: Agent prompt entry points (16 agents)

**Configuration:**
- `.opencode/opencode.json`: Opencode permissions and allowed directories
- `.opencode/package.json`: Node.js dependencies (@opencode-ai/plugin)
- `.opencode/get-shit-done/VERSION`: Framework version identifier

**Core Logic:**
- `.opencode/get-shit-done/bin/lib/core.cjs`: Shared utilities, path resolution, state helpers
- `.opencode/get-shit-done/bin/lib/commands.cjs`: Atomic command implementations
- `.opencode/get-shit-done/bin/lib/phase.cjs`: Phase operations (add, remove, complete)
- `.opencode/get-shit-done/bin/lib/state.cjs`: State file parsing and updates
- `.opencode/get-shit-done/bin/lib/frontmatter.cjs`: Frontmatter extraction and validation

**Templates:**
- `.opencode/get-shit-done/templates/codebase/architecture.md`: ARCHITECTURE.md template
- `.opencode/get-shit-done/templates/codebase/structure.md`: STRUCTURE.md template
- `.opencode/get-shit-done/templates/phase-prompt.md`: Phase planning prompt structure

**Testing:**
- No test directory present
- Validation via `verify` commands in CLI

**Documentation:**
- `.opencode/get-shit-done/references/`: Framework internals documentation
- `.planning/codebase/`: Output location for codebase analysis

## Naming Conventions

**Files:**
- `gsd-*.md`: Agent prompts and commands (kebab-case with `gsd-` prefix)
- `gsd-*.js`: Hook files (kebab-case with `gsd-` prefix)
- `*.cjs`: CommonJS modules (kebab-case)
- `XX-name.md`: Phase files with numeric prefix (e.g., `01-discovery.md`)

**Directories:**
- kebab-case for all directories
- Numeric prefixes for ordered content (e.g., `01-discovery/`)
- Plural names for collections (e.g., `agents/`, `commands/`, `templates/`)

**Special Patterns:**
- `.md` files in `command/` map to `/gsd-{name}` slash commands
- `.md` files in `agents/` define specialized AI personalities
- `.cjs` modules in `lib/` are imported by `gsd-tools.cjs`

## Where to Add New Code

**New CLI Command:**
- Primary code: `.opencode/get-shit-done/bin/lib/commands.cjs` (add function)
- Export in: `.opencode/get-shit-done/bin/gsd-tools.cjs` (add case to switch)
- Documentation: `.opencode/get-shit-done/references/` if complex

**New Agent:**
- Implementation: `.opencode/agents/gsd-{name}.md`
- Command wrapper: `.opencode/command/gsd-{name}.md`
- Workflow (if needed): `.opencode/get-shit-done/workflows/gsd-{name}.md`

**New Hook:**
- Implementation: `.opencode/hooks/gsd-{name}.js`
- Registration: Via Opencode configuration (automatic for `*.js` in hooks/)

**New Template:**
- Template file: `.opencode/get-shit-done/templates/{name}.md`
- Reference in: Agent prompts that generate this artifact

**Utilities:**
- Shared helpers: `.opencode/get-shit-done/bin/lib/core.cjs`
- New module: `.opencode/get-shit-done/bin/lib/{name}.cjs`

## Special Directories

**.planning/:**
- Purpose: Project-specific state and documentation
- Generated: Yes (by `gsd-new-project` and phase operations)
- Committed: Yes (unless `commit_docs: false` in config)
- Note: Empty in this repo - this is the framework, not a project instance

**.opencode/node_modules/:**
- Purpose: Opencode plugin dependencies
- Generated: Yes (by `npm install` / `bun install`)
- Committed: No (in `.gitignore`)

---

*Structure analysis: 2026-03-27*
