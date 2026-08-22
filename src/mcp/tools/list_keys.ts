/**
 * List Keys MCP Tool
 *
 * Explore hierarchical key structure with pagination and depth limits.
 * Guardrail tool to prevent AI path hallucinations.
 */

import { z } from "zod";
import { getDuckDBConnection, evictConnection } from "../../duckdb/connection";
import { resolveNamespacePath } from "./shared";
import path from "path";
import fs from "fs";

/**
 * Input schema for list_keys tool
 */
const ListKeysInputSchema = z.object({
  /** Key prefix to filter (e.g., /projects/) */
  prefix: z
    .string()
    .optional()
    .default("/")
    .describe("Key prefix to filter (e.g., /projects/)"),
  /** Max hierarchy depth to return */
  maxDepth: z.number().default(3).describe("Max hierarchy depth to return"),
  /** Max keys to return */
  limit: z.number().default(50).describe("Max keys to return"),
  /** Pagination offset */
  offset: z.number().default(0).describe("Pagination offset"),
  /** Namespace to query (defaults to current active namespace) */
  namespace: z.string().optional().describe("Namespace to query"),
});

/** Zod-inferred validated input shape (shared by tool and health probe). */
type ValidatedListKeysInput = z.infer<typeof ListKeysInputSchema>;

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
/**
 * Extract hierarchical prefixes from a key
 *
 * Example: "/projects/mcp/schema" with depth=2 returns:
 * - "/projects" (depth 1)
 * - "/projects/mcp" (depth 2)
 */
function extractPrefixes(key: string, maxDepth: number): string[] {
  const parts = key.split("/").filter((p) => p !== "");
  const prefixes: string[] = [];

  for (let i = 1; i <= Math.min(parts.length, maxDepth); i++) {
    prefixes.push("/" + parts.slice(0, i).join("/"));
  }

  return prefixes;
}

/**
 * Core keys query shared by listKeysTool and the /health keys probe
 * (DB-GAP-035).
 *
 * Runs the RESILIENT read: read_json with ignore_errors=true, so one
 * malformed/torn JSONL line is skipped (NULL row, filtered out by the
 * WHERE clause) instead of aborting the whole query with a DuckDB
 * InvalidInputException that 500s every keys consumer.
 *
 * Throws on failure; callers decide how to surface the error.
 */
