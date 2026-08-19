/**
 * Memory API Routes
 *
 * Express routes that wrap MCP tool functions (recallTool, rememberTool, forgetTool)
 * per the centralized architecture pattern. All data flows through existing MCP tools.
 */

import { Router, Request, Response } from "express";
import { recallTool } from "../../mcp/tools/recall";
import { rememberTool } from "../../mcp/tools/remember";
import { forgetTool } from "../../mcp/tools/forget";
import {
  asyncHandler,
  ApiError,
  NotFoundError,
  ValidationError,
} from "../middleware/errorHandler";
import { DomainEnum } from "../../schema/memory";
import { normalizeAttributes } from "../../utils/serialize";
import {
  MemoryResponse,
  MemoryListResponse,
  CreateMemoryRequest,
  UpdateMemoryRequest,
  QueryParams,
} from "../types/api";
import {
  parseTimeRange,
  type NormalizedTimeRange,
} from "../../utils/timerange";
import { resolveAsOfRef } from "../../git/asof";
import { resolveNamespacePath } from "../../mcp/tools/shared";
import {
  getPrincipal,
  principalAuthorEmail,
  requireNamespaceGrant,
} from "../../auth/middleware";

const router: Router = Router();

// DB-GAP-031: enforce per-token namespace grants on every namespace-scoped
// memory route (read, write, update, delete). The namespace resolution
// mirrors each route's own (query param, falling back to body.namespace for
// writes, else "default"). Passes through untouched in auth=none mode and
// for unrestricted tokens.
router.use(
  requireNamespaceGrant(
    (req) =>
      (req.query.namespace as string) ||
      (req.body as { namespace?: string } | undefined)?.namespace ||
      "default",
  ),
);

// GAP-023: upper bound on a single page so one request can never force a
// multi-hundred-MB response, regardless of how many rows match.
const MAX_LIMIT = 1000;

/**
 * Parse and validate the ?limit= query parameter (GAP-023).
 *
 * Rejects negative and non-numeric values with 400 VALIDATION_ERROR, caps
 * positive values at MAX_LIMIT, treats 0 as a valid empty-page request, and
 * keeps the default of 50 when the parameter is absent.
 */
function parseLimit(raw: unknown): number {
  if (raw === undefined) {
    return 50;
  }
  const parsed = parseInt(raw as string, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new ValidationError("limit must be a non-negative integer");
  }
  return Math.min(parsed, MAX_LIMIT);
}

/**
 * Transform MCP memory to API response format
 */
function transformMemory(memory: any): MemoryResponse {
  return {
    id: memory.id,
    key: memory.key,
    domain: memory.domain,
    content: memory.embedding_text,
    attributes: memory.attributes || {},
    timestamp: memory.timestamp,
    author: memory.author,
    isTombstone: memory.action === "tombstone",
    action: memory.action,
    // DOGFOOD-011: semantic ?q= results carry their similarity score; the
    // plain list path has no score and must not fabricate one.
    ...(typeof memory.score === "number" ? { score: memory.score } : {}),
    // RETR-001: keyword ?contains= results carry a snippet around the
    // first matched token; other paths have none.
    ...(typeof memory.snippet === "string" ? { snippet: memory.snippet } : {}),
    // RETR-008: the highlighted display form rides alongside the raw
    // snippet on keyword ?contains= responses.
    ...(typeof memory.highlightedSnippet === "string"
      ? { highlightedSnippet: memory.highlightedSnippet }
      : {}),
    // RETR-007: keyword hits carry their source namespace (single-namespace
    // requests: the searched namespace; ?allNamespaces=true unions: each
    // hit's own).
    ...(typeof memory.namespace === "string"
      ? { namespace: memory.namespace }
      : {}),
  };
}

