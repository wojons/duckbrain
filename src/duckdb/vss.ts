/**
 * DuckDB VSS Extension Management
 *
 * Handles loading and configuring the VSS (Vector Similarity Search) extension.
 */

import type { Database } from './connection';

/**
 * Load VSS extension into DuckDB database
 *
 * Installs and loads the VSS extension for vector similarity search.
 * Handles gracefully if extension is already installed.
 *
 * @param db - DuckDB Database instance
 * @returns Promise that resolves when extension is loaded
 *
 * @example
 * await loadVSSExtension(db);
 */
export async function loadVSSExtension(db: Database): Promise<void> {
  try {
    // Try to load VSS extension
    db.exec('INSTALL vss');
    db.exec('LOAD vss');
  } catch (error) {
    // Extension may already be installed - check if it's loaded
    try {
      db.exec('LOAD vss');
    } catch (loadError) {
      console.warn('VSS extension could not be loaded:', loadError);
      throw new Error(
        `Failed to load VSS extension: ${loadError instanceof Error ? loadError.message : 'unknown error'}`
      );
    }
  }
}

/**
 * Enable experimental persistence for VSS indexes
 *
 * Per RESEARCH.md "Pitfall 4: VSS Index Persistence", this setting
 * allows HNSW indexes to persist across database sessions.
 *
 * @param db - DuckDB Database instance
 * @returns Promise that resolves when setting is applied
 *
 * @example
 * await enablePersistence(db);
 */
export async function enablePersistence(db: Database): Promise<void> {
  try {
    db.exec('SET hnsw_enable_experimental_persistence = true');
  } catch (error) {
    console.warn('Could not enable VSS persistence:', error);
    // Non-fatal - continue without persistence
  }
}