async function runKeysQuery(validated: ValidatedListKeysInput): Promise<{
  keys: string[];
  hasMore: boolean;
  nextOffset: number | null;
  prefixes: Record<string, number>;
}> {
  // Resolve namespace path
  const namespacePath = resolveNamespacePath(validated.namespace);

  // Check if namespace exists
  if (!fs.existsSync(namespacePath)) {
    throw new Error(`Namespace '${validated.namespace}' does not exist`);
  }

  // Get manifest to find partition paths
  const manifestPath = path.join(namespacePath, "manifest.json");
  let jsonlFiles: string[] = [];

  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    // Build explicit file list instead of glob pattern
    for (const p of manifest.partitions) {
      const partitionPath = path.join(namespacePath, p);
      if (!fs.existsSync(partitionPath)) continue;

      const files = fs
        .readdirSync(partitionPath)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => path.join(partitionPath, f).replace(/\\/g, "/"));
      jsonlFiles.push(...files);
    }
  }

  if (jsonlFiles.length === 0) {
    return {
      keys: [],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
    };
  }

  // Get DuckDB connection
  const db = getDuckDBConnection("singleton", namespacePath);

  // Use explicit file list instead of glob
  const fileList = jsonlFiles.map((f) => `'${f}'`).join(", ");

  // RETR-005: recency-aware listing — distinct keys ordered by their
  // NEWEST live record (timestamp DESC), so recently-touched keys surface
  // first on the glob/prefix surface (previously alphabetical-insertion
  // order). try_cast parses the mixed corpus timestamp formats as
  // instants (same approach as queries.ts DEFAULT_ORDER_BY); NULLS LAST
  // keeps unparseable rows at the bottom; key ASC is the deterministic
  // final tiebreak. The hierarchical tree renderers re-sort alphabetically
  // anyway — this only affects the raw flat order and pagination.
  //
  // ignore_errors=true (DB-GAP-035): a single malformed line must never
  // abort the whole read — DuckDB skips it (NULL row) and the WHERE clause
  // below filters NULL keys out.
  const sql = `
    SELECT key
    FROM (
      SELECT key, MAX(try_cast(timestamp AS TIMESTAMP)) AS __latest
      FROM read_json([${fileList}], format='newline_delimited', ignore_errors=true)
      WHERE key LIKE ? || '%' AND action != 'tombstone'
      GROUP BY key
    ) sub
    ORDER BY __latest DESC NULLS LAST, key ASC
    LIMIT ? OFFSET ?
  `;

  const prefix = validated.prefix.endsWith("/")
    ? validated.prefix.slice(0, -1)
    : validated.prefix;

  const executeQuery = (dbInstance: any) =>
    new Promise<any[]>((resolve, reject) => {
      try {
        const stmt = dbInstance.prepare(sql);
        stmt.all(
          prefix,
          validated.limit + 1,
          validated.offset,
          (err: any, res: any) => {
            if (err) {
              const errMsg = err?.message || String(err);
              if (
                /connection.*never established|closed already|locked/i.test(
                  errMsg,
                )
              ) {
                reject(new Error(`DUCKDB_CONNECTION_LOST: ${errMsg}`));
              } else {
                reject(err);
              }
            } else resolve(res || []);
          },
        );
      } catch (error) {
        reject(error);
      }
    });

  // Execute with retry on connection-lost (BUG-034 fix)
  let results: any[];
  try {
    results = await executeQuery(db);
  } catch (e: any) {
    if (e?.message?.includes("DUCKDB_CONNECTION_LOST")) {
      console.error(
        "[list_keys] Connection lost — evicting cache and retrying...",
      );
      evictConnection(namespacePath);
      const db2 = getDuckDBConnection("singleton", namespacePath);
      results = await executeQuery(db2);
    } else {
      throw e;
    }
  }

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
    prefixes: prefixCounts,
  };
}

/**
 * List keys tool handler
 *
 * @param input - Tool input parameters
 * @returns Structured key listing with pagination
 */
export async function listKeysTool(input: unknown): Promise<ListKeysOutput> {
  console.error("[list_keys] Tool called with input:", JSON.stringify(input));

  // Validate input
  const parseResult = ListKeysInputSchema.safeParse(input);
  if (!parseResult.success) {
    console.error("[list_keys] Validation failed:", parseResult.error);
    return {
      keys: [],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
      error: `Invalid input: ${(parseResult.error as any).issues.map((i: any) => i.message).join("; ")}`,
    };
  }

  const validated = parseResult.data;
  console.error("[list_keys] Validated input:", validated);

  try {
    return await runKeysQuery(validated);
  } catch (error) {
    return {
      keys: [],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

/**
 * Keys-store health probe for GET /health (DB-GAP-035).
 *
 * Runs the same resilient keys query as list_keys (limit 1) against the
 * active namespace and returns null when the store answers, or a short
 * error string when the probe fails (corrupt store, missing namespace,
 * connection loss — anything that would break the keys read path).
 * Quiet by design: health monitors poll frequently, so the probe does not
 * log (listKeysTool's console.error noise is MCP-call-only).
 */
export async function probeKeysStore(
  namespace?: string,
): Promise<string | null> {
  try {
    await runKeysQuery({
      prefix: "/",
      maxDepth: 1,
      limit: 1,
      offset: 0,
      namespace,
    });
    return null;
  } catch (error) {
    return (error instanceof Error ? error.message : String(error)).slice(
      0,
      200,
    );
  }
}

/**
 * Tool metadata for MCP registration
 */
export const listKeysToolMetadata = {
  name: "list_keys",
  title: "List Memory Keys",
  description: "Explore hierarchical key structure with pagination",
  inputSchema: ListKeysInputSchema,
  handler: listKeysTool,
};

// Export for direct usage
export { ListKeysInputSchema };
