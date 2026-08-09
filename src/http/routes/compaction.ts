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
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await getCompactionStatsTool({});

    if (!result.success) {
      throw new ApiError(result.error || "Failed to get compaction stats", 500);
    }

    res.json({
      success: true,
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

    if (partition !== undefined && typeof partition !== "string") {
      throw new ApiError("partition must be a string", 400, "VALIDATION_ERROR");
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
    });

    if (!result.success) {
      throw new ApiError(result.message || "Squash failed", 500);
    }

    res.json(result);
  }),
);

export { router as createCompactionRoutes };
export default router;
