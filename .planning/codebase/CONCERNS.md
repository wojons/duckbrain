# Codebase Concerns

**Analysis Date:** 2026-03-27

## Tech Debt

**Monolithic gsd-tools.cjs CLI (918 lines):**
- Issue: Single entry point with 50+ commands, complex argument parsing, and multiple compound operations
- Files: `.opencode/get-shit-done/bin/gsd-tools.cjs`
- Why: Centralized utility growth without modularization
- Impact: Hard to test individual commands, difficult to onboard new contributors, risk of regressions when modifying shared arg parsing logic
- Fix approach: Split into command modules under `bin/commands/` with lazy loading, keep gsd-tools.cjs as thin dispatcher

**Large library files with mixed responsibilities:**
- Issue: Several lib files exceed 1000+ lines with multiple unrelated utilities
- Files: `.opencode/get-shit-done/bin/lib/init.cjs` (1442 lines), `.opencode/get-shit-done/bin/lib/core.cjs` (1230 lines), `.opencode/get-shit-done/bin/lib/state.cjs` (1031 lines)
- Why: Organic growth as workflow complexity increased
- Impact: Navigation difficulty, unclear boundaries, harder to isolate bugs
- Fix approach: Extract discrete utilities into separate files (e.g., `core.cjs` → `git.cjs`, `config.cjs`, `paths.cjs`)

**Workflow templates embedded as markdown strings in code:**
- Issue: 57 workflow files with complex bash/JavaScript hybrid logic, no syntax validation
- Files: `.opencode/get-shit-done/workflows/*.md` (18,988 total lines)
- Why: Workflows designed as readable documentation first, executable second
- Impact: No type checking, runtime errors only caught during execution, difficult to refactor safely
- Fix approach: Consider migrating to YAML/JSON frontmatter with schema validation, or TypeScript-based workflow definitions

**Silent error handling throughout core utilities:**
- Issue: Empty catch blocks suppress failures without logging or recovery
- Files: `.opencode/get-shit-done/bin/lib/core.cjs` (lines 34, 36, 231, 264, 502), `.opencode/get-shit-done/bin/lib/*.cjs` (similar patterns)
- Why: Defensive coding to handle optional operations (config files, git repos)
- Impact: Failures masked, debugging difficult, state corruption possible if partial operations fail
- Fix approach: Add debug logging for suppressed errors, use explicit option types for optional operations

**No TypeScript migration despite complex logic:**
- Issue: All JavaScript files use `.cjs` extension with no type annotations
- Files: `.opencode/get-shit-done/bin/**/*.cjs`
- Why: Started as simple scripts, grew in complexity
- Impact: No compile-time type checking, IDE autocomplete limited, refactoring risky
- Fix approach: Migrate to TypeScript with JSDoc annotations minimum, full `.ts` conversion ideal

## Known Bugs

**Workstream migration can lose phase state:**
- Symptoms: Phase progress not preserved when migrating between workstreams
- Trigger: Using `/gsd-workstream create --migrate-name` with complex phase histories
- Files: `.opencode/get-shit-done/bin/lib/workstream.cjs`, `.opencode/get-shit-done/workflows/workstreams.md`
- Workaround: Manual backup of phase directories before migration
- Root cause: Migration script focuses on config transfer, not full state synchronization

**Decimal phase renumbering can conflict with existing phases:**
- Symptoms: Duplicate phase numbers after inserting decimal phases (e.g., two "3.1" phases)
- Trigger: Multiple insertions without updating roadmap
- Files: `.opencode/get-shit-done/bin/lib/phase.cjs`
- Workaround: Run `/gsd-validate-consistency` after phase operations
- Root cause: Next-decimal calculation doesn't account for recently inserted phases

## Security Considerations

**Web search API keys stored in plaintext config:**
- Risk: Brave API credentials in `.planning/config.json` exposed if repo leaked
- Files: `.planning/config.json` (structure allows `websearch.apiKey`)
- Current mitigation: File typically in `.gitignore`
- Recommendations: Support environment variable injection (`BRAVE_API_KEY`), add secret scanning to verification workflows

**No validation of external workflow content:**
- Risk: Workflow files pulled from external sources could execute arbitrary commands
- Files: `.opencode/get-shit-done/workflows/*.md` (execution via subagent prompts)
- Current mitigation: All workflows are local, user-curated
- Recommendations: Add checksum verification for externally-sourced workflows, document trusted sources only

## Performance Bottlenecks

**Full roadmap parse on every phase operation:**
- Problem: Reading and parsing entire ROADMAP.md for single phase queries
- Files: `.opencode/get-shit-done/bin/lib/roadmap.cjs` (329 lines, full parse logic)
- Measurement: Noticeable delay on projects with 50+ phases
- Cause: No caching of parsed roadmap structure
- Improvement path: Add JSON cache of parsed roadmap, invalidate on write operations

**Workflow file discovery scans all 57 files:**
- Problem: Every workflow lookup iterates through all workflow markdown files
- Files: `.opencode/get-shit-done/workflows/` directory
- Measurement: ~100-200ms per workflow resolution on large projects
- Cause: No index or manifest for workflow discovery
- Improvement path: Generate workflow index at build time, use manifest for lookups

**Verification workflows grep entire codebase:**
- Problem: Stub detection runs multiple `grep -rn` across all source files
- Files: `.opencode/get-shit-done/references/verification-patterns.md`, `.opencode/get-shit-done/workflows/verify-phase.md`
- Measurement: 2-5 seconds on medium-sized codebases
- Cause: No incremental verification, full scan every time
- Improvement path: Cache previous verification results, only scan changed files

