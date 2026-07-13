/**
 * DuckDB Connection Management
 *
 * Manages DuckDB connections for memory queries.
 * Supports singleton, pool, and per-query modes.
 */

import { Database } from 'duckdb';

export { Database };
import path from 'path';
import fs from 'fs';
import { loadVSSExtension, enablePersistence } from './vss';

/**
 * Cache of database connections by namespace path.
 * Each entry tracks creation time for lifecycle management.
 */
interface ConnectionEntry {
  db: Database;
  createdAt: number;
}
const dbCache = new Map<string, ConnectionEntry>();

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
export async function initDuckDB(dbPath: string = ':memory:'): Promise<Database> {
  // Runtime version check - 1.3.3 has known bugs
  const pkgPath = path.join(__dirname, '../../node_modules/duckdb/package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (pkg.version === '1.3.3') {
      throw new Error(
        'DuckDB version 1.3.3 has known bugs. Please upgrade to 1.4.4 or later.'
      );
    }
  }

  // Create database instance
  const db = new Database(dbPath);

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
  mode: 'singleton' | 'pool' | 'per-query' = 'singleton',
  namespacePath: string
): Database {
  switch (mode) {
    case 'singleton':
      return getSingletonConnection(namespacePath);

    case 'pool':
      // For now, treat pool same as singleton
      // Future: implement actual connection pooling
      return getSingletonConnection(namespacePath);

    case 'per-query':
      // Create new connection each time (for testing)
      const dbPath = namespacePath.startsWith(':memory:')
        ? namespacePath
        : path.join(namespacePath, 'duckdb.db');
      return new Database(dbPath);

    default:
      throw new Error(`Unknown connection mode: ${mode}`);
  }
}

/**
 * Get or create singleton connection for namespace.
 *
 * Uses file-backed database (duckdb.db) instead of :memory: to avoid
 * Napi::Error corruption from repeated read_json() calls across different
 * file sets. DuckDB's in-memory mode accumulates internal state from
 * table-function operations across multiple file lists; file-backed mode
 * properly releases resources between operations.
 *
 * VSS extensions are NOT loaded — they were previously found to cause
 * additional Napi::Error crashes with read_json() + column filters.
 * Semantic search (VSS) will need a fresh connection with extensions
 * loaded when the embedding stub is replaced with a real model.
 */
function getSingletonConnection(namespacePath: string): Database {
  const existing = dbCache.get(namespacePath);

  // Recycle connection if it exceeds max age (prevents thread accumulation)
  if (existing) {
    const age = Date.now() - existing.createdAt;
    if (age >= CONNECTION_MAX_AGE_MS) {
      existing.db.close(() => {
        // Fire-and-forget close — ignore errors on already-closed connections
      });
      dbCache.delete(namespacePath);
    } else {
      return existing.db;
    }
  }

  // Create fresh connection
  const dbPath = path.join(namespacePath, 'duckdb.db');
  const db = new Database(dbPath);
  dbCache.set(namespacePath, { db, createdAt: Date.now() });

  return db;
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
export async function closeDuckDBConnection(namespacePath: string): Promise<void> {
  const entry = dbCache.get(namespacePath);
  if (entry) {
    await closeDuckDB(entry.db);
    dbCache.delete(namespacePath);
  }
}

/**
 * Clear all cached connections
 */
export async function closeAllConnections(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const entry of dbCache.values()) {
    promises.push(
      new Promise((resolve) => {
        entry.db.close(() => resolve());
      })
    );
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
