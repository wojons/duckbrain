/**
 * Keys API Routes
 *
 * Express routes that wrap the listKeysTool MCP function.
 * Provides hierarchical key tree structure for the file-explorer UI.
 */

import { Router, Request, Response } from "express";
import { listKeysTool } from "../../mcp/tools/list_keys";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { KeyTreeResponse } from "../types/api";
import { buildKeyTree } from "../../utils/keyTree";
import { resolveNamespaceName } from "../../mcp/tools/shared";
import { requireNamespaceGrant } from "../../auth/middleware";

const router: Router = Router();

/**
 * DB-GAP-062: the ONE namespace source for both the grant gate and the tool
 * call — explicit `?namespace=` > DUCKBRAIN_NAMESPACE > config defaultNamespace
 * > "default" (DF-0926-04). Deriving the gate's namespace separately from the
 * route's risked grading a different namespace than the one actually read.
 */
const resolveRequestNamespace = (req: Request): string =>
  resolveNamespaceName(req.query.namespace as string);

// DB-GAP-062: /api/keys had no namespace-grant middleware at all, so a token
// scoped to one namespace could read another namespace's key tree. Same
// refusal as /api/memories and the table routes: 403 + audited
// `namespace_scope`. Untouched in auth=none mode and for unrestricted tokens
// (`namespaces` absent).
router.use(requireNamespaceGrant(resolveRequestNamespace));

/**
 * GET /api/keys
 * Get hierarchical key tree
 *
 * Query params:
 * - prefix: Key prefix filter (e.g., /projects/)
 * - depth: Max hierarchy depth (default: 10)
 * - limit: Max keys to return (default: 100)
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const prefix = (req.query.prefix as string) || "/";
    const depth = req.query.depth
      ? parseInt(req.query.depth as string, 10)
      : 10;
    const limit = req.query.limit
      ? parseInt(req.query.limit as string, 10)
      : 100;
    // DF-0926-04: the canonical resolver, so ?namespace= > DUCKBRAIN_NAMESPACE
    // > config defaultNamespace > "default" (the old `|| "default"` ignored
    // both the documented env var and the configured default). DB-GAP-062:
    // shared with the grant gate above so both grade the same namespace.
    const namespace = resolveRequestNamespace(req);

    // Call listKeysTool to get flat key list
    const result = await listKeysTool({
      prefix,
      maxDepth: depth,
      limit,
      offset: 0,
      namespace,
    });

    if (result.error) {
      throw new ApiError(result.error, 500);
    }

    // Build hierarchical tree
    const tree = buildKeyTree(result.keys, depth);

    const response: KeyTreeResponse = {
      tree,
      total: result.keys.length,
    };

    res.json(response);
  }),
);

/**
 * GET /api/keys/flat
 * Get flat list of keys (for autocomplete, etc.)
 *
 * Query params:
 * - prefix: Key prefix filter
 * - limit: Max keys (default: 100)
 * - offset: Pagination offset
 */
router.get(
  "/flat",
  asyncHandler(async (req: Request, res: Response) => {
    const prefix = (req.query.prefix as string) || "/";
    const limit = req.query.limit
      ? parseInt(req.query.limit as string, 10)
      : 100;
    const offset = req.query.offset
      ? parseInt(req.query.offset as string, 10)
      : 0;
    // DF-0926-04: the canonical resolver, so ?namespace= > DUCKBRAIN_NAMESPACE
    // > config defaultNamespace > "default" (the old `|| "default"` ignored
    // both the documented env var and the configured default). DB-GAP-062:
    // shared with the grant gate above so both grade the same namespace.
    const namespace = resolveRequestNamespace(req);

    const result = await listKeysTool({
      prefix,
      maxDepth: 1, // Flat list doesn't need depth
      limit: limit + 1, // Fetch one extra to detect hasMore
      offset,
      namespace,
    });

    if (result.error) {
      throw new ApiError(result.error, 500);
    }

    const hasMore = result.hasMore;
    const keys = result.keys.slice(0, limit);

    res.json({
      keys,
      total: keys.length,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
      prefixes: result.prefixes,
    });
  }),
);

export { router as createKeyRoutes };
export { buildKeyTree };
export default router;
