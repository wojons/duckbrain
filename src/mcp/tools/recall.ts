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
import { resolveNamespaceName, resolveNamespacePath } from "./shared";
import { EmbeddingCache } from "../../embedding/cache";
import { createAutoProviders } from "../../embedding/providers";
import type { EmbeddingProvider } from "../../embedding/providers";
import { semanticSearch, type RankedMemory } from "../../embedding/search";
import {
  keywordSearch,
  keywordSearchAllNamespaces,
  type KeywordHit,
  type KeywordSearchResult,
} from "../../search/query";
import { getConfig } from "../../config/index";
import { rankFused, FUSION_TOP_K } from "../../search/fusion";
import {
  parseTimeRange,
  type NormalizedTimeRange,
} from "../../utils/timerange";
import {
  resolveAsOfRef,
  readManifestAtRef,
  queryMemoriesAtRef,
} from "../../git/asof";
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
  /** Keyword filter (full-text search over content/key/attributes via the
   *  rebuilt FTS sidecar — offline, no embedding provider needed). Use
   *  EITHER query (hybrid semantic+keyword since RETR-002) or contains
   *  (keyword-only); combining both filters is not supported. */
  contains: z
    .string()
    .optional()
    .describe(
      "Keyword filter: find memories whose content/key/attributes contain these tokens (exact-token matches rank first)",
    ),
  /** Max results to return */
  limit: z.number().default(10).describe("Max results to return"),
  /** Namespace to query (defaults to the ACTIVE namespace — config
   *  defaultNamespace, which switch_namespace persists and is therefore
   *  sticky across processes; see docs/api/mcp-tools.md). Mutually
   *  exclusive with allNamespaces. */
  namespace: z.string().optional().describe("Namespace to query"),
  /** RETR-007: cross-namespace keyword search (Q-4) — with contains=,
   *  union keyword hits over every manifest namespace and return each hit
   *  with a `namespace` facet. Mutually exclusive with namespace, and
   *  meaningless without contains (plain recall stays single-namespace). */
  allNamespaces: z
    .boolean()
    .optional()
    .describe(
      "With contains=: search every namespace and union the keyword hits (each carries a namespace facet)",
    ),
  /** RETR-003: time-scoped recall — include only rows at or after this
   *  ISO-8601 instant (inclusive; date-only values mean the start of that
   *  day, UTC). Matches both the row timestamp and chat-archive key date
   *  facets (/chats/<view>/<YYYY-MM-DD> — those rows' timestamps are
   *  ingestion time while the message date lives in the key). */
  after: z
    .string()
    .optional()
    .describe("ISO-8601 date/datetime: only rows at or after this instant"),
  /** RETR-003: include only rows at or before this ISO-8601 instant
   *  (inclusive; date-only values mean the END of that day, UTC — "until
   *  2026-08-12" includes 2026-08-12 itself). */
  before: z
    .string()
    .optional()
    .describe("ISO-8601 date/datetime: only rows at or before this instant"),
  /** RETR-003: shorthand for after=START&before=END — two comma-separated
   *  ISO-8601 values (e.g. "2026-08-10,2026-08-12"). Mutually exclusive
   *  with after/before. */
  between: z
    .string()
    .optional()
    .describe(
      "ISO-8601 range as START,END — shorthand for after=START and before=END",
    ),
  /** RETR-004: memory-as-of — read the namespace state at this point in git
   *  history. Accepts an ISO-8601 date (resolves to the nearest commit
   *  at-or-before it) or a commit hash/branch/tag. Rows are read straight
   *  from the namespace git history (git show per partition chunk, merged
   *  via the manifest at that ref) — never a checkout or write. Cannot be
   *  combined with query/contains (semantic/keyword search reads the live
   *  FTS/embedding sidecars, which have no historical state). */
  asOf: z
    .string()
    .optional()
    .describe(
      "Date or git ref: read the namespace state as it existed at that point in history",
    ),
  /** RETR-006: attribute filters — include only rows whose `attributes`
   *  JSON contains each name → value (exact match; numeric values match
   *  by their string form, e.g. attr.tick=403 matches both 403 and "403").
   *  ANDed with key/domain/author/time filters. Example: {domain: "config",
   *  tick: "403"}. */
  attr: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Attribute filters: only rows whose attributes match every name→value pair",
    ),
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
    /** Cosine similarity to the query vector — present only on the semantic ?q= path (DOGFOOD-011) */
    score?: number;
    /** Snippet around the first matched token — present only on the keyword contains= path (RETR-001) */
    snippet?: string;
    /** RETR-008: snippet with the matched term(s) wrapped in `<mark>…</mark>`
     *  — rides alongside the raw snippet on keyword contains= hits and
     *  hybrid fused items whose keyword leg found the document. */
    highlightedSnippet?: string;
    /** Source namespace — present on keyword contains= hits (RETR-007);
     *  the searched namespace for single-namespace searches, each hit's
     *  own namespace for all-namespaces unions */
    namespace?: string;
  }>;
  count: number;
  /** True total of matching memories, unlimited by limit/offset (GAP-024) */
  total?: number;
  /** Namespace actually queried — resolved from the arg or the active
   *  (config defaultNamespace) namespace when omitted (DOGFOOD-017) */
  namespace?: string;
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
 * DOGFOOD-011: optional operator knob for the semantic relevance floor —
 * DUCKBRAIN_SEARCH_MIN_SCORE (0..1), same env-override pattern as
 * DUCKBRAIN_EMBEDDING_*. Absent/invalid → undefined, and semanticSearch's
 * own default (DEFAULT_MIN_SCORE = 0.25) applies.
 */