## Fragile Areas

**Argument parsing in gsd-tools.cjs:**
- Files: `.opencode/get-shit-done/bin/gsd-tools.cjs` (lines 156-196, `parseNamedArgs`, `parseMultiwordArg`)
- Why fragile: Custom argument parser with edge cases for multiword values, boolean flags, positional args
- Common failures: Quotes around multiword arguments, flag ordering issues, escaping problems
- Safe modification: Add test cases for edge cases before modifying, use established CLI library if complexity grows
- Test coverage: No unit tests for argument parsing

**State file frontmatter parsing:**
- Files: `.opencode/get-shit-done/bin/lib/frontmatter.cjs` (336 lines), `.opencode/get-shit-done/bin/lib/state.cjs` (1031 lines)
- Why fragile: YAML-like frontmatter with custom parsing logic, sensitive to whitespace and formatting
- Common failures: Malformed frontmatter breaks all state operations, encoding issues with special characters
- Safe modification: Add validation before write operations, preserve original formatting on updates
- Test coverage: Minimal validation tests

**Sub-repo detection logic:**
- Files: `.opencode/get-shit-done/bin/lib/core.cjs` (`findProjectRoot` function, lines 54-100+)
- Why fragile: Walks directory tree checking for `.git` and `.planning` with multiple heuristics
- Common failures: Nested workspaces confuse detection, symlinks break path resolution
- Safe modification: Test with complex workspace structures (monorepos, nested git repos)
- Test coverage: Tested implicitly through usage, no isolated unit tests

## Scaling Limits

**Single config file for all settings:**
- Current capacity: Works for 1-5 workstreams, ~100 phases
- Limit: Config file becomes unwieldy with 10+ workstreams or 500+ phases
- Symptoms at limit: Slow config reads, merge conflicts in team environments
- Scaling path: Split config by workstream (`config.workstream-name.json`), archive old phases

**In-memory roadmap parsing:**
- Current capacity: ~100 phases before noticeable slowdown
- Limit: JavaScript string operations on large markdown files
- Symptoms at limit: Phase operations take seconds instead of milliseconds
- Scaling path: Use SQLite or JSON index for phase metadata, lazy-load roadmap sections

## Dependencies at Risk

**@opencode-ai/plugin dependency:**
- Risk: Tightly coupled to specific plugin version (1.3.0), breaking changes possible
- Files: `.opencode/package.json`
- Impact: Plugin API changes could break agent integration
- Migration plan: Abstract plugin calls behind adapter layer, pin major version

**Node.js CommonJS modules:**
- Risk: Ecosystem shifting toward ES modules, `.cjs` extension may become legacy
- Files: All `.opencode/get-shit-done/bin/**/*.cjs` files
- Impact: Future Node.js versions may deprecate CommonJS
- Migration plan: Plan migration to ES modules with `.mjs` or TypeScript

## Missing Critical Features

**No automated rollback mechanism:**
- Problem: Failed phase operations leave partial state (e.g., renamed but not committed)
- Current workaround: Manual git reset to recover
- Blocks: Safe experimentation, atomic phase operations
- Implementation complexity: Medium (transaction-style state management with rollback)

**No workflow versioning or changelog:**
- Problem: Workflow changes tracked only in git history, no user-facing changelog
- Current workaround: Check git log for `.opencode/get-shit-done/workflows/`
- Blocks: Users unaware of new workflow capabilities or breaking changes
- Implementation complexity: Low (generate CHANGELOG.md from git tags)

**Limited parallelization for verification:**
- Problem: Verification workflows run sequentially across phases
- Current workaround: Manual parallel execution of multiple workflows
- Blocks: Fast feedback on large projects with many phases
- Implementation complexity: Medium (add worker pool for parallel verification)

## Test Coverage Gaps

**Core utility functions:**
- What's not tested: `findProjectRoot`, `parseNamedArgs`, `detectSubRepos`, state file parsing
- Files: `.opencode/get-shit-done/bin/lib/core.cjs`, `.opencode/get-shit-done/bin/lib/frontmatter.cjs`
- Risk: Regression bugs in foundational utilities affect all workflows
- Priority: High
- Difficulty to test: Requires complex filesystem mocking, git repo setup

**Workflow execution paths:**
- What's not tested: End-to-end workflow runs (initialize → execute → verify → complete)
- Files: `.opencode/get-shit-done/workflows/*.md` (57 workflow files)
- Risk: Workflow logic errors only caught during actual usage
- Priority: High
- Difficulty to test: Need mock agent environment, simulated subagent responses

**Edge cases in phase arithmetic:**
- What's not tested: Decimal phase calculations at boundaries, renumbering cascades
- Files: `.opencode/get-shit-done/bin/lib/phase.cjs`
- Risk: Incorrect phase numbering corrupts roadmap structure
- Priority: Medium
- Difficulty to test: Need representative roadmap samples with complex phase trees

**Config migration paths:**
- What's not tested: Upgrading from older config formats to current schema
- Files: `.opencode/get-shit-done/bin/lib/config.cjs`
- Risk: Users upgrading versions experience config corruption
- Priority: Low
- Difficulty to test: Need historical config samples from previous versions

---

*Concerns audit: 2026-03-27*
*Update as issues are fixed or new ones discovered*
