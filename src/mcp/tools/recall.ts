/**
 * Recall MCP Tool
 *
 * Query memories with filters and semantic search.
 * Supports exact key lookup, prefix glob, domain filter, and semantic search.
 */

import { z } from "zod";
import { DomainEnum } from "../../schema/memory";
import { getDuckDBConnection, evictConnection } from "../../duckdb/connection";
import { queryMemories, countMemories } from "../../duckdb/queries";
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
  /** Exact author filter */
  author: z.string().optional().describe("Exact author filter"),
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
  /** True total of matching memories, unlimited by limit/offset (GAP-024) */
  total?: number;
  error?: string;
}

/**
 * Resolve namespace path from namespace name using config.
 * Falls back to config's defaultNamespace when no namespace is provided.
 */
/**
 * DOGFOOD-010: the semantic candidate pool is capped so one request can never
 * force a multi-thousand-row read (the HTTP route caps limit at 1000, which
 * would otherwise scale the candidate fetch to 10,010 rows).
 */
const MAX_CANDIDATES = 1000;

/**
 * DOGFOOD-010: the semantic path (candidate fetch + on-the-fly embedding of
 * cache misses) must be bounded — on a cold cache every candidate embed can
 * take seconds, and 50 of them sequentially can exceed 60s. A bounded request
 * returns a clean error instead of hanging the daemon.
 */
const SEMANTIC_TIMEOUT_MS = 30_000;

/**
 * Race a promise against a deadline. On timeout the caller receives a clean
 * Error instead of waiting indefinitely; the underlying DuckDB query (if any)
 * is a native async task that finishes on its own and is ignored.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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

    if (validated.author) {
      filters.author = validated.author;
    }

    if (validated.key) {
      filters.key = validated.key;
    } else if (validated.id) {
      filters.id = validated.id;
    } else if (validated.keyPrefix) {
      filters.keyPrefix = validated.keyPrefix;
    } else if (validated.domain) {
      filters.domain = validated.domain;
    }

    // GAP-023/GAP-024: limit=0 is a valid "empty page" request — no rows are
    // fetched, but the true total is still reported. A zero limit must never
    // reach queryMemories (a falsy 0 would previously omit the LIMIT clause
    // and scan every row), so count-only is handled here before any data
    // query.
    if (validated.limit === 0) {
      let total: number;
      try {
        total = await countMemories(db, partitionPaths, filters);
      } catch (e: any) {
        if (e?.message?.includes("DUCKDB_CONNECTION_LOST")) {
          evictConnection(namespacePath);
          const db2 = getDuckDBConnection("singleton", namespacePath);
          total = await countMemories(db2, partitionPaths, filters);
        } else {
          throw e;
        }
      }
      return { memories: [], count: 0, total };
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
      // DOGFOOD-010: the pool is capped (MAX_CANDIDATES) and the whole
      // fetch+rank is bounded by SEMANTIC_TIMEOUT_MS so a big namespace or a
      // cold embedding cache returns a clean error instead of hanging.
      const cache = EmbeddingCache.forNamespace(namespacePath);
      const candidateFilters: Parameters<typeof queryMemories>[2] = {
        limit: Math.min(Math.max(validated.limit * 10, 100), MAX_CANDIDATES),
      };
      if (validated.author) candidateFilters.author = validated.author;
      if (validated.key) candidateFilters.key = validated.key;
      else if (validated.id) candidateFilters.id = validated.id;
      else if (validated.keyPrefix)
        candidateFilters.keyPrefix = validated.keyPrefix;
      else if (validated.domain) candidateFilters.domain = validated.domain;

      let candidates: Awaited<ReturnType<typeof queryMemories>>;
      let ranked: Awaited<ReturnType<typeof semanticSearch>>;
      try {
        const result = await withTimeout(
          (async () => {
            let cands: Awaited<ReturnType<typeof queryMemories>>;
            try {
              cands = await queryMemories(db, partitionPaths, candidateFilters);
            } catch (e: any) {
              if (e?.message?.includes("DUCKDB_CONNECTION_LOST")) {
                evictConnection(namespacePath);
                const db2 = getDuckDBConnection("singleton", namespacePath);
                cands = await queryMemories(
                  db2,
                  partitionPaths,
                  candidateFilters,
                );
              } else {
                throw e;
              }
            }
            const rankedRes = await semanticSearch(
              cands,
              queryVector,
              cache,
              provider,
              // DOGFOOD-010: bound on-the-fly embedding of cache misses.
              // Each embed can take seconds (LM Studio ~2s on this host), so
              // the default 50 would exceed the 30s budget on a cold cache.
              // 10 keeps a cold-cache ?q= inside the timeout with real ranked
              // results; warm caches rank the full candidate pool instantly.
              { maxOnTheFlyEmbeds: 10 },
            );
            return { cands, rankedRes };
          })(),
          SEMANTIC_TIMEOUT_MS,
          "Semantic search",
        );
        candidates = result.cands;
        ranked = result.rankedRes;
      } catch (e: any) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[recall] Semantic search failed:", msg);
        return {
          memories: [],
          count: 0,
          error: `Semantic search failed: ${msg}`,
        };
      }

      const top = ranked.slice(0, validated.limit);
      // GAP-024: for ?q=, total reflects the candidate pool the semantic
      // search actually ranked (bounded by max(limit*10, 100)), not the full
      // namespace count — semantic results are ranked, not enumerated.
      return { memories: top, count: top.length, total: candidates.length };
    }

    // Execute query — retry once on connection-lost errors (BUG-034 fix).
    // When another process has the DuckDB file open (e.g. MCP daemon),
    // the Node.js binding silently creates a broken Database that fails on
    // first query. Evict the bad entry and retry with a fresh connection.
    let memories: Awaited<ReturnType<typeof queryMemories>>;
    let total: number;
    try {
      memories = await queryMemories(db, partitionPaths, filters);
      // GAP-024: true COUNT(*) of all rows matching the active filters,
      // unlimited by limit/offset.
      total = await countMemories(db, partitionPaths, filters);
    } catch (e: any) {
      if (e?.message?.includes("DUCKDB_CONNECTION_LOST")) {
        console.error(
          "[recall] Connection lost — evicting cache and retrying...",
        );
        evictConnection(namespacePath);
        const db2 = getDuckDBConnection("singleton", namespacePath);
        memories = await queryMemories(db2, partitionPaths, filters);
        total = await countMemories(db2, partitionPaths, filters);
      } else {
        throw e;
      }
    }

    return {
      memories,
      count: memories.length,
      total,
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
