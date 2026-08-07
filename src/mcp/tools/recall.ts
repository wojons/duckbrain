/**
 * Recall MCP Tool
 *
 * Query memories with filters and semantic search.
 * Supports exact key lookup, prefix glob, domain filter, and semantic search.
 */

import { z } from "zod";
import { DomainEnum } from "../../schema/memory";
import { getDuckDBConnection, evictConnection } from "../../duckdb/connection";
import { queryMemories } from "../../duckdb/queries";
import { getPartitionsForDomain } from "../../storage/manifest";
import { resolveNamespacePath } from "./shared";
import { EmbeddingCache } from "../../embedding/cache";
import { createAutoProviders } from "../../embedding/providers";
import type { EmbeddingProvider } from "../../embedding/providers";
import { semanticSearch } from "../../embedding/search";
import path from "path";
import fs from "fs";

/**
 * Input schema for recall tool
 */
const RecallInputSchema = z.object({
  /** Exact key lookup */
  key: z.string().optional().describe("Exact key lookup"),
  /** Exact ID lookup */
  id: z.string().optional().describe("Exact ID lookup"),
  /** Prefix glob query (e.g., /projects/) */
  keyPrefix: z
    .string()
    .optional()
    .describe("Prefix glob query (e.g., /projects/)"),
  /** Domain filter */
  domain: DomainEnum.optional(),
  /** Semantic search query (uses vss extension) */
  query: z
    .string()
    .optional()
    .describe("Semantic search query (uses vss extension)"),
  /** Max results to return */
  limit: z.number().default(10).describe("Max results to return"),
  /** Namespace to query (defaults to current active namespace) */
  namespace: z.string().optional().describe("Namespace to query"),
});

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
 * Resolve namespace path from namespace name using config.
 * Falls back to config's defaultNamespace when no namespace is provided.
 */
/**
 * Recall tool handler
 *
 * @param input - Tool input parameters
 * @returns Query results with memories and count
 */