function resolveSearchMinScore(): number | undefined {
  const raw = process.env.DUCKBRAIN_SEARCH_MIN_SCORE;
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return undefined;
  return n;
}

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

/** Parsed recall input shape (used by the semantic-leg helper). */
type RecallInput = z.infer<typeof RecallInputSchema>;

/**
 * Run the SEMANTIC leg of ?q= (RETR-002): fetch the candidate pool from
 * DuckDB (bounded, with the BUG-034 connection-lost retry) and rank it via
 * semanticSearch against the cached/on-the-fly embedding vectors.
 *
 * Shared by the hybrid path (both legs available) and the semantic-only
 * fallback (FTS sidecar missing), so the 0.25 floor (DOGFOOD-011), the
 * DUCKBRAIN_SEARCH_MIN_SCORE knob, the on-the-fly embed cap and the
 * SEMANTIC_TIMEOUT_MS bound behave identically in both modes.
 *
 * @throws with the legacy "Semantic search failed: …" message on any
 *   failure (callers decide whether to surface it or degrade)
 */
async function runSemanticLeg(opts: {
  namespacePath: string;
  validated: RecallInput;
  timeRange: NormalizedTimeRange;
  db: ReturnType<typeof getDuckDBConnection>;
  partitionPaths: string[];
  cache: EmbeddingCache;
  provider: EmbeddingProvider;
  queryVector: number[];
  searchMinScore: number | undefined;
}): Promise<{ ranked: RankedMemory[]; candidatesCount: number }> {
  const {
    namespacePath,
    validated,
    timeRange,
    db,
    partitionPaths,
    cache,
    provider,
    queryVector,
    searchMinScore,
  } = opts;

  // Fetch candidates WITHOUT the DuckDB embedding filter (that column
  // doesn't exist in JSONL — vectors live in the gitignored cache).
  // DOGFOOD-010: the pool is capped (MAX_CANDIDATES) and the whole
  // fetch+rank is bounded by SEMANTIC_TIMEOUT_MS so a big namespace or a
  // cold embedding cache returns a clean error instead of hanging.
  const candidateFilters: Parameters<typeof queryMemories>[2] = {
    limit: Math.min(Math.max(validated.limit * 10, 100), MAX_CANDIDATES),
  };
  if (validated.author) candidateFilters.author = validated.author;
  if (validated.key) candidateFilters.key = validated.key;
  else if (validated.id) candidateFilters.id = validated.id;
  else if (validated.keyPrefix)
    candidateFilters.keyPrefix = validated.keyPrefix;
  else if (validated.domain) candidateFilters.domain = validated.domain;
  // RETR-003: time-scoped recall — the candidate pool itself is windowed so
  // out-of-range rows can never be ranked or fused.
  if (timeRange.after) candidateFilters.after = timeRange.after;
  if (timeRange.before) candidateFilters.before = timeRange.before;
  // RETR-006: attribute filters — the candidate pool is attr-scoped too, so
  // out-of-scope rows can never be ranked or fused.
  if (validated.attr) candidateFilters.attr = validated.attr;

  const result = await withTimeout(
    (async () => {
      let cands: Awaited<ReturnType<typeof queryMemories>>;
      try {
        cands = await queryMemories(db, partitionPaths, candidateFilters);
      } catch (e: any) {
        if (e?.message?.includes("DUCKDB_CONNECTION_LOST")) {
          evictConnection(namespacePath);
          const db2 = getDuckDBConnection("singleton", namespacePath);
          cands = await queryMemories(db2, partitionPaths, candidateFilters);
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
        // DOGFOOD-011: forward the relevance-floor override when set.
        {
          maxOnTheFlyEmbeds: 10,
          ...(searchMinScore !== undefined ? { minScore: searchMinScore } : {}),
        },
      );
      return { cands, rankedRes };
    })(),
    SEMANTIC_TIMEOUT_MS,
    "Semantic search",
  );
  return { ranked: result.rankedRes, candidatesCount: result.cands.length };
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

  // RETR-003: validate + normalize the time-range params up front. Invalid
  // ISO-8601 values (or between= combined with after/before) surface as a
  // clean error payload — never a crash — before any namespace work.
  let timeRange: NormalizedTimeRange;
  try {
    timeRange = parseTimeRange({
      after: validated.after,
      before: validated.before,
      between: validated.between,
    });
  } catch (error) {
    return {
      memories: [],
      count: 0,
      error: `Invalid time filter: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // Resolve namespace path — DOGFOOD-017: the response must echo the
  // namespace ACTUALLY queried (the resolved one, including when the arg
  // was omitted and the active config defaultNamespace was used).
  const resolvedNamespace = resolveNamespaceName(validated.namespace);
  const namespacePath = resolveNamespacePath(resolvedNamespace);

  // Check if namespace exists (skipped for RETR-007 all-namespaces unions —
  // the union enumerates manifest namespaces itself and never needs the
  // default namespace path to exist).
  if (!validated.allNamespaces && !fs.existsSync(namespacePath)) {
    return {
      memories: [],
      count: 0,
      namespace: resolvedNamespace,
      error: `Namespace '${resolvedNamespace}' does not exist`,
    };
  }

  // RETR-004: memory-as-of — resolve the ref up front (a date maps to the
  // nearest commit at-or-before it; hashes/branches/tags are used directly).
  // Invalid input surfaces as a clean error payload, never a crash.
  let asOfRef: string | undefined;
  if (validated.asOf !== undefined) {
    try {
      asOfRef = resolveAsOfRef(validated.asOf, namespacePath);
    } catch (error) {
      return {
        memories: [],
        count: 0,
        namespace: resolvedNamespace,
        error: `Invalid as-of value: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  // RETR-004: the as-of path reads rows straight from git history — it is a
  // pure list path and never runs semantic/keyword search (those read the
  // live FTS/embedding sidecars, which have no state at a past ref).
  if (asOfRef !== undefined) {
    if (validated.query || validated.contains) {
      return {
        memories: [],
        count: 0,
        namespace: resolvedNamespace,
        error:
          "as_of cannot be combined with 'query' or 'contains' — memory-as-of reads the git state at that ref and does not run semantic or keyword search",
      };
    }

    const manifestAtRef = readManifestAtRef(namespacePath, asOfRef);
    if (!manifestAtRef) {
      return {
        memories: [],
        count: 0,
        namespace: resolvedNamespace,
        error: `Namespace '${resolvedNamespace}' has no manifest at ref ${asOfRef.slice(0, 8)} — it did not exist at that point in history`,
      };
    }

    // Same filter shape as the DuckDB list path below (GAP-024: total is the
    // full match count, unlimited by limit).
    const asOfFilters: Parameters<typeof queryMemoriesAtRef>[2] = {
      limit: validated.limit,
    };
    if (validated.author) asOfFilters.author = validated.author;
    if (validated.key) asOfFilters.key = validated.key;
    else if (validated.id) asOfFilters.id = validated.id;
    else if (validated.keyPrefix) asOfFilters.keyPrefix = validated.keyPrefix;
    else if (validated.domain) asOfFilters.domain = validated.domain;
    if (timeRange.after) asOfFilters.after = timeRange.after;
    if (timeRange.before) asOfFilters.before = timeRange.before;
    // RETR-006: attribute filters apply to the as-of row set too (in-memory
    // mirror of the DuckDB json_extract_string conditions).
    if (validated.attr) asOfFilters.attr = validated.attr;

    // GAP-023: limit=0 is a valid empty-page request — count-only.
    if (validated.limit === 0) {
      const { total } = queryMemoriesAtRef(namespacePath, asOfRef, {
        ...asOfFilters,
        limit: undefined,
      });
      return {
        memories: [],
        count: 0,
        total,
        namespace: resolvedNamespace,
      };
    }

    const { memories, total } = queryMemoriesAtRef(
      namespacePath,
      asOfRef,
      asOfFilters,
    );
    return {
      memories,
      count: memories.length,
      total,
      namespace: resolvedNamespace,
    };
  }

  // RETR-007: the union flag only scopes keyword search — without contains
  // it has nothing to union, so the contradiction is loud.
  if (validated.allNamespaces && !validated.contains) {
    return {
      memories: [],
      count: 0,
      namespace: "all",
      error:
        "allNamespaces only applies to keyword search — combine it with 'contains' (plain recall is single-namespace)",
    };
  }

  // RETR-001: keyword filter path (offline — no embedding provider).
  // Runs against the rebuilt FTS sidecar; a missing index surfaces as a
  // clear error telling the operator to rebuild.
  if (validated.contains) {
    if (validated.query) {
      return {
        memories: [],
        count: 0,
        namespace: resolvedNamespace,
        error:
          "Use either 'query' (hybrid semantic+keyword fusion, RETR-002) or 'contains' (keyword-only) — combining both filters is not supported",
      };
    }
    if (validated.allNamespaces && validated.namespace) {
      return {
        memories: [],
        count: 0,
        namespace: "all",
        error:
          "allNamespaces cannot be combined with a specific namespace — omit namespace for a cross-namespace search",
      };
    }
    try {
      const keywordResult = validated.allNamespaces
        ? await keywordSearchAllNamespaces(
            getConfig(".").namespacesPath || "./namespaces",
            validated.contains,
            {
              limit: validated.limit,
              maxCandidates: MAX_CANDIDATES,
              // RETR-003: window the keyword candidate pool too.
              ...(timeRange.after ? { after: timeRange.after } : {}),
              ...(timeRange.before ? { before: timeRange.before } : {}),
              // RETR-006: attr-scope the keyword candidate pool too.
              ...(validated.attr ? { attr: validated.attr } : {}),
            },
          )
        : await keywordSearch(namespacePath, validated.contains, {
            limit: validated.limit,
            maxCandidates: MAX_CANDIDATES,
            // RETR-003: window the keyword candidate pool too.
            ...(timeRange.after ? { after: timeRange.after } : {}),
            ...(timeRange.before ? { before: timeRange.before } : {}),
            // RETR-006: attr-scope the keyword candidate pool too.
            ...(validated.attr ? { attr: validated.attr } : {}),
          });
      return {
        memories: keywordResult.memories,
        count: keywordResult.memories.length,
        // GAP-024: total = the full ranked match set (bounded by
        // MAX_CANDIDATES), unlimited by limit/offset.
        total: keywordResult.total,
        namespace: validated.allNamespaces ? "all" : resolvedNamespace,
      };
    } catch (error) {
      return {
        memories: [],
        count: 0,
        namespace: validated.allNamespaces ? "all" : resolvedNamespace,
        error: `Keyword search failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      };
    }
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

    // RETR-003: time-scoped recall — timestamp (and chat-archive key facet)
    // bounds on the list path, shared by queryMemories and countMemories so
    // the reported total always matches the returned window.
    if (timeRange.after) filters.after = timeRange.after;
    if (timeRange.before) filters.before = timeRange.before;

    // RETR-006: attribute filters on the list path — shared by
    // queryMemories and countMemories so the reported total always matches
    // the returned window.
    if (validated.attr) filters.attr = validated.attr;

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
      return { memories: [], count: 0, total, namespace: resolvedNamespace };
    }

    // Handle semantic search (cache-assisted, no vectors in git). RETR-002:
    // ?q= is HYBRID by default — the keyword leg (rebuilt FTS sidecar) runs
    // alongside the semantic leg and both are fused via Reciprocal Rank
    // Fusion (src/search/fusion.ts: rrf_k=60, per-retriever top-k=20,
    // recency tiebreak). Fallback ladder:
    //   both legs available        → hybrid (fused scores)
    //   keyword leg unavailable    → semantic-only (unchanged behavior +
    //                                cosine scores — regression-safe)
    //   semantic leg unavailable   → keyword-only (offline)
    //   both unavailable           → the semantic leg's error (legacy
    //                                DOGFOOD-001/002 contract — ?q= never
    //                                silently returns an unfiltered list)
    if (validated.query) {
      // ---- Semantic leg availability: providers + query vector. ----
      // DOGFOOD-002 (a): resolve ALL healthy providers in priority order and
      // fall back on embed failure. Reachability is not usability — LM
      // Studio's /v1/models answers even when the embedding model is unloaded
      // (every embed then 400s), while Ollama on the same host may serve the
      // query fine. Explicit provider config stays a hard requirement (the
      // list has exactly one entry then — no fallback).
      const providers = await createAutoProviders();
      let queryVector: number[] | null = null;
      const embedErrors: string[] = [];
      // The provider that actually produced the query vector — used for
      // on-the-fly candidate embeds in semanticSearch so a broken first
      // provider (the reason we fell back) is never used for those either.
      let provider: EmbeddingProvider | null = null;
      // Legacy semantic error, surfaced ONLY when the keyword leg is also
      // unavailable (both-fail contract, DOGFOOD-001/002).
      let semanticError: string | null = null;
      if (providers.length === 0) {
        semanticError =
          "Semantic search requires an embedding provider - start LM Studio/Ollama or set DUCKBRAIN_EMBEDDING_PROVIDER, then run 'duckbrain embeddings rebuild'";
      } else {
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
          semanticError = `Embedding generation failed: ${embedErrors.join("; ") || "no provider available"}`;
        }
      }

      // ---- Keyword leg: rebuilt FTS sidecar (RETR-001). A missing index is
      // NOT an error here — ?q= degrades to semantic-only; the failure is
      // only surfaced when BOTH legs are unavailable.
      let keywordResult: KeywordSearchResult | null = null;
      try {
        keywordResult = await keywordSearch(namespacePath, validated.query, {
          // Fetch at least the fusion top-k; rankFused uses only its top 20,
          // and the keyword-only fallback below slices to the requested limit.
          limit: Math.max(FUSION_TOP_K, validated.limit),
          maxCandidates: MAX_CANDIDATES,
          // RETR-003: window the keyword leg so fusion can never surface
          // out-of-range rows.
          ...(timeRange.after ? { after: timeRange.after } : {}),
          ...(timeRange.before ? { before: timeRange.before } : {}),
          // RETR-006: attr-scope the keyword leg so fusion can never
          // surface out-of-scope rows.
          ...(validated.attr ? { attr: validated.attr } : {}),
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(
          "[recall] Keyword leg unavailable for hybrid — degrading:",
          msg,
        );
      }

      // DOGFOOD-011: resolve the relevance-floor override once (absent →
      // semanticSearch's DEFAULT_MIN_SCORE = 0.25 applies inside). Applies
      // to the semantic leg in BOTH hybrid and semantic-only modes.
      const searchMinScore = resolveSearchMinScore();

      // ---- HYBRID: both legs available → RRF fusion. ----
      if (queryVector && provider && keywordResult) {
        const cache = EmbeddingCache.forNamespace(namespacePath);
        let semanticRanked: RankedMemory[];
        try {
          const leg = await runSemanticLeg({
            namespacePath,
            validated,
            timeRange,
            db,
            partitionPaths,
            cache,
            provider,
            queryVector,
            searchMinScore,
          });
          semanticRanked = leg.ranked;
        } catch (e: any) {
          // Semantic leg failed (timeout / embed crash) but the keyword leg
          // works — degrade to keyword-only instead of failing the request.
          const msg = e instanceof Error ? e.message : String(e);
          console.error(
            "[recall] Semantic leg failed in hybrid mode — degrading to keyword-only:",
            msg,
          );
          const top = keywordResult.memories.slice(0, validated.limit);
          return {
            memories: top,
            count: top.length,
            total: keywordResult.total,
            namespace: resolvedNamespace,
          };
        }

        // Fusion takes each retriever's own ranking order; rankFused caps
        // each at FUSION_TOP_K and applies the recency tiebreak.
        const fused = rankFused<RankedMemory | KeywordHit>([
          semanticRanked.slice(0, FUSION_TOP_K),
          keywordResult.memories.slice(0, FUSION_TOP_K),
        ]);
        const keywordById = new Map(
          keywordResult.memories.map((m) => [m.id, m]),
        );
        const top = fused.slice(0, validated.limit).map(({ item, score }) => {
          const kw = keywordById.get(item.id);
          return {
            ...item,
            // RETR-001: the keyword leg's snippet rides along when it found
            // the document (absent for semantic-only candidates).
            ...(kw && kw.snippet !== undefined ? { snippet: kw.snippet } : {}),
            // RETR-008: the highlighted display form rides along with it.
            ...(kw && kw.highlightedSnippet !== undefined
              ? { highlightedSnippet: kw.highlightedSnippet }
              : {}),
            // RETR-002: fused RRF score (normalized 0..1) — NOT the raw
            // cosine similarity or BM25 score.
            score,
          };
        });
        return {
          memories: top,
          count: top.length,
          // GAP-024: the fused candidate pool — the union of both legs'
          // top-k contributions (≤ 2 × FUSION_TOP_K).
          total: fused.length,
          namespace: resolvedNamespace,
        };
      }

      // ---- SEMANTIC-ONLY: keyword leg unavailable — unchanged behavior and
      // score shape (cosine similarity, 0.25 floor, candidates-pool total).
      if (queryVector && provider) {
        const cache = EmbeddingCache.forNamespace(namespacePath);
        let leg: { ranked: RankedMemory[]; candidatesCount: number };
        try {
          leg = await runSemanticLeg({
            namespacePath,
            validated,
            timeRange,
            db,
            partitionPaths,
            cache,
            provider,
            queryVector,
            searchMinScore,
          });
        } catch (e: any) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[recall] Semantic search failed:", msg);
          return {
            memories: [],
            count: 0,
            namespace: resolvedNamespace,
            error: `Semantic search failed: ${msg}`,
          };
        }

        const top = leg.ranked.slice(0, validated.limit);
        // GAP-024: for ?q=, total reflects the candidate pool the semantic
        // search actually ranked (bounded by max(limit*10, 100)), not the
        // full namespace count — semantic results are ranked, not enumerated.
        return {
          memories: top,
          count: top.length,
          total: leg.candidatesCount,
          namespace: resolvedNamespace,
        };
      }

      // ---- KEYWORD-ONLY: embeddings unavailable (no providers / embed
      // failure) but the FTS sidecar works — offline fallback (RETR-002).
      if (keywordResult) {
        const top = keywordResult.memories.slice(0, validated.limit);
        return {
          memories: top,
          count: top.length,
          // GAP-024: the full ranked keyword match set (bounded by
          // MAX_CANDIDATES), unlimited by limit.
          total: keywordResult.total,
          namespace: resolvedNamespace,
        };
      }

      // ---- Both legs unavailable: surface the semantic leg's error
      // (DOGFOOD-001/002 legacy contract) so ?q= never silently returns an
      // unfiltered list.
      return {
        memories: [],
        count: 0,
        namespace: resolvedNamespace,
        error:
          semanticError ??
          "Search failed: neither the semantic nor the keyword search backend is available",
      };
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
      namespace: resolvedNamespace,
    };
  } catch (error) {
    return {
      memories: [],
      count: 0,
      namespace: resolvedNamespace,
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
