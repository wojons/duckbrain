---
status: testing
phase: 01-core-mvp
source: 01-core-mvp-01-SUMMARY.md, 01-core-mvp-02-SUMMARY.md, 01-core-mvp-03-SUMMARY.md, 01-core-mvp-04-SUMMARY.md
started: 2026-03-30T12:00:00Z
updated: 2026-03-31T03:46:00Z
---

## Current Test

number: 6
name: Stdio MCP Mode
expected: Local Claude Desktop can call tools via MCP protocol
result: testing - Opencode MCP integration working

## Tests

### 1. Cold Start Smoke Test
expected: Kill any running server/service. Clear ephemeral state (temp DBs, caches, lock files). Start the application from scratch. Server boots without errors, any seed/migration completes, and a primary query (health check, homepage load, or basic API call) returns live data.
result: pass

### 2. Store Memory
expected: duckbird remember /test/uat/key --domain=raw_note --attr='{"test":"uat-phase-1"}' --embedding-text="UAT test memory" stores a memory and returns confirmation with id, key, partition, and author.
result: pass

### 3. Retrieve Memory by Exact Key
expected: recall() returns single memory by exact key match
result: pass

### 4. Browse Memory Tree
expected: list_keys() explores hierarchical keys with depth limits
result: pass

### 5. Soft-Delete Memory
expected: forget() appends tombstone (never deletes files)
result: pass

### 6. Stdio MCP Mode
expected: Local Claude Desktop can call tools via MCP protocol
result: pass - Opencode integration verified (remember, recall, list_keys all working)

### 7. HTTP MCP Mode
expected: Remote HTTP server with DNS rebinding protection
result: pending

### 8. Human CLI — Remember
expected: duckbrain remember command stores memory
result: pass

### 9. Human CLI — Recall
expected: duckbrain recall command queries memories
result: pass

### 10. Human CLI — List Keys
expected: duckbrain list-keys command browses tree
result: pass

### 11. Human CLI — Forget
expected: duckbrain forget command soft-deletes
result: pending

### 12. Human CLI — Help
expected: duckbrain help shows all commands
result: pass

## Summary

total: 12
passed: 9
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
