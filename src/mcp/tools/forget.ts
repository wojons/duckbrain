/**
 * Forget MCP Tool
 *
 * Mark a memory as deleted (tombstone).
 * Never deletes files - appends tombstone record to preserve git history.
 */

import { z } from 'zod';
import { getDuckDBConnection } from '../../duckdb/connection';
import { queryMemories, tombstoneMemory } from '../../duckdb/queries';
import { getPartitionsForDomain } from '../../storage/manifest';
import { getConfig } from '../../config/index';
import path from 'path';
import fs from 'fs';

/**
 * Input schema for forget tool
 */
const ForgetInputSchema = z.object({
  /** Memory ID to forget */
  id: z.string().uuid().describe('Memory ID to forget'),
  /** Optional reason for deletion */
  reason: z.string().optional().describe('Optional reason for deletion'),
  /** Namespace to search */
  namespace: z.string().default('default').describe('Namespace to search'),
  /** Domain to search (optimization) */
  domain: z.string().optional().describe('Domain to search (optimization)')
});

type ForgetInput = z.infer<typeof ForgetInputSchema>;

/**
 * Output schema for forget tool
 */
interface ForgetOutput {
  success: boolean;
  id?: string;
  tombstoned?: boolean;
  error?: string;
}

/**
 * Resolve namespace path from namespace name using config
 */
function resolveNamespacePath(namespace: string): string {
  const config = getConfig('.');
  const nsPath = config.namespacesPath || './namespaces';
  return path.join(nsPath, namespace);
}

/**
 * Get all partition paths for a namespace
 */
function getAllPartitionPaths(namespacePath: string, domain?: string): string[] {
  if (domain) {
    return getPartitionsForDomain(namespacePath, domain).map(p => path.join(namespacePath, p));
  }
  
  // Read manifest to get all partitions
  const manifestPath = path.join(namespacePath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return [];
  }
  
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
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
export async function forgetTool(input: ForgetInput): Promise<ForgetOutput> {
  try {
    // Validate input
    const parseResult = ForgetInputSchema.safeParse(input);
    if (!parseResult.success) {
      return {
        success: false,
        error: `Invalid input: ${(parseResult.error as any).issues.map((i: any) => i.message).join('; ')}`
      };
    }

    const { id, reason, namespace, domain } = parseResult.data;

    // Resolve namespace path
    const namespacePath = resolveNamespacePath(namespace);

    // Check if namespace exists
    if (!fs.existsSync(namespacePath)) {
      return {
        success: false,
        error: `Namespace '${namespace}' not found`
      };
    }

    // Get all partition paths to search
    const partitionPaths = getAllPartitionPaths(namespacePath, domain);
    
    if (partitionPaths.length === 0) {
      return {
        success: false,
        error: 'No partitions found in namespace'
      };
    }

    // Initialize DuckDB connection
    const db = getDuckDBConnection('singleton', namespacePath);

    // Find memory by ID across all partitions
    const memories = await queryMemories(db, partitionPaths);
    const originalMemory = memories.find(m => m.id === id);

    if (!originalMemory) {
      return {
        success: false,
        error: `Memory '${id}' not found`
      };
    }

    // Determine the partition path for the original memory
    // (we'll append tombstone to the same partition)
    const partitionRelPath = getPartitionPathForMemory(originalMemory.key, originalMemory.domain);
    const partitionPath = path.join(namespacePath, partitionRelPath);

    // Create tombstone record
    await tombstoneMemory(db, id, partitionPath, reason);

    return {
      success: true,
      id,
      tombstoned: true
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Get partition path for a memory based on its key and domain
 * Uses time-based partitioning - matches what rememberTool uses
 */
function getPartitionPathForMemory(key: string, domain: string): string {
  // Extract year-month from current time (must match rememberTool logic)
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const partitionValue = `${year}-${month}`;
  
  // Use time-based partitioning only (no key-based sub-partitions)
  // This matches the logic in rememberTool
  return path.join(domain, partitionValue);
}

/**
 * MCP tool registration
 */
export const forgetToolDef = {
  name: 'forget',
  title: 'Forget Memory',
  description: 'Mark a memory as deleted (tombstone)',
  inputSchema: ForgetInputSchema,
  handler: forgetTool
};
