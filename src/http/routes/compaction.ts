/**
 * Compaction API Routes
 *
 * Express routes that wrap MCP squash/compaction tool functions.
 * Provides repository compaction (squash) and compaction health stats.
 */

import { Router, Request, Response } from "express";
import { squashTool, getCompactionStatsTool } from "../../mcp/tools/squash";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { resolveNamespaceName } from "../../mcp/tools/shared";
import { requireNamespaceGrant } from "../../auth/middleware";

const router: Router = Router();

/**
 * DB-GAP-062: the namespace the request asks for, from the two places these
 * routes accept one — JSON body first, then query string (REST parity,
 * GAP-015). Returns undefined when the request names none, which the grant
 * gate resolves through the canonical resolver (`resolveNamespaceName`) —
 * exactly the namespace the tools fall back to when handed no namespace.
 */
const requestedNamespace = (req: Request): string | undefined =>
  (req.body && typeof req.body.namespace === "string"
    ? req.body.namespace
    : undefined) ??
  (typeof req.query.namespace === "string" ? req.query.namespace : undefined);

/**
 * DB-GAP-062: the resolved namespace, shared by the grant gate and both route
 * handlers so the namespace graded is the namespace the tool is handed.
 */
const resolveRequestNamespace = (req: Request): string =>
  resolveNamespaceName(requestedNamespace(req));

// DB-GAP-062: /api/compaction* had no namespace-grant middleware at all, so a
// token scoped to one namespace could read another's storage shape (/stats)
// and squash another's history (/squash). Same refusal as /api/memories and
// the table routes: 403 + audited `namespace_scope`. Untouched in auth=none
// mode and for unrestricted tokens (`namespaces` absent).
router.use(requireNamespaceGrant(resolveRequestNamespace));

/**
 * GET /api/compaction/stats
 * Get repository compaction statistics
 */
router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response) => {
    // DB-GAP-062: same source as the grant gate at the top of this router.
    const namespace = requestedNamespace(req);
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
    // DB-GAP-062: same source as the grant gate at the top of this router.
    const namespace = requestedNamespace(req);

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
