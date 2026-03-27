/**
 * Recall MCP Tool
 *
 * Query memories with filters and semantic search.
 * Supports exact key lookup, prefix glob, domain filter, and semantic search.
 */

import { z } from 'zod';
import { DomainEnum } from '../../schema/memory';
import { getDuckDBConnection } from '../../duckdb/connection';
import { queryMemories } from '../../duckdb/queries';
import { getPartitionsForDomain } from '../../storage/manifest';
import path from 'path';
import fs from 'fs';

/**
 * Input schema for recall tool
 */
const RecallInputSchema = z.object({
  /** Exact key lookup */
  key: z.string().optional().describe('Exact key lookup'),
  /** Prefix glob query (e.g., /projects/) */
  keyPrefix: z.string().optional().describe('Prefix glob query (e.g., /projects/)'),
  /** Domain filter */
  domain: DomainEnum.optional(),
  /** Semantic search query (uses vss extension) */
  query: z.string().optional().describe('Semantic search query (uses vss extension)'),
  /** Max results to return */
  limit: z.number().default(10).describe('Max results to return'),
  /** Namespace to query */
  namespace: z.string().default('default').describe('Namespace to query')
});

type RecallInput = z.infer<typeof RecallInputSchema>;

/**
 * Output schema for recall tool
 */
interface RecallOutput {
  memories: Array<{
    id: string;
    key: string;
    domain: string;
    timestamp: string;
    author: string;
    action: string;
    embedding_text: string;
    attributes: Record<string, unknown>;
  }>;
  count: number;
  error?: string;
}

/**
 * Resolve namespace path from namespace name
 */
function resolveNamespacePath(namespace: string): string {
  // Default namespace is in the project root
  if (namespace === 'default') {
    return path.join(process.cwd(), '.duckbrain', 'namespaces', 'default');
  }
  return path.join(process.cwd(), '.duckbrain', 'namespaces', namespace);
}

/**
 * Placeholder embedding generation
 * TODO: Integrate actual embedding model in Phase 2
 */
function generateEmbedding(_text: string): number[] | null {
  // For now, return null to indicate embedding not available
  // In Phase 2, this will call an embedding model API
  return null;
}

/**
 * Recall tool handler
 *
 * @param input - Tool input parameters
 * @returns Query results with memories and count
 */
export async function recallTool(input: unknown): Promise<RecallOutput> {
  // Validate input
  const parseResult = RecallInputSchema.safeParse(input);
  if (!parseResult.success) {
    return {
      memories: [],
      count: 0,
      error: `Invalid input: ${parseResult.error.errors.map(e => e.message).join('; ')}`
    };
  }

  const validated = parseResult.data;

  // Resolve namespace path
  const namespacePath = resolveNamespacePath(validated.namespace);

  // Check if namespace exists
  if (!fs.existsSync(namespacePath)) {
    return {
      memories: [],
      count: 0,
      error: `Namespace '${validated.namespace}' does not exist`
    };
  }

  try {
    // Get DuckDB connection
    const db = getDuckDBConnection('singleton', namespacePath);

    // Get partition paths, filtered by domain if provided
    let partitionPaths: string[];
    if (validated.domain) {
      partitionPaths = getPartitionsForDomain(namespacePath, validated.domain)
        .map(p => path.join(namespacePath, p));
    } else {
      // Get all partitions from manifest
      const manifestPath = path.join(namespacePath, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        partitionPaths = manifest.partitions.map((p: string) => path.join(namespacePath, p));
      } else {
        partitionPaths = [];
      }
    }

    // Build query filters
    const filters: Parameters<typeof queryMemories>[2] = {
      limit: validated.limit
    };

    if (validated.key) {
      filters.key = validated.key;
    } else if (validated.keyPrefix) {
      filters.keyPrefix = validated.keyPrefix;
    } else if (validated.domain) {
      filters.domain = validated.domain;
    }

    // Handle semantic search
    if (validated.query) {
      const embedding = generateEmbedding(validated.query);
      if (!embedding) {
        return {
          memories: [],
          count: 0,
          error: 'Semantic search requires embedding model - configure in Phase 2'
        };
      }
      filters.query = validated.query;
      filters.embedding = embedding;
    }

    // Execute query
    const memories = queryMemories(db, partitionPaths, filters);

    return {
      memories,
      count: memories.length
    };
  } catch (error) {
    return {
      memories: [],
      count: 0,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

/**
 * Tool metadata for MCP registration
 */
export const recallToolMetadata = {
  name: 'recall',
  title: 'Recall Memories',
  description: 'Query memories with filters and semantic search',
  inputSchema: RecallInputSchema,
  handler: recallTool
};

// Export for direct usage
export { RecallInputSchema };
