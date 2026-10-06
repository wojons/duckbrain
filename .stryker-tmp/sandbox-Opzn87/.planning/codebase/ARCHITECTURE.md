# Architecture

**Analysis Date:** 2026-03-27

## Pattern Overview

**Overall:** Modular CLI Tool with Agent Orchestration

**Key Characteristics:**
- Single executable entry point (`gsd-tools.cjs`) routing to modular commands
- Stateless command execution with file-based state persistence
- Agent-driven workflow using markdown prompts as agent instructions
- Hook-based runtime monitoring and intervention

## Layers

**CLI Layer:**
- Purpose: Command routing and argument parsing
- Location: `.opencode/get-shit-done/bin/gsd-tools.cjs`
- Contains: Atomic command definitions, subcommand dispatchers
- Depends on: Core utilities (`core.cjs`), configuration (`config.cjs`)
- Used by: All GSD command files in `.opencode/command/` and `.opencode/get-shit-done/workflows/`

**Core Utilities Layer:**
- Purpose: Shared infrastructure and state management
- Location: `.opencode/get-shit-done/bin/lib/`
- Contains: `core.cjs`, `config.cjs`, `phase.cjs`, `state.cjs`, `frontmatter.cjs`
- Depends on: Node.js built-ins (fs, path, child_process)
- Used by: CLI layer, hooks, commands

**Agent Layer:**
- Purpose: AI agent instructions and workflows
- Location: `.opencode/agents/` and `.opencode/get-shit-done/workflows/`
- Contains: Specialized agent prompts (planner, executor, researcher, verifier)
- Depends on: Templates, state files, planning documents
- Used by: Opencode AI runtime

**Template Layer:**
- Purpose: Standardized document structures
- Location: `.opencode/get-shit-done/templates/`
- Contains: Phase templates, codebase analysis templates, project scaffolding
- Depends on: None (static templates)
- Used by: Agents for document generation

**Hook Layer:**
- Purpose: Runtime monitoring and intervention
- Location: `.opencode/hooks/`
- Contains: Context monitor, statusline, workflow guards, update checker
- Depends on: CLI tools, temporary state files
- Used by: Opencode hook system (PostToolUse/AfterTool)

## Data Flow

**CLI Command Execution:**

1. User invokes command via `.opencode/command/gsd-*.md`
2. Opencode routes to `gsd-tools.cjs` with arguments
3. Command module parses arguments, loads config via `core.cjs`
4. State/read planning files from `.planning/`
5. Execute operation (state update, phase creation, verification)
6. Output result as JSON or formatted text

**Agent Workflow:**

1. Agent reads workflow markdown from `.opencode/get-shit-done/workflows/`
2. Agent loads context from `.planning/STATE.md`, `ROADMAP.md`, phase directories
3. Agent executes tasks using provided tools (file ops, search, NotebookLM)
4. Agent writes artifacts to `.planning/phases/XX-name/`
5. Hooks monitor context usage via `gsd-context-monitor.js`
6. On task completion, agent commits via `gsd-tools.cjs commit`

**State Management:**
- File-based state in `.planning/STATE.md` with frontmatter metadata
- Roadmap in `.planning/ROADMAP.md` tracking phase progress
- Phase-specific state in `.planning/phases/XX-name/` directories
- Runtime signals in `/tmp/claude-ctx-{session_id}.json` for hook communication

## Key Abstractions

**Phase:**
- Purpose: Unit of work representing a coherent feature or milestone
- Examples: `.planning/phases/01-discovery/`, `.planning/phases/02-planning/`
- Pattern: Decimal numbering (1.1, 1.2) for sub-phases, directory-per-phase

**Plan:**
- Purpose: Executable task specification within a phase
- Examples: `.planning/phases/XX-name/XX-NN-plan.md`
- Pattern: Frontmatter metadata + wave-based task grouping

**Summary:**
- Purpose: Phase completion record with outcomes and metrics
- Examples: `.planning/phases/XX-name/XX-NN-summary.md`
- Pattern: Structured frontmatter with duration, score, requirements-completed

**Workstream:**
- Purpose: Parallel development tracks within a project
- Pattern: Configured in `.planning/config.json`, affects path resolution

## Entry Points

**CLI Main:**
- Location: `.opencode/get-shit-done/bin/gsd-tools.cjs`
- Triggers: Command invocation from agent workflows
- Responsibilities: Parse command, route to handler, output result

**Hooks:**
- Location: `.opencode/hooks/gsd-*.js`
- Triggers: Opencode tool use events
- Responsibilities: Monitor context, enforce workflows, update statusline

**Agents:**
- Location: `.opencode/agents/gsd-*.md`
- Triggers: User command via `/gsd-*` slash commands
- Responsibilities: Execute specialized workflows (planning, research, verification)

## Error Handling

**Strategy:** Fail-fast with structured error output for CLI, graceful degradation for hooks

**Patterns:**
- CLI commands: `error()` helper outputs JSON `{error: "message"}` and exits non-zero
- Hooks: Silent exit on missing state (subagent detection), timeout guards on stdin
- Agents: Verification tools validate artifacts before acceptance

## Cross-Cutting Concerns

**Logging:**
- Console output for CLI commands (JSON or plain text)
- Temporary files in `/tmp/` for inter-process communication
- Git commits for planning document history

**Validation:**
- Frontmatter schema validation in `frontmatter.cjs`
- Verification commands: `verify plan-structure`, `verify phase-completeness`
- Hook-based guards: `gsd-workflow-guard.js` prevents invalid state transitions

**Authentication:**
- Not applicable (local CLI tool, no external API calls except optional websearch)

**Configuration:**
- `.planning/config.json` for project-level settings
- `.opencode/opencode.json` for Opencode permissions
- Model profiles in `model-profiles.cjs` for agent routing

---

*Architecture analysis: 2026-03-27*