/**
 * GET /api/memories
 * Query memories with filters
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const params: QueryParams = {
      prefix: req.query.prefix as string | undefined,
      // GAP-023: validated — rejects negative/non-numeric with 400
      // VALIDATION_ERROR, caps at MAX_LIMIT, 0 = valid empty page.
      limit: parseLimit(req.query.limit),
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : 0,
      domain: req.query.domain as string | undefined,
      author: req.query.author as string | undefined,
      query: req.query.q as string | undefined,
      // RETR-001: keyword filter — full-text search over content/key/
      // attributes via the rebuilt FTS sidecar (offline).
      contains: req.query.contains as string | undefined,
      // RETR-007: cross-namespace keyword search — ?allNamespaces=true unions
      // keyword hits over every manifest namespace.
      allNamespaces: req.query.allNamespaces === "true",
      // RETR-003: time-scoped recall — ISO-8601 bounds (validated below so
      // invalid dates surface as a clean 400, not a recallTool 500).
      after: req.query.after as string | undefined,
      before: req.query.before as string | undefined,
      between: req.query.between as string | undefined,
      // RETR-004: memory-as-of — git ref or ISO-8601 date (validated below
      // so invalid values surface as a clean 400, not a recallTool 500).
      as_of: req.query.as_of as string | undefined,
      namespace: (req.query.namespace as string) || "default",
    };

    // RETR-006: attribute filters — every ?attr.<name>=<value> query param
    // (prefix-stripped) becomes one name→value filter. Only string-valued
    // params are forwarded; non-string (array/object) values are dropped.
    const attr: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.query)) {
      if (key.startsWith("attr.") && typeof value === "string") {
        attr[key.slice("attr.".length)] = value;
      }
    }

    // RETR-007: ?allNamespaces=true spans EVERY manifest namespace — a
    // scoped token's per-namespace grant cannot cover that, so only
    // unrestricted principals may use the flag (auth=none passes through).
    if (params.allNamespaces) {
      const principal = getPrincipal(req);
      if (principal && principal.namespaces !== undefined) {
        throw new ApiError(
          `Forbidden: token '${principal.name}' has no grant for cross-namespace search — ?allNamespaces=true requires an unrestricted token`,
          403,
        );
      }
    }

    // RETR-003: validate + normalize the time-range params BEFORE the tool
    // call — parseTimeRange throws on invalid ISO-8601 values, between=
    // combined with after/before, or an empty window (after > before), and
    // the ValidationError maps to a 400 VALIDATION_ERROR response.
    let timeRange: NormalizedTimeRange;
    try {
      timeRange = parseTimeRange({
        after: params.after,
        before: params.before,
        between: params.between,
      });
    } catch (error) {
      throw new ValidationError(
        error instanceof Error ? error.message : "Invalid time filter",
      );
    }

    // RETR-004: resolve ?as_of= to a concrete commit BEFORE the tool call —
    // an invalid ref maps to a clean 400 VALIDATION_ERROR, mirroring the
    // time-range validation above. The RESOLVED commit is forwarded so the
    // tool never re-resolves against a different HEAD mid-request.
    let asOfRef: string | undefined;
    if (params.as_of !== undefined) {
      try {
        asOfRef = resolveAsOfRef(
          params.as_of,
          resolveNamespacePath(params.namespace),
        );
      } catch (error) {
        throw new ValidationError(
          error instanceof Error ? error.message : "Invalid as_of value",
        );
      }
    }

    // Call recallTool with filters
    const result = await recallTool({
      keyPrefix: params.prefix,
      // Fetch one extra to detect hasMore. limit=0 is an explicit empty page
      // — recallTool short-circuits to a count-only result (GAP-024).
      limit: params.limit! > 0 ? params.limit! + 1 : 0,
      domain: params.domain,
      // RETR-007: ?allNamespaces=true unions over every manifest namespace
      // — recallTool rejects namespace+allNamespaces together, so the
      // scoped param is omitted when the union flag is set.
      ...(params.allNamespaces
        ? { allNamespaces: true }
        : { namespace: params.namespace }),
      // Author is applied in SQL (via recallTool) so the true total
      // reflects it (GAP-024).
      ...(params.author ? { author: params.author } : {}),
      // DOGFOOD-001: forward ?q= to semantic search (was silently dropped).
      // When q= is set but no embedding provider is configured, recallTool
      // returns an error string which the result.error → ApiError(500) path
      // below surfaces instead of silently returning the unfiltered list.
      ...(params.query ? { query: params.query } : {}),
      // RETR-001: forward ?contains= to keyword search (offline FTS —
      // no embedding provider involved). q= and contains= together are
      // rejected by recallTool (hybrid fusion is RETR-002) and surface
      // as an ApiError(500) here.
      ...(params.contains ? { contains: params.contains } : {}),
      // RETR-003: forward the NORMALIZED window (between= already expanded
      // by parseTimeRange) so the tool never sees raw params again.
      ...(timeRange.after ? { after: timeRange.after } : {}),
      ...(timeRange.before ? { before: timeRange.before } : {}),
      // RETR-004: forward the RESOLVED commit ref (date inputs already
      // resolved to a SHA above).
      ...(asOfRef ? { asOf: asOfRef } : {}),
      // RETR-006: forward the prefix-stripped attribute filters
      // (?attr.domain=config → attr: {domain: "config"}).
      ...(Object.keys(attr).length > 0 ? { attr } : {}),
    });

    if (result.error) {
      throw new ApiError(result.error, 500);
    }

    const memories = result.memories.map(transformMemory);

    // Filter by author if specified
    const filteredMemories = params.author
      ? memories.filter((m) => m.author === params.author)
      : memories;

    // Check if there are more results. limit=0 is an explicit empty page —
    // hasMore must be false even when rows exist (GAP-024).
    const hasMore =
      params.limit! > 0 && filteredMemories.length > params.limit!;
    if (hasMore) {
      filteredMemories.pop(); // Remove the extra item
    }

    // Apply offset
    const offset = params.offset || 0;
    const paginatedMemories = filteredMemories.slice(
      offset,
      offset + params.limit!,
    );

    const response: MemoryListResponse = {
      items: paginatedMemories,
      // GAP-024: true COUNT(*) of all rows matching the active filters,
      // unlimited by limit/offset. Falls back to the fetched-page length for
      // callers that stub recallTool without a total.
      total: result.total ?? filteredMemories.length,
      offset,
      limit: params.limit!,
      hasMore,
      nextOffset: hasMore ? offset + params.limit! : null,
    };

    res.json(response);
  }),
);

/**
 * GET /api/memories/key/:key
 * Get single memory by key path
 * Must be defined BEFORE /:id route to avoid conflicts
 */
