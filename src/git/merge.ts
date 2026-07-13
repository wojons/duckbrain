/**
 * Git Merge Conflict Resolution for DuckBrain
 *
 * Implements append-only merge logic for JSONL memory files.
 * Uses UUID-based deduplication (from SCHEMA-01) to merge conflicting versions.
 * 
 * Key principle: Never fail a merge — append-only architecture means
 * conflicts are always resolvable by combining both versions.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * Memory record structure (from SCHEMA-01)
 */
interface MemoryRecord {
  id: string;
  key: string;
  domain: string;
  timestamp: string;
  author?: string;
  action: 'create' | 'update' | 'tombstone';
  embedding_text?: string;
  attributes?: Record<string, any>;
}

/**
 * Merge result statistics
 */
export interface MergeResult {
  success: boolean;
  mergedContent: string;
  stats: {
    oursCount: number;
    theirsCount: number;
    mergedCount: number;
    duplicatesSkipped: number;
    tombstonesHandled: number;
  };
}

/**
 * Parse JSONL content into records
 * Handles malformed lines gracefully
 */
function parseJsonl(content: string): MemoryRecord[] {
  const records: MemoryRecord[] = [];
  const lines = content.split('\n').filter(line => line.trim());
  
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as MemoryRecord;
      records.push(record);
    } catch (error) {
      console.warn(`Warning: Skipping malformed JSON line: ${line.substring(0, 50)}...`);
    }
  }
  
  return records;
}

/**
 * Detect duplicate records by UUID
 * Groups records by id field
 */
export function detectDuplicates(records: MemoryRecord[]): {
  unique: MemoryRecord[];
  duplicates: MemoryRecord[];
  byId: Map<string, MemoryRecord[]>;
} {
  const byId = new Map<string, MemoryRecord[]>();
  
  for (const record of records) {
    const existing = byId.get(record.id) || [];
    existing.push(record);
    byId.set(record.id, existing);
  }
  
  const unique: MemoryRecord[] = [];
  const duplicates: MemoryRecord[] = [];
  
  for (const group of byId.values()) {
    if (group.length === 1) {
      unique.push(group[0]);
    } else {
      // Keep first occurrence as unique, rest are duplicates
      unique.push(group[0]);
      duplicates.push(...group.slice(1));
    }
  }
  
  return { unique, duplicates, byId };
}

/**
 * Resolve merge conflict between remote (theirs) and local (ours) JSONL content
 * 
 * @param theirs - Remote JSONL content (from git pull)
 * @param ours - Local JSONL content
 * @param options - Merge options
 * @returns Merged content with statistics
 */
export function resolveMergeConflict(
  theirs: string,
  ours: string,
  _options: { preferOurs?: boolean; preferTheirs?: boolean } = {}
): MergeResult {
  const oursRecords = parseJsonl(ours);
  const theirsRecords = parseJsonl(theirs);

  // Combine all records
  const allRecords = [...oursRecords, ...theirsRecords];

  // Deduplicate by UUID
  const { unique, duplicates } = detectDuplicates(allRecords);
  
  // Count tombstones
  const tombstonesCount = unique.filter(r => r.action === 'tombstone').length;
  
  // Sort by timestamp for consistent ordering
  unique.sort((a, b) => {
    const aTime = new Date(a.timestamp).getTime();
    const bTime = new Date(b.timestamp).getTime();
    return aTime - bTime;
  });
  
  // Convert back to JSONL
  const mergedContent = unique.map(r => JSON.stringify(r)).join('\n') + '\n';
  
  return {
    success: true,
    mergedContent,
    stats: {
      oursCount: oursRecords.length,
      theirsCount: theirsRecords.length,
      mergedCount: unique.length,
      duplicatesSkipped: duplicates.length,
      tombstonesHandled: tombstonesCount
    }
  };
}

/**
 * Auto-merge during git pull when conflicts detected
 * 
 * @param remotePath - Path to remote file (after git pull --no-commit)
 * @param localPath - Path to local file
 * @returns Merge result with success status
 */
export async function autoMerge(
  remotePath: string,
  localPath: string
): Promise<{ success: boolean; mergedCount: number; skippedCount: number }> {
  try {
    // Read both versions
    const theirs = fs.existsSync(remotePath) 
      ? fs.readFileSync(remotePath, 'utf-8')
      : '';
    const ours = fs.existsSync(localPath)
      ? fs.readFileSync(localPath, 'utf-8')
      : '';
    
    // Perform merge
    const result = resolveMergeConflict(theirs, ours);
    
    // Write merged result
    fs.writeFileSync(localPath, result.mergedContent);
    
    // Stage for commit
    try {
      execSync(`git add "${localPath}"`, { stdio: 'pipe' });
    } catch (gitError) {
      console.warn(`Warning: Could not stage file: ${(gitError as Error).message}`);
    }
    
    return {
      success: true,
      mergedCount: result.stats.mergedCount,
      skippedCount: result.stats.duplicatesSkipped
    };
  } catch (error) {
    console.error(`Merge failed: ${(error as Error).message}`);
    return {
      success: false,
      mergedCount: 0,
      skippedCount: 0
    };
  }
}

/**
 * Log merge activity to conflicts.log in namespace directory
 * 
 * @param merge - Merge result to log
 * @param namespacePath - Path to namespace directory
 * @param remoteUrl - Remote URL (source of merge)
 */
export function logMergeActivity(
  merge: MergeResult,
  namespacePath: string,
  remoteUrl: string = 'unknown'
): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    source: remoteUrl,
    recordsMerged: merge.stats.mergedCount,
    duplicatesSkipped: merge.stats.duplicatesSkipped,
    tombstonesHandled: merge.stats.tombstonesHandled,
    oursRecords: merge.stats.oursCount,
    theirsRecords: merge.stats.theirsCount
  };
  
  const conflictsLogPath = path.join(namespacePath, 'conflicts.log');
  const logLine = JSON.stringify(logEntry) + '\n';
  
  // Append to log (create if doesn't exist)
  fs.appendFileSync(conflictsLogPath, logLine);
}

/**
 * Extract author emails from merged records
 * Useful for tracking which authors' memories were merged
 */
export function extractAuthors(records: MemoryRecord[]): string[] {
  const authors = new Set<string>();
  
  for (const record of records) {
    if (record.author) {
      authors.add(record.author);
    }
  }
  
  return Array.from(authors);
}
