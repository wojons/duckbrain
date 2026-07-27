/**
 * DuckDB Queries Tests
 * 
 * Tests for memory query operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDuckDB, closeDuckDB } from './connection';
import { insertMemory, tombstoneMemory, queryMemories } from './queries';
import { deepConvertBigInts } from '../utils/serialize';
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
    it('should create tombstone record for existing memory', async () => {
      const originalMemory = createMemory({
        key: '/test/to-delete',
        domain: 'raw_note',
        author: 'test@example.com',
        embedding_text: 'Will be tombstoned'
      });

      insertMemory(db, originalMemory, testPartition);
      
      // Create tombstone
      await tombstoneMemory(db, originalMemory.id, testPartition, 'Test deletion');

      // Read JSONL directly (queryMemories filters out tombstones by design)
      const files = fs.readdirSync(testPartition).filter(f => f.endsWith('.jsonl'));
      const allRecords: any[] = [];
      for (const f of files) {
        const content = fs.readFileSync(path.join(testPartition, f), 'utf-8');
        content.split('\n').filter(l => l.trim()).forEach(l => {
          allRecords.push(JSON.parse(l));
        });
      }
      const tombstones = allRecords.filter(m => m.action === 'tombstone');
      expect(tombstones.length).toBe(1);
      expect(tombstones[0].id).toBe(originalMemory.id);
    });

    it('should handle non-existent memory gracefully', async () => {
      // Should not throw
      await expect(
        tombstoneMemory(db, 'non-existent-id', testPartition)
      ).resolves.not.toThrow();
    });
  });

  describe('queryMemories', () => {
    it('should query memories from partition', async () => {
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

      const results = await queryMemories(db, [testPartition]);
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter out tombstones by default', async () => {
      const memory = createMemory({
        key: '/test/filter-test',
        domain: 'raw_note',
        author: 'test@example.com',
        embedding_text: 'Filter test'
      });

      insertMemory(db, memory, testPartition);
      await tombstoneMemory(db, memory.id, testPartition);

      const results = await queryMemories(db, [testPartition]);
      // queryMemories should exclude tombstone records (action='tombstone')
      // The original 'add' record may still exist; the key invariant is no tombstones returned
      const tombstones = results.filter(m => m.action === 'tombstone');
      expect(tombstones.length).toBe(0);
      // Original record should NOT be returned — the latest action is a tombstone
      // Fix for BUG-027: tombstone filtering must exclude memories whose
      // latest record is a tombstone (memory is deleted)
      const active = results.filter(m => m.id === memory.id);
      expect(active.length).toBe(0);
    });

    it('should filter by key', async () => {
      const memory1 = createMemory({
        key: '/test/specific',
        domain: 'raw_note',
        author: 'test@example.com',
        embedding_text: 'Specific key'
      });

      insertMemory(db, memory1, testPartition);

      const results = await queryMemories(db, [testPartition], { key: '/test/specific' });
      expect(results.length).toBe(1);
      expect(results[0].key).toBe('/test/specific');
    });

    it('should filter by domain', async () => {
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

      const personResults = await queryMemories(db, [testPartition], { domain: 'person' });
      expect(personResults.length).toBe(1);
      expect(personResults[0].domain).toBe('person');
    });
  });

  describe('BigInt serialization', () => {
    it('should convert BigInt values to safe numbers in query results', async () => {
      // Write a raw JSONL line with a large integer that DuckDB will
      // interpret as BIGINT when reading back via read_json.
      // We bypass insertMemory (which uses safeJsonStringify) to ensure
      // DuckDB sees the raw large integer and returns it as a BigInt.
      if (!fs.existsSync(testPartition)) {
        fs.mkdirSync(testPartition, { recursive: true });
      }
      const chunkPath = path.join(testPartition, 'chunk_bigint_test.jsonl');
      // 9007199254740992 = Number.MAX_SAFE_INTEGER + 1 — within BIGINT range
      // but beyond JavaScript safe integer. DuckDB should return this as BigInt.
      const bigValue = 9007199254740992;
      const rawLine = JSON.stringify({
        id: crypto.randomUUID(),
        key: '/test/bigint-attrs',
        domain: 'raw_note',
        timestamp: new Date().toISOString(),
        author: 'test@example.com',
        action: 'add',
        embedding_text: 'BigInt test',
        attributes: {
          big_count: bigValue,
          nested: { normal_num: 42 },
          tags: ['a', 'b']
        }
      }) + '\n';
      fs.writeFileSync(chunkPath, rawLine, 'utf-8');

      const results = await queryMemories(db, [testPartition]);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const result = results.find(m => m.key === '/test/bigint-attrs');
      expect(result).toBeDefined();

      // Verify JSON.stringify does not throw (no BigInt values left)
      const json = JSON.stringify(result);
      expect(json).toBeTruthy();
      expect(() => JSON.parse(json)).not.toThrow();

      // Verify the result round-trips through JSON cleanly
      const parsed = JSON.parse(json);
      expect(parsed.key).toBe('/test/bigint-attrs');
    });

    it('deepConvertBigInts should handle all edge cases', () => {
      // Safe integer — converted to Number
      const safe = deepConvertBigInts(42n);
      expect(typeof safe).toBe('number');
      expect(safe).toBe(42);

      // Unsafe large integer — converted to String
      const unsafe = deepConvertBigInts(12345678901234567890n);
      expect(typeof unsafe).toBe('string');
      expect(unsafe).toBe('12345678901234567890');

      // Negative BigInt (safe range)
      const negSafe = deepConvertBigInts(-100n);
      expect(typeof negSafe).toBe('number');
      expect(negSafe).toBe(-100);

      // Zero
      const zero = deepConvertBigInts(0n);
      expect(typeof zero).toBe('number');
      expect(zero).toBe(0);

      // Nested object with BigInts
      const nested = deepConvertBigInts({
        a: 1n,
        b: { c: 2n, d: 'string' },
        e: [3n, { f: 4n }]
      });
      expect(nested).toEqual({
        a: 1,
        b: { c: 2, d: 'string' },
        e: [3, { f: 4 }]
      });

      // Array of BigInts
      const arr = deepConvertBigInts([1n, 2n, 3n]);
      expect(arr).toEqual([1, 2, 3]);

      // Non-BigInt values pass through unchanged
      expect(deepConvertBigInts('hello')).toBe('hello');
      expect(deepConvertBigInts(42)).toBe(42);
      expect(deepConvertBigInts(null)).toBeNull();
      expect(deepConvertBigInts(undefined)).toBeUndefined();
    });

    it('should not throw on BigInt in direct DuckDB results', () => {
      // Simulate what DuckDB returns: a row with a BigInt column
      const rawRow = {
        id: 'test-uuid',
        key: '/test/bigint',
        domain: 'raw_note',
        timestamp: new Date().toISOString(),
        author: 'test@example.com',
        action: 'add',
        embedding_text: 'test',
        attributes: { count: 123456789012345n }
      };

      // This should not throw
      const converted = deepConvertBigInts(rawRow);
      expect(typeof converted.attributes.count).toBe('number');
      expect(converted.attributes.count).toBe(123456789012345);
      expect(() => JSON.stringify(converted)).not.toThrow();
    });
  });
});
