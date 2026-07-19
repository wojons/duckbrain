/**
 * Squash MCP Tool
 *
 * Compact old memory partitions to reduce repository size.
 * Converts JSONL to Parquet, removes tombstones, optionally squashes git history.
 */

import { z } from 'zod';
import { squashPartition, compactHistory, getCompactionStats } from '../../git/squash';
import { resolveNamespacePath } from './shared';
import path from 'path';

/**
 * Input schema for squash tool
 */
const SquashInputSchema = z.object({
  /** Specific partition to squash (optional - defaults to all old partitions) */
  partition: z.string().optional().describe('Specific partition to squash (optional)'),
  /** Preview without making changes */
  dryRun: z.boolean().default(false).describe('Preview without making changes'),
  /** Squash git history aggressively */
  aggressive: z.boolean().default(false).describe('Squash git history aggressively')
});

type SquashInput = z.infer<typeof SquashInputSchema>;

/**
 * Output schema for squash tool
 */
interface SquashOutput {
  success: boolean;
  message: string;
  stats?: {
    partitionsCompacted?: number;
    totalRecordsKept?: number;
    totalRecordsRemoved?: number;
    tombstonesRemoved?: number;
  };
  errors?: string[];
}

/**
 * Resolve namespace path from namespace name
 */
/**
 * Squash tool handler
 *
 * @param input - Tool input parameters
 * @returns Squash operation results
 */
export async function squashTool(input: SquashInput): Promise<SquashOutput> {
  try {
    // Validate input
    const parseResult = SquashInputSchema.safeParse(input);
    if (!parseResult.success) {
      return {
        success: false,
        message: `Invalid input: ${(parseResult.error as any).issues.map((i: any) => i.message).join('; ')}`
      };
    }

    const { partition, dryRun, aggressive } = parseResult.data;

    // If specific partition provided, squash it directly
    if (partition) {
      const namespacePath = resolveNamespacePath();
      const partitionPath = path.isAbsolute(partition)
        ? partition
        : path.join(namespacePath, partition);

      const result = await squashPartition(partitionPath, {
        dryRun,
        squashCommits: aggressive
      });

      if (result.success) {
        return {
          success: true,
          message: dryRun
            ? `Preview: Would compact ${result.recordsKept} records, removing ${result.recordsRemoved} tombstones`
            : `Compacted partition: kept ${result.recordsKept} records, removed ${result.recordsRemoved} tombstones`,
          stats: {
            totalRecordsKept: result.recordsKept,
            totalRecordsRemoved: result.recordsRemoved,
            tombstonesRemoved: result.recordsRemoved
          }
        };
      } else {
        return {
          success: false,
          message: `Failed to squash partition: ${result.error || 'Unknown error'}`,
          errors: [result.error || 'Unknown error']
        };
      }
    }

    // No specific partition - run history compaction
    const result = await compactHistory({
      maxAge: 30,
      threshold: 1000,
      dryRun,
      squashCommits: aggressive
    });

    if (result.success) {
      return {
        success: true,
        message: dryRun
          ? `Preview: Would compact ${result.partitionsCompacted} partitions (${result.totalRecordsKept} records kept, ${result.totalRecordsRemoved} removed)`
          : `Compacted ${result.partitionsCompacted} partitions: kept ${result.totalRecordsKept} records, removed ${result.totalRecordsRemoved} tombstones`,
        stats: {
          partitionsCompacted: result.partitionsCompacted,
          totalRecordsKept: result.totalRecordsKept,
          totalRecordsRemoved: result.totalRecordsRemoved,
          tombstonesRemoved: result.totalRecordsRemoved
        },
        errors: result.errors
      };
    } else {
      return {
        success: false,
        message: `Compaction failed: ${result.errors?.join(', ') || 'Unknown error'}`,
        errors: result.errors
      };
    }
  } catch (error) {
    return {
      success: false,
      message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      errors: [error instanceof Error ? error.message : 'Unknown error']
    };
  }
}

/**
 * Get compaction stats tool handler
 *
 * @param _input - Unused (no input needed)
 * @returns Repository compaction statistics
 */
export async function getCompactionStatsTool(_input?: {}): Promise<{
  success: boolean;
  stats?: {
    totalSize: number;
    totalPartitions: number;
    parquetPartitions: number;
    jsonlPartitions: number;
    totalRecords: number;
    tombstoneRecords: number;
    tombstonePercent: number;
    parquetRatio: number;
    oldPartitions: string[];
    largePartitions: Array<{ path: string; size: number; records: number }>;
  };
  error?: string;
}> {
  try {
    const stats = await getCompactionStats();

    return {
      success: true,
      stats
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * MCP tool registration
 */
export const squashToolDef = {
  name: 'squash',
  title: 'Squash Memory Partitions',
  description: 'Compact old memory partitions to reduce repository size. Converts JSONL to Parquet, removes tombstones, optionally squashes git history.',
  inputSchema: SquashInputSchema,
  handler: squashTool
};

/**
 * MCP tool registration for stats
 */
export const compactionStatsToolDef = {
  name: 'get_compaction_stats',
  title: 'Get Compaction Statistics',
  description: 'Get repository compaction statistics including tombstone percentage, Parquet ratio, and partition health',
  inputSchema: z.object({}),
  handler: getCompactionStatsTool
};
