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

const router: Router = Router();

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
    const namespace = (req.query.namespace as string) || "default";

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
    const namespace = (req.query.namespace as string) || "default";

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
