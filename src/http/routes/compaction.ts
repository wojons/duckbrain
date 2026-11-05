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
import { getPrincipal, requireNamespaceGrant, requireRole } from "../../auth/middleware";
import { logLifecycle } from "../../namespaces/lifecycle";
import { resolveNamespacesPath } from "../../config/index";

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
 *
 * SURFACE-HTTP-OPS-001: compaction rewrites committed history, so this route
 * now carries the same contract as every other destructive operation:
 *   - ADMIN role required (a namespace grant is not enough to rewrite history);
 *   - DRY RUN BY DEFAULT — the body must say `dryRun: false`;
 *   - `confirm: true` must accompany a real run, so a stale client that omits
 *     dryRun can never compact by accident;
 *   - every run appends one lifecycle-ledger line (op, outcome, principal).
 * The dry-run response reports the same stats the real run returns, so the
 * preview is the answer, not a promise.
 */
router.post(
  "/squash",
  requireRole("admin"),
  asyncHandler(async (req: Request, res: Response) => {
    const { partition, dryRun, aggressive, confirm } = req.body ?? {};
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
    if (confirm !== undefined && typeof confirm !== "boolean") {
      throw new ApiError("confirm must be a boolean", 400, "VALIDATION_ERROR");
    }

    // SURFACE-HTTP-OPS-001: safe by default. A body that does not opt in to
    // the write is a preview; a body that does must also confirm.
    const effectiveDryRun = dryRun ?? true;
    if (!effectiveDryRun && confirm !== true) {
      throw new ApiError(
        "Confirmation required. Send dryRun=false with confirm=true to compact.",
        400,
        "CONFIRMATION_REQUIRED",
      );
    }

    const result = await squashTool({
      partition,
      dryRun: effectiveDryRun,
      aggressive: aggressive ?? false,
      ...(namespace ? { namespace } : {}),
    });

    // Audit refusals too: a failed compaction that rewrote nothing is exactly
    // as interesting to the ledger as one that did.
    logLifecycle(resolveNamespacesPath(), {
      op: "squash-compaction",
      surface: "rest",
      principal: getPrincipal(req)?.name ?? "local",
      ns: namespace ?? null,
      partition: partition ?? null,
      aggressive: aggressive ?? false,
      dryRun: effectiveDryRun,
      success: result.success === true,
      ...(result.success
        ? {}
        : { error: result.message || "Squash failed" }),
    });

    if (!result.success) {
      throw new ApiError(result.message || "Squash failed", 500);
    }

    res.json({ ...result, dryRun: effectiveDryRun });
  }),
);

export { router as createCompactionRoutes };
export default router;
