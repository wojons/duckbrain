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
 * Parse DuckDB STRUCT format string into a JavaScript object
 * 
 * DuckDB returns STRUCT columns as strings like: {key1='value1', key2='value2'}
 * This parser handles the STRUCT format and converts to valid JSON
 * 
 * @param structStr - The STRUCT format string from DuckDB
 * @returns Parsed JavaScript object
 */
function parseDuckDBStruct(structStr: string): Record<string, unknown> {
  if (!structStr || typeof structStr !== 'string') {
    return {};
  }
  
  try {
    // Try to parse as JSON first (in case it's already JSON)
    return JSON.parse(structStr);
  } catch {
    // It's in STRUCT format, parse manually
  }
  
  const result: Record<string, unknown> = {};
  
  // Remove outer braces and whitespace
  const content = structStr.trim().replace(/^\{|\}$/g, '').trim();
  if (!content) {
    return result;
  }
  
  // Split by commas, but be careful with nested structures
  // Simple parsing: key='value' pairs
  const pairs = content.split(',');
  
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    
    // Find the = separator
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    
    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();
    
    // Remove quotes from value
    if ((value.startsWith("'") && value.endsWith("'")) || 
        (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    
    // Try to parse as JSON if it looks like a nested object or array
    if ((value.startsWith('{') && value.endsWith('}')) || 
        (value.startsWith('[') && value.endsWith(']'))) {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value;
      }
    } else if (value === 'true') {
      result[key] = true;
    } else if (value === 'false') {
      result[key] = false;
    } else if (value === 'null') {
      result[key] = null;
    } else if (!isNaN(Number(value)) && value !== '') {
      result[key] = Number(value);
    } else {
      result[key] = value;
    }
  }
  
  return result;
}

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

  // Build file list for DuckDB (use read_json instead of glob for reliability)
  const jsonlFiles: string[] = [];
  for (const partitionPath of partitionPaths) {
    if (!fs.existsSync(partitionPath)) continue;
    
    const files = fs.readdirSync(partitionPath)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(partitionPath, f).replace(/\\/g, '/'));
    jsonlFiles.push(...files);
  }
  
  if (jsonlFiles.length === 0) {
    return [];
  }

  // Build WHERE clause based on filters - use template literals instead of prepared statements
  // to avoid DuckDB Node.js binding issues with parameter placeholders
  const conditions: string[] = ["action != 'tombstone'"];
  
  if (filters?.key) {
    // Escape single quotes in key to prevent SQL injection
    const escapedKey = filters.key.replace(/'/g, "''");
    conditions.push(`key = '${escapedKey}'`);
  }
  
  if (filters?.keyPrefix) {
    // Escape single quotes in prefix and add LIKE pattern
    const escapedPrefix = filters.keyPrefix.replace(/'/g, "''");
    conditions.push(`key LIKE '${escapedPrefix}%%'`);
  }
  
  if (filters?.domain) {
    conditions.push(`domain = '${filters.domain}'`);
  }

  let orderByClause = '';
  
  // Semantic search with vector similarity
  if (filters?.query && filters?.embedding) {
    // Use DuckDB VSS extension for cosine similarity
    const embeddingStr = `[${filters.embedding.join(',')}]`;
    conditions.push('embedding IS NOT NULL');
    orderByClause = `ORDER BY array_cosine_distance(embedding, ${embeddingStr}::FLOAT[384]) ASC`;
  }

  const whereClause = conditions.length > 0 
    ? `WHERE ${conditions.join(' AND ')}` 
    : '';
  
  const limitClause = filters?.limit ? `LIMIT ${filters.limit}` : '';

  // Use read_json with explicit file list instead of glob pattern
  const fileList = jsonlFiles.map(f => `'${f}'`).join(', ');
  const sql = `
    SELECT id, key, domain, timestamp, author, action, embedding_text, attributes
    FROM read_json([${fileList}], format='newline_delimited')
    ${whereClause}
    ${orderByClause}
    ${limitClause}
  `;

  // Use db.all() directly instead of prepared statements to avoid parameter binding issues
  return new Promise((resolve) => {
    try {
      db.all(sql, (err: any, result: any) => {
        if (err) {
          console.error('DuckDB query error:', err);
          resolve([]);
          return;
        }
        
        // Handle case where result is undefined or not an array
        if (!result || !Array.isArray(result)) {
          resolve([]);
          return;
        }
        
        resolve((result as any[]).map((row: any) => ({
          id: row.id,
          key: row.key,
          domain: row.domain,
          timestamp: row.timestamp,
          author: row.author,
          action: row.action,
          embedding_text: row.embedding_text,
          attributes: typeof row.attributes === 'string' 
            ? parseDuckDBStruct(row.attributes)
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
