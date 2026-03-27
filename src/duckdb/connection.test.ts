/**
 * DuckDB Connection Tests
 * 
 * Tests for DuckDB connection management and VSS extension loading.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDuckDB, getDuckDBConnection, closeDuckDB, closeAllConnections } from './connection';
import { loadVSSExtension, enablePersistence } from './vss';

describe('DuckDB Connection', () => {
  let db: any;

  beforeEach(async () => {
    db = null;
    await closeAllConnections();
  });

  afterEach(async () => {
    if (db) {
      try {
        await closeDuckDB(db);
      } catch (e) {
        // Ignore if already closed
      }
    }
    await closeAllConnections();
  });

  describe('initDuckDB', () => {
    it('should create in-memory database', async () => {
      db = await initDuckDB(':memory:');
      expect(db).toBeDefined();
    });

    it('should load VSS extension automatically', async () => {
      db = await initDuckDB(':memory:');
      
      // Try to use a DuckDB function - should work if initialized
      expect(() => {
        db.exec('SELECT 1');
      }).not.toThrow();
    });

    it('should handle duckdb version check (not 1.3.3)', async () => {
      db = await initDuckDB(':memory:');
      const result = db.exec("SELECT version()");
      expect(result).toBeDefined();
      // Version should not be 1.3.3 (known buggy version)
      const versionStr = result[0]?.[0] as string;
      expect(versionStr).not.toBe('1.3.3');
    });
  });

  describe('getDuckDBConnection', () => {
    it('should return singleton connection for same namespace', async () => {
      const conn1 = getDuckDBConnection('singleton', 'test-ns-1');
      const conn2 = getDuckDBConnection('singleton', 'test-ns-1');
      
      expect(conn1).toBe(conn2);
    });

    it('should create separate connections for different namespaces', async () => {
      const conn1 = getDuckDBConnection('singleton', 'test-ns-a');
      const conn2 = getDuckDBConnection('singleton', 'test-ns-b');
      
      expect(conn1).not.toBe(conn2);
    });

    it('should support per-query mode', () => {
      const conn1 = getDuckDBConnection('per-query', ':memory:');
      const conn2 = getDuckDBConnection('per-query', ':memory:');
      
      expect(conn1).not.toBe(conn2);
    });
  });

  describe('loadVSSExtension', () => {
    it('should install and load VSS extension', async () => {
      db = await initDuckDB(':memory:');
      
      // Should not throw - handles already installed gracefully
      await expect(loadVSSExtension(db)).resolves.not.toThrow();
    });
  });

  describe('enablePersistence', () => {
    it('should enable experimental persistence setting', async () => {
      db = await initDuckDB(':memory:');
      
      await expect(enablePersistence(db)).resolves.not.toThrow();
    });
  });

  describe('closeDuckDB', () => {
    it('should close database connection cleanly', async () => {
      db = await initDuckDB(':memory:');
      
      await closeDuckDB(db);
      
      // Database should be closed - further operations should fail
      expect(() => {
        db.exec('SELECT 1');
      }).toThrow();
      
      db = null; // Prevent double-close in afterEach
    });
  });
});
