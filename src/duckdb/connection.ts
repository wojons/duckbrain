/**
 * DuckDB Connection Management
 *
 * Manages DuckDB connections for memory queries.
 * Supports singleton, pool, and per-query modes.
 */

import { Database } from "duckdb";

export { Database };
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { loadVSSExtension, enablePersistence } from "./vss";
import { isPidAlive } from "../utils/pidfile";

/**
 * Cache of database connections by namespace path.
 * Each entry tracks creation time for lifecycle management.
 */
interface ConnectionEntry {
  db: Database;
  dbPath: string;
  createdAt: number;
}
const dbCache = new Map<string, ConnectionEntry>();

// A Database instance otherwise creates a worker pool sized for the host.
// DuckBrain caches one instance per namespace, so that default multiplies
// into hundreds of threads in the long-lived MCP server.
const DATABASE_CONFIG = { threads: "1" };

/**
 * Maximum age of a cached connection before it's recycled (1 hour).
 * Prevents thread accumulation from long-lived DuckDB connections.
 * DuckDB Node.js bindings have been observed to leak threads on
 * long-running instances (1,359 threads after 18 days). Recycling
 * connections periodically ensures the native binding releases resources.
 */
const CONNECTION_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Initialize DuckDB database with VSS extension
 *
 * @param dbPath - Path to database file or ':memory:' for in-memory
 * @returns Promise resolving to Database instance
 *
 * @example
 * const db = await initDuckDB(':memory:');
 * const db = await initDuckDB('./data/duckdb.db');
 */
export async function initDuckDB(
  dbPath: string = ":memory:",
): Promise<Database> {
  // Runtime version check - 1.3.3 has known bugs
  const pkgPath = path.join(
    __dirname,
    "../../node_modules/duckdb/package.json",
  );
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    if (pkg.version === "1.3.3") {
      throw new Error(
        "DuckDB version 1.3.3 has known bugs. Please upgrade to 1.4.4 or later.",
      );
    }
  }

  // Create database instance
  const db = new Database(dbPath, DATABASE_CONFIG);

  // Load VSS extension
  await loadVSSExtension(db);

  // Enable persistence for VSS indexes
  await enablePersistence(db);

  return db;
}

/**
 * Get or create DuckDB connection for a namespace
 *
 * @param mode - Connection mode:
 *   - 'singleton': Returns cached connection per namespace (default)
 *   - 'pool': Returns connection from pool (for concurrent HTTP)
 *   - 'per-query': Creates new connection (simple, for testing)
 * @param namespacePath - Namespace identifier or path
 * @returns DuckDB Database instance
 */
export function getDuckDBConnection(
  mode: "singleton" | "pool" | "per-query" = "singleton",
  namespacePath: string,
): Database {
  switch (mode) {
    case "singleton":
      return getSingletonConnection(namespacePath);

    case "pool":
      // For now, treat pool same as singleton
      // Future: implement actual connection pooling
      return getSingletonConnection(namespacePath);

    case "per-query":
      // Create new connection each time (for testing)
      const dbPath = namespacePath.startsWith(":memory:")
        ? namespacePath
        : path.join(namespacePath, "duckdb.db");
      return new Database(dbPath, DATABASE_CONFIG);

    default:
      throw new Error(`Unknown connection mode: ${mode}`);
  }
}

/**
 * Per-process scratch file for singleton connections (GAP-001).
 *
 * The singleton only ever READS external data (read_json over partition
 * JSONL files); its backing database file is an empty query container.
 * Sharing one file per namespace across processes meant the first process
 * to open it held DuckDB's exclusive single-writer lock, and every other
 * process (http daemon, fleet stdio MCP servers) got a silently-broken
 * connection (DUCKDB_CONNECTION_LOST) — cross-namespace reads were
 * impossible while any other process had the namespace open.
 *
 * Opening a per-process scratch file in os.tmpdir() removes the sharing
 * entirely: no cross-process lock contention with old OR new code, and the
 * namespace directory is never opened, created, or locked by readers.
 * The counter gives each recycled connection a fresh path so the old
 * file can be unlinked the moment its close completes.
 */
let scratchFileCounter = 0;
function singletonDbPath(namespacePath: string): string {
  const hash = crypto
    .createHash("sha1")
    .update(namespacePath)
    .digest("hex")
    .slice(0, 12);
  return path.join(
    os.tmpdir(),
    `duckbrain-${process.pid}-${hash}-${scratchFileCounter++}.db`,
  );
}

