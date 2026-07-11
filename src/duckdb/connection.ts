/**
 * DuckDB Connection Management
 *
 * Manages DuckDB connections for memory queries.
 * Supports singleton, pool, and per-query modes.
 */

import duckdb, { Database } from 'duckdb';
import path from 'path';
import fs from 'fs';
import { loadVSSExtension, enablePersistence } from './vss';

/**
 * Cache of database connections by namespace path
 */
const dbCache = new Map<string, Database>();

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
  if (!dbCache.has(namespacePath)) {
    const dbPath = path.join(namespacePath, 'duckdb.db');
    const db = new Database(dbPath);
    dbCache.set(namespacePath, db);
  }

  return dbCache.get(namespacePath)!;
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
  const db = dbCache.get(namespacePath);
  if (db) {
    await closeDuckDB(db);
    dbCache.delete(namespacePath);
  }
}

/**
 * Clear all cached connections
 */
export async function closeAllConnections(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const db of dbCache.values()) {
    promises.push(
      new Promise((resolve) => {
        db.close(() => resolve());
      })
    );
  }
  await Promise.all(promises);
  dbCache.clear();
}