router.get(
  "/key/*key",
  asyncHandler(async (req: Request, res: Response) => {
    // Express 5 (path-to-regexp v8): a named wildcard (*key) captures an
    // ARRAY of path segments, not a string. Joining restores the key path.
    // The old `as string` cast hid this — key.startsWith threw a TypeError
    // on the array, surfacing as the generic 500 INTERNAL_ERROR (GAP-002).
    const keyParam: unknown = req.params.key;
    const key = Array.isArray(keyParam)
      ? keyParam.join("/")
      : String(keyParam ?? "");
    const namespace = (req.query.namespace as string) || "default";

    // Normalize key to start with /
    const normalizedKey = key.startsWith("/") ? key : `/${key}`;

    // Use exact key lookup in DuckDB — no in-memory scan
    const result = await recallTool({
      key: normalizedKey,
      limit: 10,
      namespace,
    });

    if (result.error) {
      throw new ApiError(result.error, 500);
    }

    if (result.memories.length === 0) {
      throw new NotFoundError("Memory", key);
    }

    // Return the most recent non-tombstoned memory, or the most recent
    const memory =
      result.memories.find((m) => m.action !== "tombstone") ||
      result.memories[0];

    res.json(transformMemory(memory));
  }),
);

/**
 * GET /api/memories/:id
 * Get single memory by ID
 */
router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const namespace = (req.query.namespace as string) || "default";

    // Use exact ID lookup in DuckDB — no in-memory scan
    const result = await recallTool({
      id,
      limit: 1,
      namespace,
    });

    if (result.error) {
      throw new ApiError(result.error, 500);
    }

    // DuckDB WHERE clause already filtered to this ID — use first result
    const memory = result.memories[0];

    if (!memory) {
      throw new NotFoundError("Memory", id);
    }

    res.json(transformMemory(memory));
  }),
);

