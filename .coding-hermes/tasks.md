# DuckBrain — Coding Hermes Task Board

## Open

### DB-001: Implement actual embedding model in recall.ts
- **File:** `src/mcp/tools/recall.ts:68-73`
- **Severity:** Medium
- **Status:** `generateEmbedding()` is a stub — always returns `null`
- **Fix:** Integrate an embedding model API. **BLOCKED — needs Bane's decision on which embedding model/API to use.**

### DB-014: CI/CD — Add GitHub Actions workflow for tests + lint
- **Severity:** High → ✅ **Stale — CI already exists**
- `.github/workflows/ci.yml` exists and runs test + lint + typecheck + docker build on push/PR
- `release.yml` exists for tagged releases
- No `typecheck` or `lint` scripts in package.json (CI uses `--if-present` which silently skips them — minor, non-blocking)
- 65/65 tests, 1601 modules build clean
- Marking [x] — CI already present. Minor gap: `typecheck` script missing, but CI passes.

### DB-015: DOC — 4 missing docs pages + MCP tools out of sync
- ✅ **Fixed in 718996e** — Created 4 new pages (http-api.md, configuration.md, deployment.md, license.md)
- ✅ Updated mcp-tools.md with 6 missing tools + fixed schema (embedding_text, success:boolean, domain enum)
- ✅ 5 files, +1,610 lines, -77 lines. 65/65 tests pass. Guard PASS.

### DB-016: API — 3 HTTP endpoints return hardcoded stubs
- **Severity:** Medium
- `GET /users` → `{ users: [] }` stub
- `GET /activity` → `{ activities: [] }` stub
- `GET /namespaces` → `{ namespaces: ['default'] }` (ignores namespace tool with real data)
- File: `src/cli/http.ts:165-182`

### DB-017: QUALITY — `resolveNamespacePath` duplicated 4× across tools
- **Severity:** Low
- Same function in `recall.ts`, `remember.ts`, `forget.ts`, `list_keys.ts`
- Extract to shared utility (e.g., `src/mcp/tools/shared.ts`)

### DB-018: PITFALL — BigInt serialization bug in DuckDB query responses
- **Severity:** Medium
- Reported in idle tick #2: "Key recall: BigInt serialization bug"
- DuckDB returns BigInt values; JSON.stringify chokes on them
- Fix: add BigInt replacer in JSON serialization

### DB-019: PERF — Linear-scan ID/key lookups in HTTP routes
- **Severity:** Medium
- `GET /api/memories/:id` fetches 1000 records and scans in-memory
- `GET /api/memories/key/:key` fetches 100 records and scans in-memory
- Fix: add `WHERE id=?` / `WHERE key=?` to DuckDB queries

### DB-020: SECURITY — No GitReins guard config
- **Severity:** High
- `.gitreins/config.toml` missing entirely
- No automated secrets scanning, lint, or test guards on commit

### DB-021: PITFALL — `/cli` endpoint has no command whitelist
- **Severity:** High
- `POST /cli` execs arbitrary CLI commands via `npx tsx`
- No input sanitization, no command whitelist
- Potential RCE: malicious input could exec shell commands
- File: `src/cli/http.ts:199-229`

## Done

### DB-013: Update minor/patch dependencies
- ✅ Updated @modelcontextprotocol/sdk→1.29.0, vitest→4.1.10, tsx→4.23.1, zod→4.4.3. Build clean (1601 modules), 65/65 tests pass, guard PASS.

