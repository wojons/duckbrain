/**
 * DuckBrain JSONL Storage
 *
 * Partitioned storage with three-level hierarchy:
 * namespace/domain/partition/chunk.jsonl
 *
 * Supports time-based (YYYY-MM) and key-based partitioning.
 * Chunked files for efficient reads (max 1000 lines or 1MB per chunk).
 */

import fs from 'fs';
import path from 'path';
import { MemorySchema, type MemoryType } from '../schema/memory';
import { safeJsonStringify } from '../utils/serialize';

/**
 * Maximum lines per chunk file before creating new one
 */
const MAX_LINES_PER_CHUNK = 1000;

/**
 * Maximum size per chunk file in bytes (1MB)
 */
const MAX_BYTES_PER_CHUNK = 1024 * 1024;

/**
 * Get partition directory path based on domain and partition value
 * (namespace path is resolved separately)
 *
 * @param namespace - Namespace folder (unused, kept for API compatibility)
 * @param domain - Memory domain (person, event, concept, etc.)
 * @param partitionType - 'time' or 'key' based partitioning
 * @param partitionValue - Time period (YYYY-MM) or key prefix
 * @returns Relative partition path: domain/partitionValue/
 *
 * @example
 * getPartitionPath('default', 'person', 'time', '2026-03')
 * // Returns: 'person/2026-03/'
 *
 * @example
 * getPartitionPath('default', 'event', 'key', 'projects/mcp')
 * // Returns: 'event/projects/mcp/'
 */
export function getPartitionPath(
  _namespace: string,
  domain: string,
  _partitionType: 'time' | 'key',
  partitionValue: string
): string {
  // Sanitize inputs to prevent path traversal
  const safeDomain = domain.replace(/[^a-zA-Z0-9_]/g, '_');
  // Allow slashes in partition value for key-based partitioning
  const safePartition = partitionValue.replace(/[^a-zA-Z0-9._/-]/g, '_');

  return path.join(safeDomain, safePartition) + path.sep;
}

/**
 * Create partition directory structure
 *
 * @param partitionPath - Path from getPartitionPath()
 * Creates directory recursively with .gitkeep file
 */
export function createPartition(partitionPath: string): void {
  // Ensure path ends with separator
  const normalizedPath = partitionPath.endsWith(path.sep)
    ? partitionPath
    : partitionPath + path.sep;

  // Create directory recursively
  fs.mkdirSync(normalizedPath, { recursive: true });

  // Initialize .gitkeep to track empty directories in git
  const gitkeepPath = path.join(normalizedPath, '.gitkeep');
  if (!fs.existsSync(gitkeepPath)) {
    fs.writeFileSync(gitkeepPath, '');
  }
}

/**
 * Get next available chunk filename in partition
 *
 * @param partitionPath - Partition directory path
 * @returns Next chunk filename (e.g., '0001.jsonl')
 */
function getNextChunkName(partitionPath: string): string {
  const existingChunks = fs
    .readdirSync(partitionPath)
    .filter(f => f.endsWith('.jsonl'))
    .sort();

  if (existingChunks.length === 0) {
    return '0001.jsonl';
  }

  // Get last chunk number and increment
  const lastChunk = existingChunks[existingChunks.length - 1];
  const lastNum = parseInt(lastChunk.replace('.jsonl', ''), 10);
  const nextNum = lastNum + 1;

  // Zero-pad to 4 digits
  return `${nextNum.toString().padStart(4, '0')}.jsonl`;
}

/**
 * Count lines in a file
 *
 * @param filePath - Path to file
 * @returns Number of newline characters
 */
function countLines(filePath: string): number {
  if (!fs.existsSync(filePath)) {
    return 0;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.split('\n').filter(l => l.trim() !== '').length;
}

/**
 * Append memory record to JSONL file
 *
 * Synchronous write for durability (git commits are async).
 * Validates record against MemorySchema before writing.
 *
 * @param filePath - Full path to JSONL file
 * @param record - Memory record to append
 * @returns Number of lines written (1 on success)
 * @throws Error if validation fails or write errors
 */
export function appendToJsonl(filePath: string, record: MemoryType): number {
  // Validate record before writing
  MemorySchema.parse(record);

  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Serialize to JSON (single line, no trailing newline yet)
  const line = safeJsonStringify(record);

  // Check if we need a new chunk
  let targetPath = filePath;
  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    const lines = countLines(filePath);

    // Create new chunk if at capacity
    if (stats.size + line.length > MAX_BYTES_PER_CHUNK || lines >= MAX_LINES_PER_CHUNK) {
      const dirPath = path.dirname(filePath) + path.sep;
      targetPath = path.join(dirPath, getNextChunkName(dirPath));
    }
  }

  // Append with newline
  fs.appendFileSync(targetPath, line + '\n', 'utf-8');

  return 1;
}

/**
 * Read memory records from JSONL file
 *
 * @param filePath - Full path to JSONL file
 * @param limit - Maximum records to return (optional)
 * @returns Array of validated MemoryType records
 * @throws Error if file doesn't exist or validation fails
 */
export function readFromJsonl(
  filePath: string,
  limit?: number
): MemoryType[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim() !== '');
  const records: MemoryType[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (limit && records.length >= limit) {
      break;
    }

    try {
      const parsed = JSON.parse(lines[i]);
      const validated = MemorySchema.parse(parsed);
      records.push(validated);
    } catch (error) {
      throw new Error(
        `Invalid JSON or schema at line ${i + 1}: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }
  }

  return records;
}

/**
 * Read all chunks from a partition
 *
 * @param partitionPath - Partition directory path
 * @param limit - Maximum total records across all chunks
 * @returns Array of validated MemoryType records
 */
export function readPartition(
  partitionPath: string,
  limit?: number
): MemoryType[] {
  if (!fs.existsSync(partitionPath)) {
    return [];
  }

  const chunks = fs
    .readdirSync(partitionPath)
    .filter(f => f.endsWith('.jsonl'))
    .sort();

  const allRecords: MemoryType[] = [];

  for (const chunk of chunks) {
    const chunkPath = path.join(partitionPath, chunk);
    const records = readFromJsonl(chunkPath);
    allRecords.push(...records);

    if (limit && allRecords.length >= limit) {
      return allRecords.slice(0, limit);
    }
  }

  return allRecords;
}

/**
 * Create a complete partition and return the path
 *
 * Convenience function combining getPartitionPath and createPartition
 *
 * @param namespace - Namespace folder
 * @param domain - Memory domain
 * @param partitionType - 'time' or 'key'
 * @param partitionValue - Partition identifier
 * @returns Created partition path
 */
export function createPartitionAtPath(
  namespace: string,
  domain: string,
  partitionType: 'time' | 'key',
  partitionValue: string
): string {
  const partitionPath = getPartitionPath(namespace, domain, partitionType, partitionValue);
  createPartition(partitionPath);
  return partitionPath;
}
