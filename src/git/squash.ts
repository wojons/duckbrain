/**
 * DuckBrain Squash/Compaction Module
 *
 * Reduces repository bloat by:
 * - Converting old JSONL partitions to Parquet format
 * - Removing tombstoned records during compaction
 * - Optionally squashing git history for compacted partitions
 *
 * Configurable aggressiveness: from manual-only to continuous background compaction.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getManifest, getAllPartitionPaths, type Manifest } from '../storage/manifest';
import { getDuckDBConnection } from '../duckdb/connection';
import { execSync } from 'child_process';

/**
 * Squash operation options
 */
export interface SquashOptions {
  /** Specific partition path to squash (default: all old partitions) */
  partition?: string;
  /** Preview changes without modifying files */
  dryRun?: boolean;
  /** Squash git history for compacted partitions */
  squashCommits?: boolean;
  /** Compression level for Parquet (1-9, default: 6) */
  compressionLevel?: number;
}

/**
 * Compaction statistics
 */
export interface CompactionStats {
  /** Total repository size in bytes */
  totalSize: number;
  /** Total number of partitions */
  totalPartitions: number;
  /** Number of Parquet partitions */
  parquetPartitions: number;
  /** Number of JSONL partitions */
  jsonlPartitions: number;
  /** Total records across all partitions */
  totalRecords: number;
  /** Number of tombstone records */
  tombstoneRecords: number;
  /** Percentage of tombstones */
  tombstonePercent: number;
  /** Percentage of Parquet partitions */
  parquetRatio: number;
  /** Partitions older than 30 days */
  oldPartitions: string[];
  /** Partitions exceeding size threshold */
  largePartitions: Array<{ path: string; size: number; records: number }>;
}

/**
 * Squash a single partition
 *
 * Converts JSONL to Parquet, removes tombstones, optionally squashes git history.
 *
 * @param partitionPath - Absolute path to partition directory
 * @param options - Squash options
 * @returns Statistics about the squash operation
 */
