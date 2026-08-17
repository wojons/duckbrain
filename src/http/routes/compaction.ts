/**
 * Compaction API Routes
 *
 * Express routes that wrap MCP squash/compaction tool functions.
 * Provides repository compaction (squash) and compaction health stats.
 */

import { Router, Request, Response } from "express";
import { squashTool, getCompactionStatsTool } from "../../mcp/tools/squash";
import { asyncHandler, ApiError } from "../middleware/errorHandler";

const router: Router = Router();

/**
 * GET /api/compaction/stats
 * Get repository compaction statistics
 */
router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response) => {
    const namespace =
      typeof req.query.namespace === "string" ? req.query.namespace : undefined;
    const result = await getCompactionStatsTool(namespace ? { namespace } : {});

    if (!result.success) {
      throw new ApiError(result.error || "Failed to get compaction stats", 500);
    }

    res.json({
      success: true,
      ...(result.namespace ? { namespace: result.namespace } : {}),
      stats: result.stats,
    });
  }),
);

/**
 * POST /api/compaction/squash
 * Compact old memory partitions to reduce repository size
 */
router.post(
  "/squash",
  asyncHandler(async (req: Request, res: Response) => {
    const { partition, dryRun, aggressive } = req.body ?? {};
    // Namespace accepted from body or query string (REST parity, GAP-015).
    const namespace =
      (req.body && typeof req.body.namespace === "string"
        ? req.body.namespace
        : undefined) ??
      (typeof req.query.namespace === "string"
        ? req.query.namespace
        : undefined);

    if (partition !== undefined && typeof partition !== "string") {
      throw new ApiError("partition must be a string", 400, "VALIDATION_ERROR");
    }
    if (namespace !== undefined && typeof namespace !== "string") {
      throw new ApiError("namespace must be a string", 400, "VALIDATION_ERROR");
    }
    if (dryRun !== undefined && typeof dryRun !== "boolean") {
      throw new ApiError("dryRun must be a boolean", 400, "VALIDATION_ERROR");
    }
    if (aggressive !== undefined && typeof aggressive !== "boolean") {
      throw new ApiError(
        "aggressive must be a boolean",
        400,
        "VALIDATION_ERROR",
      );
    }

    const result = await squashTool({
      partition,
      dryRun: dryRun ?? false,
      aggressive: aggressive ?? false,
      ...(namespace ? { namespace } : {}),
    });

    if (!result.success) {
      throw new ApiError(result.message || "Squash failed", 500);
    }

    res.json(result);
  }),
);

export { router as createCompactionRoutes };
export default router;
