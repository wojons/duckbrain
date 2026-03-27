# Technology Stack

**Analysis Date:** 2026-03-27

## Languages

**Primary:**
- JavaScript (ES6/CommonJS) - All runtime code in hooks and bin scripts

**Secondary:**
- Markdown - Agent definitions, command workflows, templates, and documentation

## Runtime

**Environment:**
- Node.js (via Bun package manager)
- CommonJS module system (`require()`/`module.exports`)

**Package Manager:**
- Bun 1.x
- Lockfile: `bun.lock` (present)

## Frameworks

**Core:**
- Opencode AI Platform - Host framework for agents and commands
- Get-Shit-Done (GSD) System v1.30.0 - Custom workflow orchestration layer

**Testing:**
- Not detected - No test framework configuration found

**Build/Dev:**
- No transpilation step - JavaScript runs directly via Node.js shebang (`#!/usr/bin/env node`)

## Key Dependencies

**Critical:**
- `@opencode-ai/plugin` v1.3.0 - Main plugin interface for Opencode AI integration
- `@opencode-ai/sdk` v1.3.0 - SDK for Opencode AI platform communication (transitive dependency)
- `zod` v4.1.8 - Schema validation library for runtime type checking

**Infrastructure:**
- Native Node.js modules only:
  - `fs` - File system operations
  - `path` - Path manipulation
  - `os` - OS-level utilities
  - `child_process` - Spawning subprocesses
  - `readline` - Interactive input handling

## Configuration

**Environment:**
- No `.env` files detected
- Configuration via JSON files:
  - `.opencode/opencode.json` - Permission and path allowlists
  - `.opencode/settings.json` - Editor settings (currently empty `{}`)
  - `.opencode/get-shit-done/templates/config.json` - Template configuration

**Build:**
- No build configuration - JavaScript executes directly
- Version tracked in `.opencode/get-shit-done/VERSION` (currently `1.30.0`)

## Platform Requirements

**Development:**
- Opencode AI installation required
- Bun package manager for dependency management
- Node.js compatible runtime environment

**Production:**
- Deploys as configuration layer within Opencode AI ecosystem
- Runs as hooks and CLI tools invoked by Opencode AI

## File Structure Summary

**Source Code Locations:**
- `.opencode/hooks/*.js` - Runtime hooks (statusline, context monitoring, workflow guards)
- `.opencode/get-shit-done/bin/lib/*.cjs` - Core utility modules
- `.opencode/agents/*.md` - Agent definition prompts
- `.opencode/command/*.md` - Command workflow definitions
- `.opencode/get-shit-done/templates/` - Output templates for various artifacts
- `.opencode/get-shit-done/references/` - Reference documentation for workflows

---

*Stack analysis: 2026-03-27*