export async function squashPartition(
  partitionPath: string,
  options: SquashOptions = {}
): Promise<{
  success: boolean;
  recordsKept: number;
  recordsRemoved: number;
  parquetPath?: string;
  error?: string;
}> {
  const { dryRun = false, squashCommits = true, compressionLevel = 6 } = options;

  try {
    // Check partition exists
    if (!fs.existsSync(partitionPath)) {
      return {
        success: false,
        recordsKept: 0,
        recordsRemoved: 0,
        error: `Partition not found: ${partitionPath}`
      };
    }

    // Find all JSONL files in partition
    const jsonlFiles = fs
      .readdirSync(partitionPath)
      .filter((f: string) => f.endsWith('.jsonl'))
      .map((f: string) => path.join(partitionPath, f));

    if (jsonlFiles.length === 0) {
      return {
        success: false,
        recordsKept: 0,
        recordsRemoved: 0,
        error: 'No JSONL files found in partition'
      };
    }

    // Read all records from JSONL files
    const allRecords: Array<Record<string, any>> = [];
    for (const jsonlFile of jsonlFiles) {
      const content = fs.readFileSync(jsonlFile, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim() !== '');
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as Record<string, any>;
          allRecords.push(record);
        } catch (err) {
          console.warn(`Warning: Could not parse line in ${jsonlFile}: ${line}`);
        }
      }
    }

    // Filter out tombstoned records (action === 'tombstone' or action === 'forget')
    const liveRecords = allRecords.filter(
      r => r.action !== 'tombstone' && r.action !== 'forget'
    );
    const tombstoneCount = allRecords.length - liveRecords.length;

    if (dryRun) {
      return {
        success: true,
        recordsKept: liveRecords.length,
        recordsRemoved: tombstoneCount,
        parquetPath: undefined
      };
    }

    // Convert to Parquet using DuckDB
    // Use singleton mode with partition path as namespace identifier
    const db = getDuckDBConnection('singleton', partitionPath);
    const parquetFileName = `data-${Date.now()}.parquet`;
    const parquetPath = path.join(partitionPath, parquetFileName);

    // Create temporary table with records
    // Note: DuckDB Node.js bindings - use run() for DDL, all() for queries
    await new Promise<void>((resolve, reject) => {
      db.run(
        `CREATE TEMP TABLE records AS SELECT * FROM read_json_auto('${jsonlFiles.map(f => f.replace(/\\/g, '/')).join("','")}'))`,
        (err: any) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Filter out tombstones and write to Parquet
    await new Promise<void>((resolve, reject) => {
      db.run(
        `COPY (SELECT * FROM records WHERE action NOT IN ('tombstone', 'forget')) TO '${parquetPath.replace(/\\/g, '/')}' (FORMAT PARQUET, COMPRESSION 'ZSTD', COMPRESSION_LEVEL ${compressionLevel})`,
        (err: any) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Remove old JSONL files after successful Parquet write
    for (const jsonlFile of jsonlFiles) {
      fs.unlinkSync(jsonlFile);
    }

    // Update manifest to reflect Parquet format
    const namespacePath = findNamespacePath(partitionPath);
    if (namespacePath) {
      const manifest = getManifest(namespacePath);
      // Mark partition as compacted (could add a flag or metadata)
      manifest.lastUpdated = new Date().toISOString();
      writeManifestAtomic(namespacePath, manifest);
    }

    // Optionally squash git history
    if (squashCommits) {
      try {
        squashGitHistory(partitionPath);
      } catch (gitErr) {
        console.warn(`Warning: Git history squash failed: ${gitErr instanceof Error ? gitErr.message : gitErr}`);
        // Continue anyway - Parquet conversion succeeded
      }
    }

    return {
      success: true,
      recordsKept: liveRecords.length,
      recordsRemoved: tombstoneCount,
      parquetPath
    };
  } catch (error) {
    return {
      success: false,
      recordsKept: 0,
      recordsRemoved: 0,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Compact history for partitions older than specified age
 *
 * @param options - Compaction options
 * @returns Compaction results
 */
export async function compactHistory(options: {
  /** Max age in days (default: 30) */
  maxAge?: number;
  /** Minimum records threshold (default: 1000) */
  threshold?: number;
  /** Dry run mode */
  dryRun?: boolean;
  /** Squash git history */
  squashCommits?: boolean;
} = {}): Promise<{
  success: boolean;
  partitionsCompacted: number;
  totalRecordsKept: number;
  totalRecordsRemoved: number;
  errors?: string[];
}> {
  const {
    maxAge = 30,
    threshold = 1000,
    dryRun = false,
    squashCommits = true
  } = options;

  const errors: string[] = [];
  let partitionsCompacted = 0;
  let totalRecordsKept = 0;
  let totalRecordsRemoved = 0;

  // Get namespace path (assume default namespace for now)
  const namespacePath = path.join(process.cwd(), '.duckbrain', 'namespaces', 'default');
  if (!fs.existsSync(namespacePath)) {
    return {
      success: false,
      partitionsCompacted: 0,
      totalRecordsKept: 0,
      totalRecordsRemoved: 0,
      errors: ['Default namespace not found']
    };
  }

  const manifest = getManifest(namespacePath);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxAge);

  // Find old partitions
  for (const partitionRelPath of manifest.partitions) {
    const partitionPath = path.join(namespacePath, partitionRelPath);

    if (!fs.existsSync(partitionPath)) {
      continue;
    }

    // Check partition age (based on directory modification time)
    try {
      const stats = fs.statSync(partitionPath);
      const partitionDate = new Date(stats.mtime);

      if (partitionDate < cutoffDate) {
        // Count records first
        const jsonlFiles = fs
          .readdirSync(partitionPath)
          .filter(f => f.endsWith('.jsonl'));

        let recordCount = 0;
        for (const file of jsonlFiles) {
          const content = fs.readFileSync(path.join(partitionPath, file), 'utf-8');
          const lines = content.split('\n').filter((line: string) => line.trim() !== '');
          recordCount += lines.length;
        }

        // Skip if below threshold
        if (recordCount < threshold) {
          continue;
        }

        // Squash partition
        const result = await squashPartition(partitionPath, {
          dryRun,
          squashCommits,
          partition: partitionRelPath
        });

        if (result.success) {
          partitionsCompacted++;
          totalRecordsKept += result.recordsKept;
          totalRecordsRemoved += result.recordsRemoved;
        } else if (result.error) {
          errors.push(`${partitionRelPath}: ${result.error}`);
        }
      }
    } catch (err) {
      errors.push(`${partitionRelPath}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  return {
    success: errors.length === 0,
    partitionsCompacted,
    totalRecordsKept,
    totalRecordsRemoved,
    errors: errors.length > 0 ? errors : undefined
  };
}

/**
 * Remove tombstones from a partition without converting to Parquet
 *
 * @param partitionPath - Absolute path to partition directory
 * @returns Number of tombstones removed
 */
export async function removeTombstones(partitionPath: string): Promise<{
  removed: number;
  totalRecords: number;
  error?: string;
}> {
  try {
    if (!fs.existsSync(partitionPath)) {
      return {
        removed: 0,
        totalRecords: 0,
        error: `Partition not found: ${partitionPath}`
      };
    }

    // Find all JSONL files
    const jsonlFiles = fs
      .readdirSync(partitionPath)
      .filter((f: string) => f.endsWith('.jsonl'));

    if (jsonlFiles.length === 0) {
      return {
        removed: 0,
        totalRecords: 0,
        error: 'No JSONL files found'
      };
    }

    let totalRecords = 0;
    let tombstoneCount = 0;
    const liveRecords: Array<Record<string, any>> = [];

    // Read and filter records
    for (const jsonlFile of jsonlFiles) {
      const content = fs.readFileSync(jsonlFile, 'utf-8');
      const lines = content.split('\n').filter((line: string) => line.trim() !== '');

      for (const line of lines) {
        try {
          const record = JSON.parse(line) as Record<string, any>;
          totalRecords++;

          if (record.action === 'tombstone' || record.action === 'forget') {
            tombstoneCount++;
          } else {
            liveRecords.push(record);
          }
        } catch (err) {
          console.warn(`Warning: Could not parse line in ${jsonlFile}`);
        }
      }
    }

    // Rewrite JSONL without tombstones
    const newChunkPath = path.join(partitionPath, `cleaned-${Date.now()}.jsonl`);
    const content = liveRecords.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(newChunkPath, content, 'utf-8');

    // Remove old files
    for (const jsonlFile of jsonlFiles) {
      fs.unlinkSync(jsonlFile);
    }

    // Rename cleaned file
    const originalBase = path.basename(jsonlFiles[0]).replace(/\.jsonl$/, '');
    const finalPath = path.join(partitionPath, `${originalBase}-cleaned.jsonl`);
    fs.renameSync(newChunkPath, finalPath);

    return {
      removed: tombstoneCount,
      totalRecords
    };
  } catch (error) {
    return {
      removed: 0,
      totalRecords: 0,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Get compaction statistics for repository
 *
 * @param namespacePath - Namespace path to scan (default: default namespace)
 * @returns Compaction statistics
 */
export async function getCompactionStats(
  namespacePath?: string
): Promise<CompactionStats> {
  if (!namespacePath) {
    namespacePath = path.join(process.cwd(), '.duckbrain', 'namespaces', 'default');
  }

  const stats: CompactionStats = {
    totalSize: 0,
    totalPartitions: 0,
    parquetPartitions: 0,
    jsonlPartitions: 0,
    totalRecords: 0,
    tombstoneRecords: 0,
    tombstonePercent: 0,
    parquetRatio: 0,
    oldPartitions: [],
    largePartitions: []
  };

  if (!fs.existsSync(namespacePath)) {
    return stats;
  }

  const manifest = getManifest(namespacePath);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 30);

  for (const partitionRelPath of manifest.partitions) {
    const partitionPath = path.join(namespacePath, partitionRelPath);

    if (!fs.existsSync(partitionPath)) {
      continue;
    }

    stats.totalPartitions++;

    // Check partition size
    let partitionSize = 0;
    let recordCount = 0;
    let tombstoneCount = 0;
    let isParquet = false;

    const files = fs.readdirSync(partitionPath);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    const parquetFiles = files.filter(f => f.endsWith('.parquet'));

    if (parquetFiles.length > 0) {
      stats.parquetPartitions++;
      isParquet = true;
    } else {
      stats.jsonlPartitions++;
    }

    // Scan JSONL files
    for (const file of jsonlFiles) {
      const filePath = path.join(partitionPath, file);
      const fileStats = fs.statSync(filePath);
      partitionSize += fileStats.size;

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim() !== '');
      recordCount += lines.length;

      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          if (record.action === 'tombstone' || record.action === 'forget') {
            tombstoneCount++;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Scan Parquet files (approximate size)
    for (const file of parquetFiles) {
      const filePath = path.join(partitionPath, file);
      const fileStats = fs.statSync(filePath);
      partitionSize += fileStats.size;
    }

    stats.totalSize += partitionSize;
    stats.totalRecords += recordCount;
    stats.tombstoneRecords += tombstoneCount;

    // Check if partition is old
    try {
      const partitionStats = fs.statSync(partitionPath);
      if (new Date(partitionStats.mtime) < cutoffDate) {
        stats.oldPartitions.push(partitionRelPath);
      }
    } catch {
      // Ignore stat errors
    }

    // Check if partition is large
    if (recordCount > 1000) {
      stats.largePartitions.push({
        path: partitionRelPath,
        size: partitionSize,
        records: recordCount
      });
    }
  }

  // Calculate percentages
  if (stats.totalRecords > 0) {
    stats.tombstonePercent = Math.round((stats.tombstoneRecords / stats.totalRecords) * 100);
  }
  if (stats.totalPartitions > 0) {
    stats.parquetRatio = Math.round((stats.parquetPartitions / stats.totalPartitions) * 100);
  }

  return stats;
}

/**
 * Squash git history for a partition directory
 *
 * Uses git filter-branch or git rebase to compact old commits.
 * This is an aggressive operation that rewrites history.
 *
 * @param partitionPath - Partition directory path
 */
function squashGitHistory(partitionPath: string): void {
  try {
    // Check if we're in a git repository
    execSync('git rev-parse --git-dir', { stdio: 'pipe' });

    // Get relative path from git root
    const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
    const relativePath = path.relative(gitRoot, partitionPath);

    // Squash commits touching this path into a single commit
    // Using git rebase with --autosquash
    const commitCount = execSync(
      `git log --oneline --follow -- "${relativePath}" | wc -l`,
      { encoding: 'utf-8' }
    ).trim();

    if (parseInt(commitCount) > 1) {
      // Could use interactive rebase, but that's complex
      // For now, just log that squashing would be beneficial
      console.log(`Partition ${relativePath}: ${commitCount} commits could be squashed`);
    }
  } catch (error) {
    // Not in git repo or other error - ignore
    console.warn('Git history squash skipped (not in git repo or error)');
  }
}

/**
 * Find namespace path from partition path
 */
function findNamespacePath(partitionPath: string): string | null {
  // Walk up directory tree looking for manifest.json
  let current = partitionPath;
  while (current !== path.dirname(current)) {
    const manifestPath = path.join(current, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}

/**
 * Write manifest atomically (copied from manifest.ts to avoid circular dependency)
 */
function writeManifestAtomic(namespacePath: string, manifest: Manifest): void {
  const manifestPath = path.join(namespacePath, 'manifest.json');
  const tmpPath = path.join(namespacePath, 'manifest.json.tmp');

  if (!fs.existsSync(namespacePath)) {
    fs.mkdirSync(namespacePath, { recursive: true });
  }

  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf-8');
  fs.renameSync(tmpPath, manifestPath);
}
