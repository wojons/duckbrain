/**
 * List Keys MCP Tool
 *
 * Explore hierarchical key structure with pagination and depth limits.
 * Guardrail tool to prevent AI path hallucinations.
 */

import { z } from 'zod';
import { getDuckDBConnection } from '../../duckdb/connection';
import { getConfig } from '../../config/index';
import path from 'path';
import fs from 'fs';

/**
 * Input schema for list_keys tool
 */
const ListKeysInputSchema = z.object({
  /** Key prefix to filter (e.g., /projects/) */
  prefix: z.string().optional().default('/').describe('Key prefix to filter (e.g., /projects/)'),
  /** Max hierarchy depth to return */
  maxDepth: z.number().default(3).describe('Max hierarchy depth to return'),
  /** Max keys to return */
  limit: z.number().default(50).describe('Max keys to return'),
  /** Pagination offset */
  offset: z.number().default(0).describe('Pagination offset'),
  /** Namespace to query (defaults to current active namespace) */
  namespace: z.string().optional().describe('Namespace to query')
});

/**
 * Output schema for list_keys tool
 */
interface ListKeysOutput {
  keys: string[];
  hasMore: boolean;
  nextOffset: number | null;
  prefixes: Record<string, number>;
  error?: string;
}

/**
 * Resolve namespace path from namespace name
 * Uses config's defaultNamespace when no namespace is provided.
 */
function resolveNamespacePath(namespace: string | undefined): string {
  const config = getConfig('.');
  const ns = namespace || config.defaultNamespace || 'default';
  const nsPath = config.namespacesPath || './namespaces';
  return path.join(nsPath, ns);
}

/**
 * Extract hierarchical prefixes from a key
 * 
 * Example: "/projects/mcp/schema" with depth=2 returns:
 * - "/projects" (depth 1)
 * - "/projects/mcp" (depth 2)
 */
function extractPrefixes(key: string, maxDepth: number): string[] {
  const parts = key.split('/').filter(p => p !== '');
  const prefixes: string[] = [];
  
  for (let i = 1; i <= Math.min(parts.length, maxDepth); i++) {
    prefixes.push('/' + parts.slice(0, i).join('/'));
  }
  
  return prefixes;
}

/**
 * List keys tool handler
 *
 * @param input - Tool input parameters
 * @returns Structured key listing with pagination
 */
export async function listKeysTool(input: unknown): Promise<ListKeysOutput> {
  console.error('[list_keys] Tool called with input:', JSON.stringify(input));
  
  // Validate input
  const parseResult = ListKeysInputSchema.safeParse(input);
  if (!parseResult.success) {
    console.error('[list_keys] Validation failed:', parseResult.error);
    return {
      keys: [],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
      error: `Invalid input: ${(parseResult.error as any).issues.map((i: any) => i.message).join('; ')}`
    };
  }

  const validated = parseResult.data;
  console.error('[list_keys] Validated input:', validated);

  // Resolve namespace path
  const namespacePath = resolveNamespacePath(validated.namespace);

  // Check if namespace exists
  if (!fs.existsSync(namespacePath)) {
    return {
      keys: [],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
      error: `Namespace '${validated.namespace}' does not exist`
    };
  }

  try {
    // Get manifest to find partition paths
    const manifestPath = path.join(namespacePath, 'manifest.json');
    let jsonlFiles: string[] = [];
    
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      // Build explicit file list instead of glob pattern
      for (const p of manifest.partitions) {
        const partitionPath = path.join(namespacePath, p);
        if (!fs.existsSync(partitionPath)) continue;
        
        const files = fs.readdirSync(partitionPath)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => path.join(partitionPath, f).replace(/\\/g, '/'));
        jsonlFiles.push(...files);
      }
    }

    if (jsonlFiles.length === 0) {
      return {
        keys: [],
        hasMore: false,
        nextOffset: null,
        prefixes: {}
      };
    }

    // Get DuckDB connection
    const db = getDuckDBConnection('singleton', namespacePath);

    // Use explicit file list instead of glob
    const fileList = jsonlFiles.map(f => `'${f}'`).join(', ');
    
    // Query distinct keys matching prefix, excluding tombstones
    const sql = `
      SELECT DISTINCT key
      FROM read_json([${fileList}], format='newline_delimited')
      WHERE key LIKE ? || '%' AND action != 'tombstone'
      ORDER BY key
      LIMIT ? OFFSET ?
    `;

    const prefix = validated.prefix.endsWith('/') 
      ? validated.prefix.slice(0, -1) 
      : validated.prefix;
    
    const results = await new Promise<any[]>((resolve, reject) => {
      try {
        const stmt = db.prepare(sql);
        stmt.all(prefix, validated.limit + 1, validated.offset, (err: any, res: any) => {
          if (err) {
            console.error('DuckDB list_keys error:', err);
            reject(err);
          }
          else resolve(res || []);
        });
      } catch (error) {
        console.error('DuckDB list_keys prepare error:', error);
        reject(error);
      }
    });
    
    // Check if there are more results
    const hasMore = results.length > validated.limit;
    if (hasMore) {
      results.pop(); // Remove the extra result used for detection
    }

    // Extract keys
    const keys = results.map((row: any) => row.key);

    // Calculate next offset
    const nextOffset = hasMore ? validated.offset + validated.limit : null;

    // Build prefix counts
    const prefixCounts: Record<string, number> = {};
    for (const key of keys) {
      const prefixes = extractPrefixes(key, validated.maxDepth);
      for (const p of prefixes) {
        prefixCounts[p] = (prefixCounts[p] || 0) + 1;
      }
    }

    return {
      keys,
      hasMore,
      nextOffset,
      prefixes: prefixCounts
    };
  } catch (error) {
    return {
      keys: [],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

/**
 * Tool metadata for MCP registration
 */
export const listKeysToolMetadata = {
  name: 'list_keys',
  title: 'List Memory Keys',
  description: 'Explore hierarchical key structure with pagination',
  inputSchema: ListKeysInputSchema,
  handler: listKeysTool
};

// Export for direct usage
export { ListKeysInputSchema };
