---
phase: 01
slug: core-mvp
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-27
---

# Phase 01 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node.js native assertions (no dedicated test framework detected) |
| **Config file** | none — Wave 0 installs |
| **Quick run command** | `node test/run-tests.js` |
| **Full suite command** | `node test/run-tests.js --full` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `node test/run-tests.js {test_file}`
- **After every plan wave:** Run `node test/run-tests.js --full`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | SCHEMA-01 | unit | `node test/schema/memory.test.js` | ❌ W0 | ⬜ pending |
| 01-01-02 | 01 | 1 | SCHEMA-02 | unit | `node test/schema/memory.test.js` | ❌ W0 | ⬜ pending |
| 01-01-03 | 01 | 1 | STORAGE-01 | integration | `node test/storage/jsonl.test.js` | ❌ W0 | ⬜ pending |
| 01-01-04 | 01 | 1 | STORAGE-02 | integration | `node test/storage/manifest.test.js` | ❌ W0 | ⬜ pending |
| 02-01-01 | 02 | 2 | STORAGE-03 | integration | `node test/duckdb/connection.test.js` | ❌ W0 | ⬜ pending |
| 02-01-02 | 02 | 2 | CORE-01 | unit | `node test/tools/remember.test.js` | ❌ W0 | ⬜ pending |
| 02-01-03 | 02 | 2 | CORE-04 | unit | `node test/tools/forget.test.js` | ❌ W0 | ⬜ pending |
| 03-01-01 | 03 | 2 | CORE-02 | unit | `node test/tools/recall.test.js` | ❌ W0 | ⬜ pending |
| 03-01-02 | 03 | 2 | CORE-03 | unit | `node test/tools/list_keys.test.js` | ❌ W0 | ⬜ pending |
| 03-01-03 | 03 | 2 | SCHEMA-03 | unit | `node test/schema/zod-validation.test.js` | ❌ W0 | ⬜ pending |
| 04-01-01 | 04 | 3 | CLI-01 | integration | `node test/cli/stdio.test.js` | ❌ W0 | ⬜ pending |
| 04-01-02 | 04 | 3 | CLI-02 | integration | `node test/cli/human.test.js` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/tools/remember.test.js` — stubs for CORE-01
- [ ] `test/tools/recall.test.js` — stubs for CORE-02
- [ ] `test/tools/list_keys.test.js` — stubs for CORE-03
- [ ] `test/tools/forget.test.js` — stubs for CORE-04
- [ ] `test/schema/memory.test.js` — stubs for SCHEMA-01, SCHEMA-02
- [ ] `test/storage/jsonl.test.js` — stubs for STORAGE-01
- [ ] `test/storage/manifest.test.js` — stubs for STORAGE-02
- [ ] `test/duckdb/connection.test.js` — stubs for STORAGE-03
- [ ] `test/cli/stdio.test.js` — stubs for CLI-01
- [ ] `test/cli/human.test.js` — stubs for CLI-02
- [ ] `test/run-tests.js` — test runner script
- [ ] Framework install: None required — using Node.js native assert module

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| MCP stdio mode with local Claude | CLI-01 | Requires Claude Desktop app integration | 1. Configure Claude Desktop with MCP config pointing to duckbrain stdio<br>2. Start Claude Desktop<br>3. Ask Claude to remember something<br>4. Verify JSONL file updated |
| SSH tunneling transparency | CLI-02 (future) | Requires remote server setup | 1. SSH to remote host<br>2. Run `duckbrain stdio` command<br>3. Verify stdin/stdout piped correctly |

*Note: Manual verifications for Phase 1 are minimal — focus on automated tests. SSH tunneling is Phase 3.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