export async function recallTool(input: unknown): Promise<RecallOutput> {
  console.error("[recall] Tool called with input:", JSON.stringify(input));

  // Validate input
  const parseResult = RecallInputSchema.safeParse(input);
  if (!parseResult.success) {
    console.error("[recall] Validation failed:", parseResult.error);
    return {
      memories: [],
      count: 0,
      error: `Invalid input: ${(parseResult.error as any).issues.map((i: any) => i.message).join("; ")}`,
    };
  }

  const validated = parseResult.data;
  console.error("[recall] Validated input:", validated);

  // Resolve namespace path
  const namespacePath = resolveNamespacePath(validated.namespace);

  // Check if namespace exists
  if (!fs.existsSync(namespacePath)) {
    return {
      memories: [],
      count: 0,
      error: `Namespace '${validated.namespace}' does not exist`,
    };
  }

  try {
    // Get partition paths, filtered by domain if provided
    let partitionPaths: string[];
    if (validated.domain) {
      partitionPaths = getPartitionsForDomain(
        namespacePath,
        validated.domain,
      ).map((p) => path.join(namespacePath, p));
    } else {
      // Get all partitions from manifest
      const manifestPath = path.join(namespacePath, "manifest.json");
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        partitionPaths = manifest.partitions.map((p: string) =>
          path.join(namespacePath, p),
        );
      } else {
        partitionPaths = [];
      }
    }

    // Get DuckDB connection (singleton per namespace — file-backed, avoids Napi::Error)
    const db = getDuckDBConnection("singleton", namespacePath);

    // Build query filters
    const filters: Parameters<typeof queryMemories>[2] = {
      limit: validated.limit,
    };

    if (validated.key) {
      filters.key = validated.key;
    } else if (validated.id) {
      filters.id = validated.id;
    } else if (validated.keyPrefix) {
      filters.keyPrefix = validated.keyPrefix;
    } else if (validated.domain) {
      filters.domain = validated.domain;
    }

    // Handle semantic search (cache-assisted, no vectors in git)
    if (validated.query) {
      // DOGFOOD-002 (a): resolve ALL healthy providers in priority order and
      // fall back on embed failure. Reachability is not usability — LM
      // Studio's /v1/models answers even when the embedding model is unloaded
      // (every embed then 400s), while Ollama on the same host may serve the
      // query fine. Explicit provider config stays a hard requirement (the
      // list has exactly one entry then — no fallback).
      const providers = await createAutoProviders();
      if (providers.length === 0) {
        return {
          memories: [],
          count: 0,
          error:
            "Semantic search requires an embedding provider - start LM Studio/Ollama or set DUCKBRAIN_EMBEDDING_PROVIDER, then run 'duckbrain embeddings rebuild'",
        };
      }

      let queryVector: number[] | null = null;
      const embedErrors: string[] = [];
      // The provider that actually produced the query vector — used for
      // on-the-fly candidate embeds in semanticSearch so a broken first
      // provider (the reason we fell back) is never used for those either.
      let provider: EmbeddingProvider | null = null;
      for (const candidate of providers) {
        try {
          queryVector = await candidate.embed(validated.query);
          if (queryVector.length === 0) {
            // Defensive: providers must reject empty vectors themselves, but
            // never let one through to cosineSimilarity (silent score-0).
            throw new Error(`[${candidate.id}] empty embedding vector`);
          }
          provider = candidate;
          break;
        } catch (e) {
          const msg = `${candidate.id}: ${e instanceof Error ? e.message : String(e)}`;
          embedErrors.push(msg);
          console.error(
            `[recall] Embedding failed on ${candidate.id}, trying next provider: ${msg}`,
          );
        }
      }
      if (!queryVector || !provider) {
        return {
          memories: [],
          count: 0,
          error: `Embedding generation failed: ${embedErrors.join("; ") || "no provider available"}`,
        };
      }

      // Fetch candidates WITHOUT the DuckDB embedding filter (that column
      // doesn't exist in JSONL — vectors live in the gitignored cache).
      const cache = EmbeddingCache.forNamespace(namespacePath);
      const candidateFilters: Parameters<typeof queryMemories>[2] = {
        limit: Math.max(validated.limit * 10, 100),
      };
      if (validated.key) candidateFilters.key = validated.key;
      else if (validated.id) candidateFilters.id = validated.id;
      else if (validated.keyPrefix)
        candidateFilters.keyPrefix = validated.keyPrefix;
      else if (validated.domain) candidateFilters.domain = validated.domain;

      let candidates: Awaited<ReturnType<typeof queryMemories>>;
      try {
        candidates = await queryMemories(db, partitionPaths, candidateFilters);
      } catch (e: any) {
        if (e?.message?.includes("DUCKDB_CONNECTION_LOST")) {
          evictConnection(namespacePath);
          const db2 = getDuckDBConnection("singleton", namespacePath);
          candidates = await queryMemories(
            db2,
            partitionPaths,
            candidateFilters,
          );
        } else {
          throw e;
        }
      }

      const ranked = await semanticSearch(
        candidates,
        queryVector,
        cache,
        provider,
      );
      const top = ranked.slice(0, validated.limit);
      return { memories: top, count: top.length };
    }

    // Execute query — retry once on connection-lost errors (BUG-034 fix).
    // When another process has the DuckDB file open (e.g. MCP daemon),
    // the Node.js binding silently creates a broken Database that fails on
    // first query. Evict the bad entry and retry with a fresh connection.
    let memories: Awaited<ReturnType<typeof queryMemories>>;
    try {
      memories = await queryMemories(db, partitionPaths, filters);
    } catch (e: any) {
      if (e?.message?.includes("DUCKDB_CONNECTION_LOST")) {
        console.error(
          "[recall] Connection lost — evicting cache and retrying...",
        );
        evictConnection(namespacePath);
        const db2 = getDuckDBConnection("singleton", namespacePath);
        memories = await queryMemories(db2, partitionPaths, filters);
      } else {
        throw e;
      }
    }

    return {
      memories,
      count: memories.length,
    };
  } catch (error) {
    return {
      memories: [],
      count: 0,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

/**
 * Tool metadata for MCP registration
 */
export const recallToolMetadata = {
  name: "recall",
  title: "Recall Memories",
  description: "Query memories with filters and semantic search",
  inputSchema: RecallInputSchema,
  handler: recallTool,
};

// Export for direct usage
export { RecallInputSchema };