/**
 * Close a cached entry and remove its scratch file (best-effort).
 */
function closeEntry(entry: ConnectionEntry, onClosed?: () => void): void {
  entry.db.close(() => {
    // Fire-and-forget unlink — the scratch file is a disposable container;
    // ignore errors (file may never have been materialized on disk).
    fs.unlink(entry.dbPath, () => {});
    onClosed?.();
  });
}

/**
 * Best-effort cleanup of THIS process's scratch files in the temp directory.
 *
 * Only deletes files matching `duckbrain-<current-pid>-*.db` so live scratch
 * files belonging to other processes (e.g. a fleet stdio MCP server or an
 * http daemon) are never touched. Called explicitly by tests and registered
 * once as a process-exit handler.
 */
export function cleanupProcessScratchFiles(tmpDir = os.tmpdir()): void {
  try {
    const prefix = `duckbrain-${process.pid}-`;
    const files = fs.readdirSync(tmpDir);
    for (const file of files) {
      if (file.startsWith(prefix) && file.endsWith(".db")) {
        fs.unlinkSync(path.join(tmpDir, file));
      }
    }
  } catch {
    // Fire-and-forget: temp dir may be unreachable or a file may be busy.
  }
}

/**
 * Scratch file name shape: `duckbrain-<pid>-<hash>-<counter>.db`.
 * The embedded pid is the process that created the file.
 */
const SCRATCH_FILE_PATTERN = /^duckbrain-(\d+)-.+\.db$/;

/**
 * Orphan sweep (DOGFOOD-016): remove scratch db files whose creating
 * process is no longer alive.
 *
 * The exit handler and signal handlers can only clean up files of THIS
 * process; a process that died without any cleanup (SIGKILL, a native
 * duckdb abort, a killed VM) leaves its `duckbrain-<pid>-*.db` files in
 * the temp directory forever — 2500+ accumulated in the Aug 7-9 crash
 * era. Every process that opens scratch connections sweeps once at
 * startup: files whose embedded pid is dead are garbage and are unlinked;
 * files whose pid is ALIVE are left untouched (another fleet process may
 * be mid-use). Best-effort and tolerant of a missing/unreadable temp dir.
 *
 * @param tmpDir Directory to sweep (os.tmpdir() by default; overridable for tests)
 * @returns Number of orphaned files removed
 */
export function sweepOrphanScratchFiles(tmpDir = os.tmpdir()): number {
  let removed = 0;
  try {
    const files = fs.readdirSync(tmpDir);
    for (const file of files) {
      const match = SCRATCH_FILE_PATTERN.exec(file);
      if (!match) continue;
      const pid = Number.parseInt(match[1], 10);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (isPidAlive(pid)) continue; // live process may be mid-use
      try {
        fs.unlinkSync(path.join(tmpDir, file));
        removed += 1;
      } catch {
        // Best-effort — the file may be busy or already gone.
      }
    }
  } catch {
    // Fire-and-forget: temp dir may be unreachable.
  }
  return removed;
}

let orphanSweepDone = false;

/**
 * Run the orphan sweep exactly once per process, on first connection setup.
 *
 * Deliberately lazy (not module-init): modules that merely import
 * connection.ts without ever opening a scratch file should not pay for a
 * readdir of the temp directory, and the sweep must run only after the
 * process is fully booted so a concurrently-starting sibling (whose pid is
 * alive) is never mistaken for an orphan.
 */
function sweepOrphansOnce(): void {
  if (orphanSweepDone) return;
  orphanSweepDone = true;
  try {
    const removed = sweepOrphanScratchFiles();
    if (removed > 0) {
      console.error(
        `[duckbrain] Removed ${removed} orphaned scratch db file(s) from ${os.tmpdir()}`,
      );
    }
  } catch {
    // Fire-and-forget — a sweep failure must never break connections.
  }
}

/**
 * Cleanup on fatal signals (DOGFOOD-016).
 *
 * The `exit` event does not fire when a process is killed by SIGTERM /
 * SIGINT / SIGHUP, nor on SIGKILL / native aborts — which is exactly how
 * the Aug 7-9 scratch-file leak happened. For the catchable signals,
 * run the same per-process cleanup as the exit handler, then restore the
 * default disposition and re-deliver the signal so the process dies with
 * its normal signal semantics (correct exit status, no swallowed signal).
 */
function onScratchCleanupSignal(signal: NodeJS.Signals): void {
  cleanupProcessScratchFiles();
  // Restore default disposition for this signal, then re-deliver it.
  process.removeListener(signal, onScratchCleanupSignal);
  process.kill(process.pid, signal);
}

