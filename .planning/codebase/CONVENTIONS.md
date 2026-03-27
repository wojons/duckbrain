# Coding Conventions

**Analysis Date:** 2026-03-27

## Naming Patterns

**Files:**
- kebab-case for all files (e.g., `gsd-prompt-guard.js`, `codebase-mapper.md`)
- Markdown files for agent definitions and workflows (`.md`)
- JavaScript files for hooks and CLI tools (`.js`, `.cjs`)
- Test files: Not detected in codebase (testing done externally)

**Functions:**
- camelCase for all functions (e.g., `findProjectRoot`, `buildNewProjectConfig`)
- Predicate functions use `is` prefix (e.g., `isValidConfigKey`, `isGitIgnored`)
- Handler functions: Not detected (event-driven patterns use different naming)

**Variables:**
- camelCase for variables (e.g., `stdinTimeout`, `userChoices`)
- UPPER_SNAKE_CASE for constants (e.g., `INJECTION_PATTERNS`, `VALID_CONFIG_KEYS`, `WARNING_THRESHOLD`)
- No underscore prefix for private members (JS convention relies on module scope)

**Types:**
- PascalCase for classes (limited class usage in this JS codebase)
- Type definitions minimal — primarily vanilla JavaScript with JSDoc types

## Code Style

**Formatting:**
- No Prettier config detected
- 2-space indentation throughout
- Single quotes for strings in JS files
- Semicolons required (consistent usage in all `.cjs` and `.js` files)
- Line length: ~100 characters (observed average)

**Linting:**
- No ESLint config detected
- Code quality enforced through manual review

## Import Organization

**Order:**
1. Built-in Node.js modules (`fs`, `path`, `os`, `child_process`)
2. Local relative imports (`.cjs` modules)
3. No external package imports (self-contained CLI tooling)

**Grouping:**
- Blank line between built-in and local imports
- Alphabetical within groups (observed pattern)

**Module System:**
- CommonJS exclusively (`require()`, `module.exports`)
- No ES modules detected

**Path Aliases:**
- None detected — all imports use relative paths

## Error Handling

**Patterns:**
- Try/catch blocks around file system and JSON operations
- Silent failure pattern for non-critical operations (e.g., hooks exit gracefully)
- Guard clauses at function entry for validation

**Error Types:**
- Custom error messages with context
- Return error objects with `safe`, `error` fields in security module
- Hook failures never block execution (exit silently on errors)

**Example from `.opencode/hooks/gsd-prompt-guard.js`:**
```javascript
try {
  const data = JSON.parse(input);
  const toolName = data.tool_name;
  // ... processing
} catch {
  // Silent fail — never block tool execution
  process.exit(0);
}
```

**Validation:**
- Input validation at function boundaries
- Early returns for invalid states
- Security module validates paths, rejects traversal attempts

## Logging

**Framework:**
- No dedicated logging framework
- `console.log` avoided in production hooks
- Hook output via `process.stdout.write(JSON.stringify(output))`

**Patterns:**
- Structured output for hooks (JSON format)
- Advisory messages via `additionalContext` field
- Silent failures for non-critical errors

## Comments

**When to Comment:**
- Header comments explain file purpose and version
- Inline comments explain *why*, not *what*
- Section separators with unicode (e.g., `// ─── Path helpers ─────────────────`)

**JSDoc/TSDoc:**
- JSDoc used for public functions in `.cjs` files
- `@param`, `@returns`, `@throws` tags documented
- Example from `.opencode/get-shit-done/bin/lib/security.cjs`:
```javascript
/**
 * Validate that a file path resolves within an allowed base directory.
 * Prevents path traversal attacks via ../ sequences, symlinks, or absolute paths.
 *
 * @param {string} filePath - The user-supplied file path
 * @param {string} baseDir - The allowed base directory (e.g., project root)
 * @param {object} [opts] - Options
 * @param {boolean} [opts.allowAbsolute=false] - Allow absolute paths
 * @returns {{ safe: boolean, resolved: string, error?: string }}
 */
```

**TODO Comments:**
- Format: `// TODO: description` (observed in node_modules)
- No username tracking

## Function Design

**Size:**
- Functions range from 20-150 lines
- Helper functions extracted for complex logic
- Single responsibility per function

**Parameters:**
- 1-3 parameters typical
- Options object pattern for 4+ parameters
- Default values specified in destructuring

**Return Values:**
- Explicit return statements
- Early returns for guard clauses
- Structured return objects for complex results

## Module Design

**Exports:**
- `module.exports` with named exports object
- All public functions exported from `.cjs` files
- Example from `.opencode/get-shit-done/bin/lib/core.cjs`:
```javascript
module.exports = {
  output,
  error,
  safeReadFile,
  loadConfig,
  isGitIgnored,
  // ...
};
```

**Barrel Files:**
- Not used — direct imports from `.cjs` files
- `index.js` pattern not detected

**Hook Version Headers:**
- All hooks include version header for update tracking:
```javascript
// gsd-hook-version: 1.30.0
```

---

*Convention analysis: 2026-03-27*
*Update when patterns change*
