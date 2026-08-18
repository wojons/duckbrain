/**
 * Search MCP-style tool (RETR-001).
 *
 * Keyword full-text search over a namespace's rebuilt FTS sidecar. This
 * is the CLI-facing wrapper for `duckbrain search`; the MCP server itself
 * exposes keyword search through the `recall` tool's `contains` param
 * (recall.ts). Pure offline — no embedding provider required.
 */

import { z } from "zod";
import fs from "fs";
import {
  keywordSearch,
  MAX_KEYWORD_CANDIDATES,
  type KeywordHit,
} from "../../search/query";
import { resolveNamespaceName, resolveNamespacePath } from "./shared";

const SearchInputSchema = z.object({
  /** Keyword query — tokens must appear in content/key/attributes */
  query: z.string().min(1).describe("Keyword search query (full-text)"),
  /** Namespace to search (defaults to the ACTIVE namespace) */
  namespace: z.string().optional().describe("Namespace to search"),
  /** Max results to return */
  limit: z.number().default(10).describe("Max results to return"),
});

export interface SearchOutput {
  memories: KeywordHit[];
  count: number;
  /** True total of matches, unlimited by limit (bounded by the candidate cap) */
  total: number;
  /** Namespace actually searched (resolved, including when omitted) */
  namespace: string;
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
  const resolvedNamespace = resolveNamespaceName(validated.namespace);
  const namespacePath = resolveNamespacePath(resolvedNamespace);

  if (!fs.existsSync(namespacePath)) {
    return {
      memories: [],
      count: 0,
      total: 0,
      namespace: resolvedNamespace,
      error: `Namespace '${resolvedNamespace}' does not exist`,
    };
  }

  try {
    const result = await keywordSearch(namespacePath, validated.query, {
      limit: validated.limit,
      maxCandidates: MAX_KEYWORD_CANDIDATES,
    });
    return {
      memories: result.memories,
      count: result.memories.length,
      total: result.total,
      namespace: resolvedNamespace,
    };
  } catch (error) {
    return {
      memories: [],
      count: 0,
      total: 0,
      namespace: resolvedNamespace,
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