/**
 * POST /api/memories
 * Create a new memory
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as CreateMemoryRequest;

    // Validate required fields
    if (!body.key || !body.domain || !body.content) {
      throw new ApiError(
        "Missing required fields: key, domain, content",
        400,
        "VALIDATION_ERROR",
      );
    }

    // Validate domain is a valid value (BUG-029)
    if (!DomainEnum.safeParse(body.domain).success) {
      throw new ApiError(
        `Invalid domain '${body.domain}'. Must be one of: ${DomainEnum.options.join(", ")}`,
        400,
        "VALIDATION_ERROR",
      );
    }

    // Call rememberTool to create memory
    // DB-GAP-031: an authenticated principal stamps the record — a
    // client-supplied ?author= or body author is never honored on writes.
    const principal = getPrincipal(req);
    const result = await rememberTool({
      key: body.key,
      domain: body.domain as any,
      // DOGFOOD-010: canonicalize before it reaches the tool AND before the
      // response echoes it — the stored row and the response must agree.
      attributes: normalizeAttributes(body.attributes),
      embedding_text: body.content,
      namespace: (req.query.namespace as string) || body.namespace || "default",
      ...(principal ? { author: principalAuthorEmail(principal) } : {}),
    });

    if (!result.success) {
      throw new ApiError(result.error || "Failed to create memory", 500);
    }

    // Return the created memory
    const memory: MemoryResponse = {
      id: result.id!,
      key: result.key!,
      domain: body.domain,
      content: body.content,
      attributes: normalizeAttributes(body.attributes),
      timestamp: new Date().toISOString(),
      author: result.author!,
      isTombstone: false,
      action: "add",
    };

    res.status(201).json(memory);
  }),
);

/**
 * PUT /api/memories/:id
 * Update a memory (forget + remember = new version)
 */
router.put(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const body = req.body as UpdateMemoryRequest;
    const namespace = (req.query.namespace as string) || "default";
    // DB-GAP-031: authenticated principal stamps both the tombstone and the
    // new version — client-supplied author values are never honored.
    const principal = getPrincipal(req);

    if (!body.content && !body.attributes) {
      throw new ApiError("No update data provided", 400, "VALIDATION_ERROR");
    }

    // Step 1: Find existing memory by ID directly in DuckDB
    const findResult = await recallTool({
      id,
      limit: 1,
      namespace,
    });

    if (findResult.error) {
      throw new ApiError(findResult.error, 500);
    }

    // DuckDB WHERE clause already filtered to this ID — use first result
    const existingMemory = findResult.memories[0];

    if (!existingMemory) {
      throw new NotFoundError("Memory", id);
    }

    // Step 2: Forget the old version (create tombstone)
    const forgetResult = await forgetTool({
      id,
      reason: "Updated via API",
      namespace,
      ...(principal ? { author: principalAuthorEmail(principal) } : {}),
    });

    if (!forgetResult.success) {
      throw new ApiError(forgetResult.error || "Failed to update memory", 500);
    }

    // Step 3: Remember the new version
    const newContent = body.content || existingMemory.embedding_text;
    // DOGFOOD-010: canonicalize the merged attributes before persisting.
    const newAttributes = body.attributes
      ? {
          ...existingMemory.attributes,
          ...normalizeAttributes(body.attributes),
        }
      : existingMemory.attributes;

    const rememberResult = await rememberTool({
      key: existingMemory.key,
      domain: existingMemory.domain as any,
      attributes: newAttributes,
      embedding_text: newContent,
      namespace,
      ...(principal ? { author: principalAuthorEmail(principal) } : {}),
    });

    if (!rememberResult.success) {
      throw new ApiError(
        rememberResult.error || "Failed to create new memory version",
        500,
      );
    }

    // Return updated memory
    const memory: MemoryResponse = {
      id: rememberResult.id!,
      key: existingMemory.key,
      domain: existingMemory.domain,
      content: newContent,
      attributes: newAttributes,
      timestamp: new Date().toISOString(),
      author: rememberResult.author!,
      isTombstone: false,
      action: "update",
    };

    res.json(memory);
  }),
);

/**
 * DELETE /api/memories/:id
 * Delete a memory (create tombstone)
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const namespace = (req.query.namespace as string) || "default";
    // DB-GAP-031: authenticated principal stamps the tombstone — a
    // client-supplied author value is never honored.
    const principal = getPrincipal(req);

    const result = await forgetTool({
      id,
      reason: "Deleted via API",
      namespace,
      ...(principal ? { author: principalAuthorEmail(principal) } : {}),
    });

    if (!result.success) {
      if (result.error?.includes("not found")) {
        throw new NotFoundError("Memory", id);
      }
      throw new ApiError(result.error || "Failed to delete memory", 500);
    }

    res.status(204).send();
  }),
);

export { router as createMemoryRoutes };
export default router;