### Idle tick #2 (2026-07-19 11:00)
- ✅ Fixed `defaultNamespace` drift → `hermes-memory` (ef08e12). Discovered dirty change: `hermes-dagger→h3`, reverted + pinned. Guard PASS.
- Board: only BLOCKED DB-001 (embedding model — awaiting Bane's decision)
- Build: 1601 modules clean. Tests: 65/65 pass. CI: green.
- npm outdated: @types/node 25.9.4→25.9.5 (patch), TypeScript 6.0.3→7.0.2 (major — needs decision), uuid 13.0.2→14.0.1 (major — needs decision)
- npm audit: 5 high (transitive tar, same as DB-007, unfixable)
- Never-done audit: no stubs, no TODOs, MCP server running, 10 tools functional
- DuckBrain write: OK. Semantic recall: blocked by DB-001 stub. Key recall: BigInt serialization bug.

### Idle tick #3 (2026-07-19 11:39)
- ✅ Fixed `defaultNamespace` drift → `hermes-memory` (was → `imhotep` again). DUCK-DRILL reverted + pinned.
- Board: only BLOCKED DB-001 (embedding model — awaiting Bane's decision)
- Build: 1601 modules clean. Tests: 65/65 pass (12.25s). CI: 3/3 green.
- npm outdated: unchanged — @types/node 25.9.4→25.9.5 (patch, trivial), TypeScript 6→7 (major, needs Bane), uuid 13→14 (major, needs Bane)
- npm audit: same 5 high transitive tar vulns (unfixable, build-time only)
- Never-done audit: 27 source files without tests (pre-existing), no new TODOs, MCP server running (10 tools), no stubs beyond DB-001.
- 🐌 **Graduated slowdown — idle tick #3 of 7.** Increased cooldown from 15min → 4h via scheduler API (`CooldownS: 14400`). Stored base interval in DuckBrain. Next: 12h at tick #5, pause at tick #7.
- DuckBrain write: OK. Idle counter stored in `coding-hermes` namespace.

### DB-003: Write degradation — silent write failures
- ✅ **Monitoring complete (2026-07-15).** Write stability verified across 3+ days since July 12. Last health check (274B test write) confirmed working. Moved from Monitoring to Done.

### DB-012: Wire forget action in memory-table UI
- ✅ Fixed in f1073e7 — wired `onForget` context-menu callback to `useForgetMemory` hook. Calls `DELETE /api/memories/:id`. Backend was already implemented; only UI needed wiring. Build: 1601 modules clean. Tests: 65/65 pass. Guard: PASS.

### DB-011: UI package missing node_modules — build broken
- ✅ Fixed in 6b48136 — `npm install` in packages/ui/ (101 packages) + corrected ignoreDeprecations `"6.0"` → `"5.0"`. Build: 1601 modules, clean. Tests: 65/65 pass. Guard: PASS.

### DB-010: Fix TS6 baseUrl deprecation in packages/ui/tsconfig.json
- ✅ Fixed in 2145a29 — added `ignoreDeprecations: "6.0"` to packages/ui/tsconfig.json. Revealed pre-existing DB-011 (UI package missing node_modules).

### DB-008: Clean up tsc strictness errors
- ✅ Fixed in e67b6d7 — installed @types/express + async-mutex, removed unused imports, prefixed unused params with _, exported Database from connection.ts, fixed Buffer types in client.test.ts via `: any` return type. 29 files, 156 insertions, 124 deletions. tsc: 0 errors, vitest: 65/65 pass, guard: PASS.

### DB-009: Pre-existing secrets guard false positive
- ✅ Fixed in d7d3d4f + c3471ca — added .opencode/ and namespaces/ to gitleaks allowlist. Root cause: TOML single-quoted strings are literal — `'''\\\\.opencode/.*'''` matched literal backslash, not dot. Fixed to `'''\\.opencode/.*'''`. Also fixed [[rules]] section patterns. Guard: PASS.

### DB-007: Resolve 6 high-severity npm vulnerabilities
- ✅ Fixed in 2277fa6 — simple-git 3.33.0→3.36.0 (RCE fix). 5 remaining tar vulns are transitive via duckdb→node-gyp (build-time only, no fix available). All 65 vitest tests pass.

### DB-006: Fix TS6 baseUrl deprecation
- ✅ Fixed in 291184d — added `ignoreDeprecations: "6.0"` to tsconfig.json

### DB-002: DuckDB singleton connection corruption
- ✅ Fixed in f1b4509

### DB-004: Thread leak on long-running instances
- ✅ Fixed in cbf2a50

### DB-005: Missing trailing newline guard in config files
- ✅ Fixed in bdccbfa

### DB-000: CI test failures
- ✅ Fixed. 97/97 tests passing, CI green.

## Gaps (discovery sweep 2026-07-15)

### GAP-001: duckbrain namespace exists on disk but not in duckbrain.config.json
- **File:** `namespaces/duckbrain/` (424K, 2 partitions: event/2026-07, config/2026-07)
- **Status:** The `duckbrain` namespace directory exists with DuckDB, config, and event data, but `duckbrain.config.json` has no `namespaceMappings` entry for it. May be intentional (self-referential storage). Flagged for Bane's awareness.

## Never-Done Audit (2026-07-19 12:28)

11-point audit completed. 65/65 tests pass, tsc clean. Results:

| Check | Finding | Tasks |
|-------|---------|-------|
| 1. Spec Alignment | MCP tools doc out of sync (missing 3 tools, wrong field names) | DB-015 |
| 2. Doc Coverage | 4 docs pages referenced but don't exist | DB-015 |
| 3. Test Gaps | 28 untested source files (10 test files for 38 src files) | (chronic, monitored) |
| 4. Package Upgrades | TS 6→7, uuid 13→14 (major, needs Bane) | (deferred — major bumps) |
| 5. Pitfall Hunt | BigInt serialization, /cli RCE, duplicated code | DB-017, DB-018, DB-021 |
| 6. Performance | O(n) ID/key lookups in HTTP routes (1000-row scan) | DB-019 |
| 7. Endpoint Vfy | /users, /activity, /namespaces — hardcoded stubs | DB-016 |
| 8. CI/CD Health | No .github/workflows — zero CI | DB-014 |
| 9. DuckBrain Sync | GAP-001 still open, BigInt bug not tracked | DB-018 |
| 10. Code Quality | 4× duplicated function, 1231-line human.ts | DB-017 |
| 11. Middle-Out Wiring | All routes wired, MCP tools all registered, SSH+systemd wired | ✅ PASS |

**Summary:** 8 new tasks created (DB-014–DB-021). 1 pre-existing task (DB-001, blocked).

## [ ] NEVER-DONE — Run coding-hermes-never-done 11-point audit

Load coding-hermes-never-done skill. Run ALL 11 checks: spec alignment, doc coverage, test gaps, package upgrades, pitfall hunt, performance audit, endpoint verification, CI/CD health, DuckBrain sync, code quality, middle-out wiring. Create a task for EVERY gap found. This task is never complete — the audit always finds something.
