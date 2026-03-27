/**
 * DuckDB Queries Tests
 * 
 * Tests for memory query operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDuckDB, closeDuckDB } from './connection';
import { insertMemory, tombstoneMemory, queryMemories } from './queries';
import { createMemory } from '../schema/memory';
import path from 'path';
import fs from 'fs';

describe('DuckDB Queries', () => {
  let db: any;
  const testPartition = path.join(process.cwd(), 'test-memory');

  beforeEach(async () => {
    db = await initDuckDB(':memory:');
    // Clean up test partition
    if (fs.existsSync(testPartition)) {
      fs.rmSync(testPartition, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    if (db) {
      await closeDuckDB(db);
    }
    // Clean up test partition
    if (fs.existsSync(testPartition)) {
      fs.rmSync(testPartition, { recursive: true, force: true });
    }
  });

  describe('insertMemory', () => {
    it('should insert memory to partition', () => {
      const memory = createMemory({
        key: '/test/memory1',
        domain: 'raw_note',
        author: 'test@example.com',
        embedding_text: 'Test memory'
      });

      insertMemory(db, memory, testPartition);

      // Verify file was created
      expect(fs.existsSync(testPartition)).toBe(true);
    });

    it('should create partition if not exists', () => {
      const memory = createMemory({
        key: '/test/new-partition',
        domain: 'raw_note',
        author: 'test@example.com',
        embedding_text: 'New partition test'
      });

      expect(fs.existsSync(testPartition)).toBe(false);
      insertMemory(db, memory, testPartition);
      expect(fs.existsSync(testPartition)).toBe(true);
    });
  });

  describe('tombstoneMemory', () => {
    it('should create tombstone record for existing memory', () => {
      const originalMemory = createMemory({
        key: '/test/to-delete',
        domain: 'raw_note',
        author: 'test@example.com',
        embedding_text: 'Will be tombstoned'
      });

      insertMemory(db, originalMemory, testPartition);
      
      // Create tombstone
      tombstoneMemory(db, originalMemory.id, testPartition, 'Test deletion');

      // Verify tombstone was created
      const memories = queryMemories(db, [testPartition]);
      const tombstones = memories.filter(m => m.action === 'tombstone');
      expect(tombstones.length).toBe(1);
      expect(tombstones[0].id).toBe(originalMemory.id);
    });

    it('should handle non-existent memory gracefully', () => {
      // Should not throw
      expect(() => {
        tombstoneMemory(db, 'non-existent-id', testPartition);
      }).not.toThrow();
    });
  });

  describe('queryMemories', () => {
    it('should query memories from partition', () => {
      const memory1 = createMemory({
        key: '/test/query1',
        domain: 'raw_note',
        author: 'test@example.com',
        embedding_text: 'First memory'
      });

      const memory2 = createMemory({
        key: '/test/query2',
        domain: 'raw_note',
        author: 'test@example.com',
        embedding_text: 'Second memory'
      });

      insertMemory(db, memory1, testPartition);
      insertMemory(db, memory2, testPartition);

      const results = queryMemories(db, [testPartition]);
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter out tombstones by default', () => {
      const memory = createMemory({
        key: '/test/filter-test',
        domain: 'raw_note',
        author: 'test@example.com',
        embedding_text: 'Filter test'
      });

      insertMemory(db, memory, testPartition);
      tombstoneMemory(db, memory.id, testPartition);

      const results = queryMemories(db, [testPartition]);
      // Should not include the tombstoned memory
      const active = results.filter(m => m.id === memory.id && m.action !== 'tombstone');
      expect(active.length).toBe(0);
    });

    it('should filter by key', () => {
      const memory1 = createMemory({
        key: '/test/specific',
        domain: 'raw_note',
        author: 'test@example.com',
        embedding_text: 'Specific key'
      });

      insertMemory(db, memory1, testPartition);

      const results = queryMemories(db, [testPartition], { key: '/test/specific' });
      expect(results.length).toBe(1);
      expect(results[0].key).toBe('/test/specific');
    });

    it('should filter by domain', () => {
      const memory1 = createMemory({
        key: '/test/domain-filter',
        domain: 'person',
        author: 'test@example.com',
        embedding_text: 'Person memory'
      });

      const memory2 = createMemory({
        key: '/test/domain-filter2',
        domain: 'event',
        author: 'test@example.com',
        embedding_text: 'Event memory'
      });

      insertMemory(db, memory1, testPartition);
      insertMemory(db, memory2, testPartition);

      const personResults = queryMemories(db, [testPartition], { domain: 'person' });
      expect(personResults.length).toBe(1);
      expect(personResults[0].domain).toBe('person');
    });
  });
});
