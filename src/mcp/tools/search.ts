/**
 * Search MCP-style tool (RETR-001).
 *
 * Keyword full-text search over a namespace's rebuilt FTS sidecar. This
 * is the CLI-facing wrapper for `duckbrain search`; the MCP server itself
 * exposes search through the `recall` tool (`query` = HYBRID
 * semantic+keyword since RETR-002, `contains` = keyword-only). This tool
 * deliberately stays keyword-only: `duckbrain search` is the offline
 * keyword surface and requires the rebuilt index (a missing index must
 * error, not silently degrade to semantic results). Pure offline — no
 * embedding provider required.
 */

import { z } from "zod";
import fs from "fs";
import {
  keywordSearch,
  keywordSearchAllNamespaces,
  MAX_KEYWORD_CANDIDATES,
  type KeywordHit,
} from "../../search/query";
import { getConfig } from "../../config/index";
import { resolveNamespaceName, resolveNamespacePath } from "./shared";

const SearchInputSchema = z.object({
  /** Keyword query — tokens must appear in content/key/attributes */
  query: z.string().min(1).describe("Keyword search query (full-text)"),
  /** Namespace to search (defaults to the ACTIVE namespace). Mutually
   *  exclusive with allNamespaces. */
  namespace: z.string().optional().describe("Namespace to search"),
  /** Max results to return */
  limit: z.number().default(10).describe("Max results to return"),
  /** RETR-007: search every manifest namespace and union the ranked hits.
   *  Results carry a `namespace` facet identifying each hit's source.
   *  Mutually exclusive with namespace. */
  allNamespaces: z
    .boolean()
    .optional()
    .describe(
      "Cross-namespace search: union keyword hits over every namespace with a rebuilt index",
    ),
});

export interface SearchOutput {
  memories: KeywordHit[];
  count: number;
  /** True total of matches, unlimited by limit (bounded by the candidate cap) */
  total: number;
  /** Namespace actually searched (resolved, including when omitted); "all"
   *  for an all-namespaces union */
  namespace: string;
  /** RETR-007: namespaces that contributed candidates (all-namespaces union) */
  namespacesSearched?: string[];
  /** RETR-007: namespaces skipped — no rebuilt index (all-namespaces union) */
  namespacesSkipped?: string[];
  error?: string;
}

/**
 * Search tool handler.
 *
 * @param input - Tool input parameters
 * @returns Keyword matches with snippets
 */
export async function searchTool(input: unknown): Promise<SearchOutput> {
  const parseResult = SearchInputSchema.safeParse(input);
  if (!parseResult.success) {
    return {
      memories: [],
      count: 0,
      total: 0,
      namespace: resolveNamespaceName(),
      error: `Invalid input: ${(parseResult.error as any).issues
        .map((i: any) => i.message)
        .join("; ")}`,
    };
  }

  const validated = parseResult.data;

  // RETR-007: cross-namespace union — namespace is mutually exclusive with
  // the union flag (loud error, mirroring recall's query+contains rule).
  if (validated.allNamespaces && validated.namespace) {
    return {
      memories: [],
      count: 0,
      total: 0,
      namespace: "all",
      error:
        "allNamespaces cannot be combined with a specific namespace — omit namespace for a cross-namespace search",
    };
  }

  const resolvedNamespace = resolveNamespaceName(validated.namespace);
  const namespacePath = resolveNamespacePath(validated.namespace);

  if (!validated.allNamespaces && !fs.existsSync(namespacePath)) {
    return {
      memories: [],
      count: 0,
      total: 0,
      namespace: resolvedNamespace,
      error: `Namespace '${resolvedNamespace}' does not exist`,
    };
  }

  try {
    const result = validated.allNamespaces
      ? await keywordSearchAllNamespaces(
          getConfig(".").namespacesPath || "./namespaces",
          validated.query,
          {
            limit: validated.limit,
            maxCandidates: MAX_KEYWORD_CANDIDATES,
          },
        )
      : await keywordSearch(namespacePath, validated.query, {
          limit: validated.limit,
          maxCandidates: MAX_KEYWORD_CANDIDATES,
        });
    return {
      memories: result.memories,
      count: result.memories.length,
      total: result.total,
      namespace: validated.allNamespaces ? "all" : resolvedNamespace,
      ...(result.namespacesSearched
        ? { namespacesSearched: result.namespacesSearched }
        : {}),
      ...(result.namespacesSkipped
        ? { namespacesSkipped: result.namespacesSkipped }
        : {}),
    };
  } catch (error) {
    return {
      memories: [],
      count: 0,
      total: 0,
      namespace: validated.allNamespaces ? "all" : resolvedNamespace,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

/** Tool metadata — exported for parity with recallToolMetadata (not yet
 *  registered in the MCP server; recall's `contains` param is the MCP
 *  surface for RETR-001). */
export const searchToolMetadata = {
  name: "search",
  title: "Keyword Search Memories",
  description:
    "Full-text keyword search over memories (offline, no embedding provider needed)",
  inputSchema: SearchInputSchema,
  handler: searchTool,
};

// Export for direct usage
export { SearchInputSchema };
