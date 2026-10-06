# External Integrations

**Analysis Date:** 2026-03-27

## APIs & External Services

**Opencode AI Platform:**
- Primary integration point for all agent and command functionality
- SDK/Client: `@opencode-ai/sdk` v1.3.0
- Plugin interface: `@opencode-ai/plugin` v1.3.0
- Auth: Handled by Opencode AI platform (no direct credentials in codebase)

**Anthropic Claude API:**
- Indirect integration via Opencode AI platform
- Statusline hook reads model info from platform context (`data.model.display_name`)
- No direct API keys in codebase

## Data Storage

**Databases:**
- None - Filesystem-based state management only

**File Storage:**
- Local filesystem for all persistence:
  - `.opencode/todos/` - Session-based todo tracking (runtime, not committed)
  - `.planning/` - Planning artifacts and codebase analysis
  - `.opencode/get-shit-done/` - Persistent workflow state

**Caching:**
- Filesystem cache in `~/.opencode/cache/` (external to repo):
  - `gsd-update-check.json` - Update availability checks
  - Context bridge files: `claude-ctx-{session}.json` in OS temp directory

## Authentication & Identity

**Auth Provider:**
- Opencode AI platform handles all authentication
- No credential files in repository
- Hooks read session context from platform-provided JSON via stdin

## Monitoring & Observability

**Error Tracking:**
- None - Errors logged to console/stdio only

**Logs:**
- Console output from hooks and CLI tools
- Statusline hook outputs to terminal status bar
- No centralized logging system

## CI/CD & Deployment

**Hosting:**
- Git repository (`.git` present)
- No CI/CD configuration files detected (no `.github/`, `.gitlab-ci.yml`, etc.)

**CI Pipeline:**
- None detected

**Version Control:**
- Git with standard structure
- `.opencode/.gitignore` ignores `node_modules/`, `package.json`, `bun.lock`

## Environment Configuration

**Required env vars:**
- `CLAUDE_CONFIG_DIR` (optional) - Custom config directory path (respects `~/.opencode` by default)
- No other environment variables detected in codebase

**Secrets location:**
- No secrets stored in repository
- Platform manages authentication externally

## Webhooks & Callbacks

**Incoming:**
- None - Hooks are invoked synchronously by Opencode AI platform via stdin/stdout

**Outgoing:**
- None detected - No webhook callback implementations found

## Git Integration

**Git Operations:**
- Direct git CLI usage via `child_process.execSync()` in `.opencode/get-shit-done/bin/lib/commands.cjs`
- Functions for:
  - `execGit()` - Wrapper for git commands
  - `isGitIgnored()` - Check if path is gitignored
  - `commit-to-subrepo` - Custom commit workflow
  - Planning commit workflows documented in `.opencode/get-shit-done/references/git-planning-commit.md`

## Model Integration

**AI Models:**
- Anthropic Claude models (via Opencode AI platform)
- Model profiles defined in `.opencode/get-shit_done/references/model-profiles.md`
- Resolution logic in `.opencode/get-shit-done/references/model-profile-resolution.md`
- Statusline displays current model from platform context

---

*Integration audit: 2026-03-27*
