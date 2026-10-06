# Testing Patterns

**Analysis Date:** 2026-03-27

## Test Framework

**Runner:**
- No test framework configured in codebase
- No Jest, Vitest, Mocha, or similar detected
- No test configuration files (`jest.config.*`, `vitest.config.*`, etc.)

**Assertion Library:**
- Not applicable — no in-codebase testing framework

**Run Commands:**
```bash
# No test scripts detected in package.json
# Testing appears to be performed externally/manual
```

## Test File Organization

**Location:**
- No test files detected in codebase (excluding node_modules)
- No `__tests__/` directories
- No `*.test.*` or `*.spec.*` files in source directories

**Naming:**
- Not applicable — no test files present

**Structure:**
```
.opencode/
  hooks/
    # No test files alongside hooks
  get-shit-done/
    bin/
      lib/
        # No test files alongside source modules
```

## Test Structure

**Suite Organization:**
- Not applicable — no test suites detected

**Patterns:**
- Not applicable

## Mocking

**Framework:**
- Not applicable

**Patterns:**
- Not applicable

**What to Mock:**
- Guidelines not established in codebase

**What NOT to Mock:**
- Guidelines not established in codebase

## Fixtures and Factories

**Test Data:**
- No fixture files detected
- No factory functions detected

**Location:**
- Not applicable

## Coverage

**Requirements:**
- No coverage targets detected
- No coverage configuration in codebase

**Configuration:**
- Not applicable

**View Coverage:**
```bash
# No coverage commands available
```

## Test Types

**Unit Tests:**
- Not present in codebase

**Integration Tests:**
- Not present in codebase

**E2E Tests:**
- Not present in codebase

## External Testing Context

**TDD Documentation:**
- Codebase includes TDD reference documentation at `.opencode/get-shit-done/references/tdd.md`
- TDD patterns documented for future implementation
- Red-Green-Refactor cycle described
- TDD plan structure documented for features with testable behavior

**From `.opencode/get-shit-done/references/tdd.md`:**
```markdown
TDD is about design quality, not coverage metrics. The red-green-refactor cycle
forces you to think about behavior before implementation, producing cleaner
interfaces and more testable code.

Principle: If you can describe the behavior as expect(fn(input)).toBe(output)
before writing fn, TDD improves the result.
```

**TDD Candidates (per documentation):**
- Business logic with defined inputs/outputs
- API endpoints with request/response contracts
- Data transformations, parsing, formatting
- Validation rules and constraints
- Algorithms with testable behavior
- State machines and workflows
- Utility functions with clear specifications

**Skip TDD (per documentation):**
- UI layout, styling, visual components
- Configuration changes
- Glue code connecting existing components
- One-off scripts and migrations
- Simple CRUD with no business logic
- Exploratory prototyping

## Manual Verification Patterns

**Hook Testing:**
- Hooks include graceful degradation (silent failures)
- Hooks exit cleanly on parse errors
- Timeout guards prevent hanging (3-10 second timeouts)

**Example from `.opencode/hooks/gsd-prompt-guard.js`:**
```javascript
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    // ... processing
  } catch {
    // Silent fail — never block tool execution
    process.exit(0);
  }
});
```

**State Validation:**
- Config validation in `.opencode/get-shit-done/bin/lib/config.cjs`
- Path validation in `.opencode/get-shit-done/bin/lib/security.cjs`
- Prompt injection pattern detection in hooks

## Testing Debt

**Current State:**
- Codebase lacks automated test suite
- ~10k lines of production code without unit/integration tests
- Critical paths (security, config, state management) untested
- Hook reliability depends on manual testing

**Recommendations for Future Testing:**
1. Add Vitest or Jest for unit testing `.cjs` modules
2. Test security module path validation logic
3. Test config parsing and migration logic
4. Test hook input/output handling
5. Add integration tests for CLI commands

---

*Testing analysis: 2026-03-27*
*Update when test patterns change*
