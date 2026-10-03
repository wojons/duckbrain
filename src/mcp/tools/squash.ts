/**
 * Squash MCP Tool
 *
 * Compact old memory partitions to reduce repository size.
 * Converts JSONL to Parquet, removes tombstones, optionally squashes git history.
 */

import { z } from "zod";
import {
  squashPartition,
  compactHistory,
  getCompactionStats,
} from "../../git/squash";
import {
  resolveNamespaceName,
  resolveNamespacePath,
  enforceNamespaceScope,
  type McpToolContext,
} from "./shared";
import path from "path";

/**
 * Input schema for squash tool
 */
const SquashInputSchema = z.object({
  /** Specific partition to squash (optional - defaults to all old partitions) */
  partition: z
    .string()
    .optional()
    .describe("Specific partition to squash (optional)"),
  /** Namespace to operate on (defaults to the ACTIVE namespace — config defaultNamespace, DOGFOOD-014) */
  namespace: z
    .string()
    .optional()
    .describe("Namespace to operate on (defaults to the active namespace)"),
  /** Preview without making changes */
  dryRun: z.boolean().default(false).describe("Preview without making changes"),
  /** Squash git history aggressively */
  aggressive: z
    .boolean()
    .default(false)
    .describe("Squash git history aggressively"),
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
  /** Machine-readable failure code (NAMESPACE_SCOPE) — see ./shared */
  code?: string;
  /** Denial reason, 'namespace_scope' — the same reason REST audits */
  reason?: string;
  error?: string;
}

/** Injectable context for the squash handlers — the SUPA-4 principal seam. */
export interface SquashContext extends McpToolContext {}

/**
 * Resolve namespace path from namespace name
 */
/**
 * Squash tool handler
 *
 * @param input - Tool input parameters
 * @param context - Injectable principal seam (SUPA-4); MCP-over-HTTP falls
 *                  back to the DOGFOOD-025 ALS slot via resolveToolPrincipal
 * @returns Squash operation results
 */
export async function squashTool(
  input: SquashInput,
  context: SquashContext = {},
): Promise<SquashOutput> {
  try {
    // Validate input
    const parseResult = SquashInputSchema.safeParse(input);
    if (!parseResult.success) {
      return {
        success: false,
        message: `Invalid input: ${(parseResult.error as any).issues.map((i: any) => i.message).join("; ")}`,
      };
    }

    const { partition, dryRun, aggressive, namespace } = parseResult.data;

    // DB-GAP-031 (MCP parity): squash rewrites/compacts a namespace's storage,
    // so a token scoped to other namespaces must be refused before any work —
    // REST's table/compaction routes enforce this via middleware and /mcp has
    // no per-tool route to mount it on.
    const scopeViolation = enforceNamespaceScope(
      context,
      resolveNamespaceName(namespace),
    );
    if (scopeViolation) {
      return {
        success: false,
        message: scopeViolation.error,
        code: scopeViolation.code,
        reason: scopeViolation.reason,
        error: scopeViolation.error,
        errors: [scopeViolation.error],
      };
    }

    // If specific partition provided, squash it directly
    if (partition) {
      const namespacePath = resolveNamespacePath(namespace);
      const partitionPath = path.isAbsolute(partition)
        ? partition
        : path.join(namespacePath, partition);

      const result = await squashPartition(partitionPath, {
        dryRun,
        squashCommits: aggressive,
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
            tombstonesRemoved: result.recordsRemoved,
          },
        };
      } else {
        return {
          success: false,
          message: `Failed to squash partition: ${result.error || "Unknown error"}`,
          errors: [result.error || "Unknown error"],
        };
      }
    }

    // No specific partition - run history compaction
    const result = await compactHistory({
      maxAge: 30,
      threshold: 1000,
      dryRun,
      squashCommits: aggressive,
      namespacePath: resolveNamespacePath(namespace),
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
          tombstonesRemoved: result.totalRecordsRemoved,
        },
        errors: result.errors,
      };
    } else {
      return {
        success: false,
        message: `Compaction failed: ${result.errors?.join(", ") || "Unknown error"}`,
        errors: result.errors,
      };
    }
  } catch (error) {
    return {
      success: false,
      message: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      errors: [error instanceof Error ? error.message : "Unknown error"],
    };
  }
}

/**
 * Get compaction stats tool handler
 *
 * @param input - Optional namespace to scan (defaults to the ACTIVE
 * namespace — config defaultNamespace, DOGFOOD-014). Previously the stats
 * were always computed against the hardcoded legacy path
 * cwd/.duckbrain/namespaces/default, which never exists in configured
 * deployments → all-zero stats.
 * @returns Repository compaction statistics
 */
export async function getCompactionStatsTool(
  input?: {
    namespace?: string;
  },
  context: SquashContext = {},
): Promise<{
  success: boolean;
  /** Namespace actually scanned — resolved from the arg or the active
   *  (config defaultNamespace) namespace when omitted (DOGFOOD-014) */
  namespace?: string;
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
  /** Machine-readable failure code (NAMESPACE_SCOPE) — see ./shared */
  code?: string;
  /** Denial reason, 'namespace_scope' — the same reason REST audits */
  reason?: string;
  error?: string;
}> {
  // DB-GAP-031 (MCP parity): stats expose a namespace's storage shape, so the
  // same grant rule applies as for squash — checked before the try so the
  // machine-readable refusal is not flattened by the generic catch.
  const scopeViolation = enforceNamespaceScope(
    context,
    resolveNamespaceName(input?.namespace),
  );
  if (scopeViolation) {
    return {
      success: false,
      code: scopeViolation.code,
      reason: scopeViolation.reason,
      error: scopeViolation.error,
    };
  }

  try {
    const namespacePath = resolveNamespacePath(input?.namespace);
    const stats = await getCompactionStats(namespacePath);

    return {
      success: true,
      namespace: resolveNamespaceName(input?.namespace),
      stats,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * MCP tool registration
 */
export const squashToolDef = {
  name: "squash",
  title: "Squash Memory Partitions",
  description:
    "Compact old memory partitions to reduce repository size. Converts JSONL to Parquet, removes tombstones, optionally squashes git history.",
  inputSchema: SquashInputSchema,
  handler: squashTool,
};

/**
 * MCP tool registration for stats
 */
export const compactionStatsToolDef = {
  name: "get_compaction_stats",
  title: "Get Compaction Statistics",
  description:
    "Get repository compaction statistics including tombstone percentage, Parquet ratio, and partition health",
  inputSchema: z.object({
    /** Namespace to scan (defaults to the ACTIVE namespace — config defaultNamespace) */
    namespace: z
      .string()
      .optional()
      .describe("Namespace to scan (defaults to the active namespace)"),
  }),
  handler: getCompactionStatsTool,
};
