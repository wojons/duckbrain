/**
 * Forget MCP Tool
 *
 * Mark a memory as deleted (tombstone).
 * Never deletes files - appends tombstone record to preserve git history.
 */

import { z } from "zod";
import { getDuckDBConnection } from "../../duckdb/connection";
import { queryMemories, tombstoneMemory } from "../../duckdb/queries";
import { getPartitionsForDomain } from "../../storage/manifest";
import {
  resolveNamespaceName,
  resolveNamespacePath,
  enforceNamespaceScope,
  resolveToolPrincipal,
  type McpToolContext,
} from "./shared";
import path from "path";
import fs from "fs";

/**
 * Input schema for forget tool
 */
const ForgetInputSchema = z.object({
  /** Memory ID to forget */
  id: z.string().uuid().describe("Memory ID to forget"),
  /** Optional reason for deletion */
  reason: z.string().optional().describe("Optional reason for deletion"),
  /** Namespace to search (defaults to current active namespace) */
  namespace: z.string().optional().describe("Namespace to search"),
  /** Domain to search (optimization) */
  domain: z.string().optional().describe("Domain to search (optimization)"),
  /** Author identity for the tombstone (DB-GAP-031: HTTP routes stamp the
   *  authenticated principal; absent = the original memory's author,
   *  preserving pre-grant behavior) */
  author: z
    .string()
    .optional()
    .describe("Author identity for the tombstone record"),
});

type ForgetInput = z.infer<typeof ForgetInputSchema>;

export interface ForgetContext extends McpToolContext {}

/**
 * Output schema for forget tool
 */
interface ForgetOutput {
  success: boolean;
  id?: string;
  tombstoned?: boolean;
  code?: string;
  /** DB-GAP-031 (MCP parity): 'namespace_scope' when the token has no grant
   *  for the target namespace — see ./shared */
  reason?: string;
  retryAfter?: number;
  error?: string;
}

/**
 * Resolve namespace path from namespace name using config.
 * Falls back to config's defaultNamespace when no namespace is provided.
 */
/**
 * Get all partition paths for a namespace
 */
function getAllPartitionPaths(
  namespacePath: string,
  domain?: string,
): string[] {
  if (domain) {
    return getPartitionsForDomain(namespacePath, domain).map((p) =>
      path.join(namespacePath, p),
    );
  }

  // Read manifest to get all partitions
  const manifestPath = path.join(namespacePath, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return [];
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    return manifest.partitions.map((p: string) => path.join(namespacePath, p));
  } catch {
    return [];
  }
}

/**
 * Forget tool handler
 *
 * @param input - Tool input parameters
 * @returns Success status with tombstone confirmation
 */
export async function forgetTool(
  input: ForgetInput,
  context: ForgetContext = {},
): Promise<ForgetOutput> {
  try {
    // Validate input
    const parseResult = ForgetInputSchema.safeParse(input);
    if (!parseResult.success) {
      return {
        success: false,
        error: `Invalid input: ${(parseResult.error as any).issues.map((i: any) => i.message).join("; ")}`,
      };
    }

    const { id, reason, namespace, domain, author } = parseResult.data;

    // Resolve namespace path
    const resolvedNamespace = resolveNamespaceName(namespace);
    const namespacePath = resolveNamespacePath(resolvedNamespace);

    // DB-GAP-031 (MCP parity): a tombstone is a write to the namespace, so a
    // scoped token must be refused here before any namespace or partition work
    // — the REST route already refuses it in `requireNamespaceGrant`
    // middleware, and /mcp has no per-tool route to mount that on. The same
    // principal is reused for the tombstone's author stamp below.
    const principal = resolveToolPrincipal(context);
    const scopeViolation = enforceNamespaceScope(context, resolvedNamespace);
    if (scopeViolation) return scopeViolation;

    // Check if namespace exists
    if (!fs.existsSync(namespacePath)) {
      return {
        success: false,
        error: `Namespace '${resolvedNamespace}' not found`,
      };
    }

    // Get all partition paths to search
    const partitionPaths = getAllPartitionPaths(namespacePath, domain);

    if (partitionPaths.length === 0) {
      return {
        success: false,
        error: "No partitions found in namespace",
      };
    }

    // Initialize DuckDB connection
    const db = getDuckDBConnection("singleton", namespacePath);

    // Find memory by ID across all partitions using DuckDB WHERE clause
    const memories = await queryMemories(db, partitionPaths, { id, limit: 1 });
    const originalMemory = memories[0];

    if (!originalMemory) {
      return {
        success: false,
        error: `Memory '${id}' not found`,
      };
    }

    // Determine the partition path for the original memory
    // (we'll append tombstone to the same partition)
    const partitionRelPath = getPartitionPathForMemory(
      originalMemory.key,
      originalMemory.domain,
    );
    const partitionPath = path.join(namespacePath, partitionRelPath);

    // Create tombstone record. The authenticated principal is evaluated by
    // the SUPA-4 seam before enqueue and again while the flush lock is held.
    // DB-GAP-031 (MCP parity): `principal` was resolved above, next to the
    // namespace-grant check that uses it.
    await tombstoneMemory(db, id, partitionPath, reason, author, principal);

    return {
      success: true,
      id,
      tombstoned: true,
    };
  } catch (error) {
    const coded = error as { code?: string; retryAfter?: number };
    return {
      success: false,
      ...(typeof coded?.code === "string" ? { code: coded.code } : {}),
      ...(typeof coded?.retryAfter === "number"
        ? { retryAfter: coded.retryAfter }
        : {}),
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Get partition path for a memory based on its key and domain
 * Uses time-based partitioning - matches what rememberTool uses
 */
function getPartitionPathForMemory(_key: string, domain: string): string {
  // Extract year-month from current time (must match rememberTool logic)
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const partitionValue = `${year}-${month}`;

  // Use time-based partitioning only (no key-based sub-partitions)
  // This matches the logic in rememberTool
  return path.join(domain, partitionValue);
}

/**
 * MCP tool registration
 */
export const forgetToolDef = {
  name: "forget",
  title: "Forget Memory",
  description: "Mark a memory as deleted (tombstone)",
  inputSchema: ForgetInputSchema,
  handler: forgetTool,
};
