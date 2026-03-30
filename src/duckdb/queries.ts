/**
 * DuckDB Memory Queries
 *
 * Query layer for reading/writing memories via DuckDB.
 * Filters tombstone records by default.
 */

import duckdb from 'duckdb';
import type { Database } from './connection';
import type { MemoryType } from '../schema/memory';
import path from 'path';
import fs from 'fs';

/**
 * Query memories from DuckDB with optional filters
 *
 * @param db - DuckDB database instance
 * @param partitionPaths - Array of absolute partition paths to query
 * @param filters - Optional query filters
 * @returns Array of matching memory records
 */
export function queryMemories(
  db: Database,
  partitionPaths: string[],
  filters?: {
    key?: string;
    keyPrefix?: string;
    domain?: string;
    query?: string;
    embedding?: number[];
    limit?: number;
  }
): MemoryType[] | Promise<MemoryType[]> {
  if (partitionPaths.length === 0) {
    return [];
  }

  // Build glob pattern for partition paths
  const globPattern = partitionPaths.map(p => `${p}/*.jsonl`).join(',');
  
  // Build WHERE clause based on filters
  const whereClauses: string[] = ["action != 'tombstone'"];
  const params: Array<string | number> = [];
  
  if (filters?.key) {
    whereClauses.push('key = ?');
    params.push(filters.key);
  }
  
  if (filters?.keyPrefix) {
    whereClauses.push("key LIKE ? || '%'");
    params.push(filters.keyPrefix);
  }
  
  if (filters?.domain) {
    whereClauses.push('domain = ?');
    params.push(filters.domain);
  }

  let orderByClause = '';
  
  // Semantic search with vector similarity
  if (filters?.query && filters?.embedding) {
    // Use DuckDB VSS extension for cosine similarity
    const embeddingStr = `[${filters.embedding.join(',')}]`;
    whereClauses.push('embedding IS NOT NULL');
    orderByClause = `ORDER BY array_cosine_distance(embedding, ${embeddingStr}::FLOAT[384]) ASC`;
  }

  const whereClause = whereClauses.length > 0 
    ? `WHERE ${whereClauses.join(' AND ')}` 
    : '';
  
  const limitClause = filters?.limit ? `LIMIT ${filters.limit}` : '';

  const sql = `
    SELECT id, key, domain, timestamp, author, action, embedding_text, attributes
    FROM read_json_auto('${globPattern}', format='newline_delimited', hive_partitioning=0)
    ${whereClause}
    ${orderByClause}
    ${limitClause}
  `;

  // Use prepared statement with callback (DuckDB Node.js is async-only for queries)
  return new Promise((resolve) => {
    try {
      const stmt = db.prepare(sql);
      stmt.all(...params, (err, result) => {
        if (err) {
          console.error('DuckDB query error:', err);
          resolve([]);
          return;
        }
        
        resolve((result as any[]).map(row => ({
          id: row.id,
          key: row.key,
          domain: row.domain,
          timestamp: row.timestamp,
          author: row.author,
          action: row.action,
          embedding_text: row.embedding_text,
          attributes: typeof row.attributes === 'string' 
            ? JSON.parse(row.attributes) 
            : row.attributes
        })));
      });
    } catch (error) {
      console.error('DuckDB query error:', error);
      resolve([]);
    }
  });
}

/**
 * Insert a memory record into a partition file
 *
 * @param db - DuckDB database instance (for validation)
 * @param memory - Memory record to insert
 * @param partitionPath - Absolute path to partition directory
 */
export function insertMemory(
  db: Database,
  memory: MemoryType,
  partitionPath: string
): void {
  insertMemoryToPartition(memory, partitionPath);
}

/**
 * Insert memory to partition (shared utility)
 */
function insertMemoryToPartition(
  memory: MemoryType,
  partitionPath: string
): void {
  // Ensure partition directory exists
  if (!fs.existsSync(partitionPath)) {
    fs.mkdirSync(partitionPath, { recursive: true });
  }

  // Find or create chunk file
  const chunkFiles = fs
    .readdirSync(partitionPath)
    .filter(f => f.endsWith('.jsonl'))
    .sort();

  let targetChunk = chunkFiles.find(chunk => {
    const chunkPath = path.join(partitionPath, chunk);
    const stats = fs.statSync(chunkPath);
    const lineCount = countLines(chunkPath);
    return lineCount < 1000 && stats.size < 1024 * 1024; // 1000 lines or 1MB
  });

  if (!targetChunk) {
    // Create new chunk
    const timestamp = Date.now();
    targetChunk = `chunk_${timestamp}.jsonl`;
  }

  const chunkPath = path.join(partitionPath, targetChunk);

  // Append memory as JSON line
  const line = JSON.stringify(memory) + '\n';
  fs.appendFileSync(chunkPath, line, 'utf-8');
}

/**
 * Create tombstone record for a memory
 *
 * Appends a tombstone record with the same ID as the original memory.
 * Never deletes files - preserves git history.
 *
 * @param db - DuckDB database instance
 * @param memoryId - ID of memory to tombstone
 * @param partitionPath - Partition path to search and append to
 * @param reason - Optional reason for deletion (stored in attributes)
 */
export async function tombstoneMemory(
  db: Database,
  memoryId: string,
  partitionPath: string,
  reason?: string
): Promise<void> {
  // Find the original memory in the partition
  const memories = await queryMemories(db, [partitionPath]);
  const originalMemory = memories.find(m => m.id === memoryId);

  if (!originalMemory) {
    // Memory not found - create tombstone anyway with minimal data
    // This handles cases where the memory might be in a different partition
    const tombstone: MemoryType = {
      id: memoryId,
      key: '/unknown',
      domain: 'raw_note',
      timestamp: new Date().toISOString(),
      author: 'system',
      action: 'tombstone',
      embedding_text: '',
      attributes: reason ? { tombstone_reason: reason } : {}
    };
    insertMemoryToPartition(tombstone, partitionPath);
    return;
  }

  // Create tombstone record copying all fields from original
  const tombstone: MemoryType = {
    ...originalMemory,
    action: 'tombstone',
    timestamp: new Date().toISOString(),
    attributes: {
      ...originalMemory.attributes,
      ...(reason ? { tombstone_reason: reason } : {})
    }
  };

  insertMemoryToPartition(tombstone, partitionPath);
}

/**
 * Count lines in a file
 */
function countLines(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n').filter(line => line.trim() !== '').length;
  } catch {
    return 0;
  }
}
