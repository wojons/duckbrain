# Phase 04: Web UI - GSD Command Reference

**Phase:** 04-web-ui  
**Created:** 2026-04-03  
**Purpose:** Complete GSD (Get Shit Done) command reference for working with this phase

---

## What is GSD?

**GSD** (Get Shit Done) is a project planning and execution system optimized for solo agentic development. It creates hierarchical plans with clear phases, tasks, and verification criteria.

---

## Quick Start

```
/gsd-new-project → /gsd-plan-phase → /gsd-execute-phase → repeat
```

---

## Core Commands

### Project Initialization

**`/gsd-new-project`**
Initialize new project through unified flow.

Creates all `.planning/` artifacts:
- `PROJECT.md` — vision and requirements
- `config.json` — workflow mode (interactive/yolo)
- `research/` — domain research (if selected)
- `REQUIREMENTS.md` — scoped requirements with REQ-IDs
- `ROADMAP.md` — phases mapped to requirements
- `STATE.md` — project memory

**`/gsd-map-codebase`**
Map an existing codebase for brownfield projects.

### Phase Planning

**`/gsd-discuss-phase <number>`**
Help articulate your vision for a phase before planning.

**`/gsd-research-phase <number>`**
Comprehensive ecosystem research for niche/complex domains.

**`/gsd-list-phase-assumptions <number>`**
See what the agent is planning to do before it starts.

**`/gsd-plan-phase <number>`**
Create detailed execution plan for a specific phase.

- Generates `.planning/phases/XX-phase-name/XX-YY-PLAN.md`
- Breaks phase into concrete, actionable tasks
- Includes verification criteria and success measures

**PRD Express Path:** Pass `--prd path/to/requirements.md` to skip discuss-phase entirely.

### Execution

**`/gsd-execute-phase <phase-number>`**
Execute all plans in a phase, or run a specific wave.

- Groups plans by wave (from frontmatter)
- Optional `--wave N` flag executes only Wave `N`

### Smart Router

**`/gsd-do <description>`**
Route freeform text to the right GSD command automatically.

**`/gsd-quick [--full] [--discuss] [--research]`**
Execute small, ad-hoc tasks with GSD guarantees.

**`/gsd-fast [description]`**
Execute a trivial task inline — no subagents, no planning files.

### Roadmap Management

**`/gsd-add-phase <description>`**
Add new phase to end of current milestone.

**`/gsd-insert-phase <after> <description>`**
Insert urgent work as decimal phase between existing phases.

**`/gsd-remove-phase <number>`**
Remove a future phase and renumber subsequent phases.

### Progress Tracking

**`/gsd-progress`**
Check project status and intelligently route to next action.

**`/gsd-resume-work`**
Resume work from previous session with full context restoration.

**`/gsd-pause-work`**
Create context handoff when pausing work mid-phase.

### Debugging

**`/gsd-debug [issue description]`**
Systematic debugging with persistent state across context resets.

### Todo Management

**`/gsd-add-todo [description]`**
Capture idea or task as todo from current conversation.

**`/gsd-check-todos [area]`**
List pending todos and select one to work on.

**`/gsd-note <text>`**
Zero-friction idea capture — one command, instant save.

### Verification

**`/gsd-verify-work [phase]`**
Validate built features through conversational UAT.

**`/gsd-audit-uat`**
Cross-phase audit of all outstanding UAT and verification items.

### Shipping

**`/gsd-ship [phase]`**
Create a PR from completed phase work with auto-generated body.

**`/gsd-review --phase N [--gemini] [--claude] [--codex] [--all]`**
Cross-AI peer review of phase plans.

---

## Project Structure

```
.planning/
├── PROJECT.md            # Project vision
├── ROADMAP.md            # Current phase breakdown
├── STATE.md              # Project memory & context
├── config.json           # Workflow mode & gates
├── phases/
│   └── 04-web-ui/
│       ├── 04-CONTEXT.md
│       ├── 04-01-PLAN.md
│       └── 04-01-SUMMARY.md
└── codebase/
    ├── STACK.md
    ├── ARCHITECTURE.md
    └── ...
```

---

## Workflow Modes

**Interactive Mode**
- Confirms each major decision
- Pauses at checkpoints for approval

**YOLO Mode**
- Auto-approves most decisions
- Executes plans without confirmation

Change anytime by editing `.planning/config.json`

---

## Common Workflows for Phase 04

**Planning the Web UI:**
```
/gsd-discuss-phase 4    # Share your vision
/gsd-plan-phase 4       # Create detailed plan
/gsd-execute-phase 4    # Execute all plans
```

**Resuming after break:**
```
/gsd-progress           # See where you left off
```

**Adding urgent UI fix:**
```
/gsd-insert-phase 4 "Fix critical CSS bug"
/gsd-plan-phase 4.1
/gsd-execute-phase 4.1
```

**Capturing UI ideas:**
```
/gsd-add-todo Add glassmorphism effect to sidebar
/gsd-note consider using Framer Motion for animations
```

**Debugging UI issues:**
```
/gsd-debug "tree view not rendering children"
```

---

## Configuration

**`/gsd-settings`**
Configure workflow toggles and model profile interactively.

**`/gsd-set-profile <profile>`**
- `quality` — Opus everywhere
- `balanced` — Opus for planning, Sonnet for execution (default)
- `budget` — Sonnet for writing, Haiku for research/verification
- `inherit` — Use current session model

---

## Files & Structure Reference

```
.planning/
├── PROJECT.md            # Project vision
├── ROADMAP.md            # Current phase breakdown
├── STATE.md              # Project memory & context
├── RETROSPECTIVE.md      # Living retrospective
├── config.json           # Workflow mode & gates
├── todos/
│   ├── pending/
│   └── done/
├── debug/
│   └── resolved/
├── milestones/
│   └── v1.0-phases/
├── codebase/
│   ├── STACK.md
│   ├── ARCHITECTURE.md
│   ├── STRUCTURE.md
│   ├── CONVENTIONS.md
│   ├── TESTING.md
│   ├── INTEGRATIONS.md
│   └── CONCERNS.md
└── phases/
    └── 04-web-ui/
        ├── 04-CONTEXT.md
        ├── 04-01-PLAN.md
        └── 04-01-SUMMARY.md
```

---

## Getting Help

- Read `.planning/PROJECT.md` for project vision
- Read `.planning/STATE.md` for current context
- Check `.planning/ROADMAP.md` for phase status
- Run `/gsd-progress` to check where you're up to
- Run `/gsd-help` to see this reference

---

*This reference covers the essential GSD commands for working with Phase 04 (Web UI). For the complete reference with all commands, flags, and advanced usage, see the main GSD documentation.*
