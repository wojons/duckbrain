/**
 * Vitest global setup — BUG-037 test isolation.
 *
 * Redirects ALL namespace storage (JSONL + DuckDB) to a fresh temp directory
 * so the test suite never touches namespaces/default/duckdb.db — the file the
 * live MCP server holds an exclusive DuckDB write lock on (root cause of the
 * BUG-027 flake: DUCKDB_CONNECTION_LOST when a second process opens the same
 * namespace DB file).
 *
 * GAP-022: also redirects the config FILE (DUCKBRAIN_CONFIG_PATH) to a fresh
 * temp directory. The namespace tools hardcode configDir "." and write via
 * updateConfig()'s atomic tmp+rename — without the redirect, parallel test
 * files race on the tracked duckbrain.config.json at the repo root (a
 * concurrent file's write could land AFTER a sibling's afterEach
 * snapshot-restore, leaking test mappings into the repo config; observed
 * tick #370). Each worker process gets its own mkdtemp dir, so parallel
 * files can never share a config file.
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

const TEST_CONFIG_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "duckbrain-test-cfg-"),
);

process.env.DUCKBRAIN_CONFIG_PATH = path.join(
  TEST_CONFIG_DIR,
  "duckbrain.config.json",
);
