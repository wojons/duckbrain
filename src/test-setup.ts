/**
 * Vitest global setup — BUG-037 test isolation.
 *
 * Redirects ALL namespace storage (JSONL + DuckDB) to a fresh temp directory
 * so the test suite never touches namespaces/default/duckdb.db — the file the
 * live MCP server holds an exclusive DuckDB write lock on (root cause of the
 * BUG-027 flake: DUCKDB_CONNECTION_LOST when a second process opens the same
 * namespace DB file).
 *
 * This runs BEFORE each test file in the worker process, so process.env is
 * visible to the modules under test (they call getConfig() lazily at request
 * time, which reads process.env via applyEnvOverrides).
 */
import fs from "fs";
import os from "os";
import path from "path";

const TEST_NS_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "duckbrain-test-ns-"),
);

process.env.DUCKBRAIN_NAMESPACES_PATH = TEST_NS_ROOT;

// Ensure the default namespace dir exists so DuckDB file creation works.
fs.mkdirSync(path.join(TEST_NS_ROOT, "default"), { recursive: true });
fs.mkdirSync(path.join(TEST_NS_ROOT, "test-ns"), { recursive: true });