let scratchSignalCleanupRegistered = false;

/**
 * Register SIGTERM/SIGINT/SIGHUP scratch-file cleanup handlers.
 *
 * Idempotent — safe to call from anywhere, and registered once at module
 * scope so every process importing connection.ts (CLI, http daemon, stdio
 * MCP server) gets crash-signal cleanup for free. Exported so tests can
 * re-invoke it in a child process.
 */
export function registerScratchSignalCleanup(): void {
  if (scratchSignalCleanupRegistered) return;
  scratchSignalCleanupRegistered = true;
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, onScratchCleanupSignal);
  }
}

let scratchCleanupRegistered = false;
if (!scratchCleanupRegistered) {
  scratchCleanupRegistered = true;
  process.on("exit", () => cleanupProcessScratchFiles());
  registerScratchSignalCleanup();
}

/**
 * Get or create singleton connection for namespace.
 *
 * Uses a file-backed database instead of :memory: to avoid
 * Napi::Error corruption from repeated read_json() calls across different
 * file sets. DuckDB's in-memory mode accumulates internal state from
 * table-function operations across multiple file lists; file-backed mode
 * properly releases resources between operations.
 *
 * The file lives in os.tmpdir() (one per process + namespace, see
 * singletonDbPath) — NOT at <namespace>/duckdb.db — so concurrent readers
 * in other processes never contend on DuckDB's single-writer file lock.
 *
 * VSS extensions are NOT loaded — they were previously found to cause
 * additional Napi::Error crashes with read_json() + column filters.
 * Semantic search (VSS) will need a fresh connection with extensions
 * loaded when the embedding stub is replaced with a real model.
 */
function getSingletonConnection(namespacePath: string): Database {
  // One-time orphan sweep on first connection setup (DOGFOOD-016): reclaim
  // scratch db files left by processes that died without cleanup.
  sweepOrphansOnce();

  const existing = dbCache.get(namespacePath);

  // Recycle connection if it exceeds max age (prevents thread accumulation)
  if (existing) {
    const age = Date.now() - existing.createdAt;
    if (age >= CONNECTION_MAX_AGE_MS) {
      closeEntry(existing);
      dbCache.delete(namespacePath);
    } else {
      return existing.db;
    }
  }

  // Create fresh connection on a per-process scratch file (GAP-001)
  const dbPath = singletonDbPath(namespacePath);
  const db = new Database(dbPath, DATABASE_CONFIG);
  dbCache.set(namespacePath, { db, dbPath, createdAt: Date.now() });

  return db;
}

/**
 * Evict a cached connection for a namespace — typically called after a
 * connection error so the next call to getSingletonConnection creates a
 * fresh Database instance.
 *
 * @param namespacePath - Path to namespace directory
 */
export function evictConnection(namespacePath: string): void {
  const entry = dbCache.get(namespacePath);
  if (entry) {
    closeEntry(entry);
    dbCache.delete(namespacePath);
  }
}

/**
 * Close DuckDB connection cleanly
 *
 * @param db - Database instance to close
 * @returns Promise that resolves when closed
 *
 * @example
 * await closeDuckDB(db);
 */
export async function closeDuckDB(db: Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Close and clear cached connection
 *
 * @param namespacePath - Path to namespace directory
 */
export async function closeDuckDBConnection(
  namespacePath: string,
): Promise<void> {
  const entry = dbCache.get(namespacePath);
  if (entry) {
    await closeDuckDB(entry.db);
    fs.unlink(entry.dbPath, () => {});
    dbCache.delete(namespacePath);
  }
}

/**
 * Clear all cached connections
 */
export async function closeAllConnections(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const entry of dbCache.values()) {
    promises.push(new Promise((resolve) => closeEntry(entry, resolve)));
  }
  await Promise.all(promises);
  dbCache.clear();
}

/**
 * Get the age of a cached connection or null if not cached.
 * Useful for monitoring and debugging thread accumulation.
 *
 * @param namespacePath - Path to namespace directory
 * @returns Age in ms or null
 */
export function getConnectionAge(namespacePath: string): number | null {
  const entry = dbCache.get(namespacePath);
  if (!entry) return null;
  return Date.now() - entry.createdAt;
}

/**
 * Get the number of cached connections.
 * Useful for monitoring connection accumulation.
 */
export function getConnectionCount(): number {
  return dbCache.size;
}
