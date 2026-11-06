/**
 * Operational verbs over HTTP (SURFACE-HTTP-OPS-001).
 *
 * DuckBrain's data plane was reachable over HTTP long before its OPERATIONS
 * were: squash, prune, s3, consolidate, distill, rebuild and token minting
 * were CLI-only, so an agent driving a remote daemon could read and write
 * memories but could not perform a single maintenance action. This router
 * closes the half of the surface that can be closed safely:
 *
 *   POST /api/ops/namespaces/prune   — drop dead registry mappings
 *   GET  /api/ops/s3/status          — the `s3 status` report as JSON
 *   POST /api/ops/consolidate        — the daily delta/dedup digest (read-only)
 *   (squash is hardened in place at POST /api/compaction/squash)
 *
 * The verbs that STAY CLI-ONLY and why (s3 sync, distill-sessions,
 * embeddings rebuild, token create/revoke) are recorded in
 * docs/api/ops-surface-decisions.md; ops-surface-parity.test.ts asserts that
 * decision so a route cannot appear there without the doc changing with it.
 *
 * Contract shared by every route here:
 *   - `requireRole("admin")` — maintenance is an administrator action, and the
 *     namespace grant alone is not enough (prune edits the registry itself).
 *   - Destructive verbs are DRY RUN BY DEFAULT: the body must say
 *     `dryRun: false` AND `confirm: true` before anything is written.
 *   - Every run appends one line to the namespace lifecycle ledger
 *     (`<namespaces>/.s3state/lifecycle.log`) with op, outcome and principal —
 *     the same ledger REST namespace deletion and S3 clearing already use.
 *   - Responses report what happened (counts before/after), never just "ok".
 */

import { Router, Request, Response } from "express";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { getPrincipal, requireRole } from "../../auth/middleware";
import { resolveNamespacesPath } from "../../config/index";
import { logLifecycle } from "../../namespaces/lifecycle";
import {
  planNamespacePrune,
  applyNamespacePrune,
} from "../../namespaces/prune";
import type { NamespacePrunePlan } from "../../namespaces/prune";
import { TEST_RESIDUE_PATTERN } from "../../cli/namespaces-prune";
import {
  collectNamespaceDeltas,
  parseTargetDate,
  buildDigestText,
} from "../../cli/consolidate";

const router: Router = Router();

/** Principal name for the audit ledger; auth=none (local) has none. */
function principalName(req: Request): string {
  return getPrincipal(req)?.name ?? "local";
}

/** Append one ops audit line. Best-effort — never fails the operation. */
function auditOps(
  req: Request,
  entry: Record<string, unknown>,
): void {
  logLifecycle(resolveNamespacesPath(), {
    surface: "rest",
    principal: principalName(req),
    ...entry,
  });
}

/** Boolean body field with a type check that names the offender. */
function optionalBoolean(
  body: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ApiError(`${field} must be a boolean`, 400, "VALIDATION_ERROR");
  }
  return value;
}

/** Yesterday in UTC — the consolidate verb's default target day. */
function yesterdayUtc(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// Every /api/ops route is administrator-only. In auth=none mode (loopback
// local) there is no principal and the gate passes, exactly like every other
// requireRole mount.
router.use(requireRole("admin"));

/**
 * POST /api/ops/namespaces/prune
 *
 * Body: { dryRun?: boolean = true, confirm?: boolean, residueOnly?: boolean }
 *
 * Removes registry mappings whose namespace directory no longer exists. The
 * plan is computed by the SAME function the CLI verb uses; `--apply`'s
 * semantics are mirror-image: dry run unless the caller says otherwise, and
 * the apply path additionally demands `confirm: true`.
 */
router.post(
  "/namespaces/prune",
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const dryRun = optionalBoolean(body, "dryRun") ?? true;
    const confirm = optionalBoolean(body, "confirm") ?? false;
    const residueOnly = optionalBoolean(body, "residueOnly") ?? false;

    if (!dryRun && !confirm) {
      throw new ApiError(
        "Confirmation required. Send confirm=true with dryRun=false to prune the namespace registry.",
        400,
        "CONFIRMATION_REQUIRED",
      );
    }

    const plan = planNamespacePrune();
    const effective: NamespacePrunePlan = residueOnly
      ? { ...plan, dead: plan.dead.filter((row) => TEST_RESIDUE_PATTERN.test(row.name)) }
      : plan;

    const applied = dryRun ? undefined : applyNamespacePrune(effective);

    auditOps(req, {
      op: "prune-namespace-registry",
      dryRun,
      residueOnly,
      mappingsBefore: plan.live.length + plan.dead.length + plan.refused.length,
      dead: effective.dead.length,
      refused: plan.refused.length,
      removed: applied?.removed.length ?? 0,
      success: true,
    });

    res.json({
      success: true,
      dryRun,
      residueOnly,
      namespacesRoot: plan.namespacesRoot,
      registry: {
        mappings: plan.live.length + plan.dead.length + plan.refused.length,
        live: plan.live.length,
        dead: effective.dead.length,
        refused: plan.refused.length,
      },
      dead: effective.dead.map((row) => ({ name: row.name, path: row.path })),
      refused: plan.refused.map((row) => ({ name: row.name, reason: row.reason })),
      // Present only when the plan was actually applied.
      ...(applied
        ? {
            removed: applied.removed.length,
            manifestsPruned: applied.manifestsPruned.length,
            bytesBefore: applied.bytesBefore,
            bytesAfter: applied.bytesAfter,
          }
        : {}),
    });
  }),
);

/**
 * GET /api/ops/s3/status?namespace=<ns>[&verify=true][&sample=N][&allowManyObjects=true]
 *
 * The `s3 status` report as JSON — the exact object `s3 status --json` prints,
 * built by the same collector (`collectS3StatusReport`, SURFACE-HTTP-OPS-001).
 * Read-only: no manifest is written and no sync lock is taken.
 *
 * S3-STATUS-SCALE-001: the DEFAULT is the recorded state — no bucket listing.
 * A status GET used to LIST every object in the namespace, which for
 * scheduler (258,578 objects, ~23 pages) meant the route could not answer at
 * all. `verify=true` (or the legacy `probe=true`) compares a bounded sample;
 * a sample above the budget is a 400, not a hung request.
 */
router.get(
  "/s3/status",
  asyncHandler(async (req: Request, res: Response) => {
    const ns =
      typeof req.query.namespace === "string" && req.query.namespace
        ? req.query.namespace
        : undefined;
    const verify =
      req.query.verify === "true" || req.query.probe === "true";
    const sample =
      typeof req.query.sample === "string" && req.query.sample !== ""
        ? Number(req.query.sample)
        : undefined;

    // Lazy: src/s3/cli pulls in @aws-sdk/client-s3 (~91ms, PERF-004). Loading
    // it here instead of at module scope keeps daemon startup unchanged for
    // the overwhelmingly common case where nobody asks for S3 status.
    const { collectS3StatusReport } = await import("../../s3/cli.js");
    let report: Awaited<ReturnType<typeof collectS3StatusReport>>;
    try {
      report = await collectS3StatusReport(".", ns, {
        full: true,
        verify,
        ...(sample === undefined ? {} : { sample }),
        allowManyObjects: req.query.allowManyObjects === "true",
      });
    } catch (err) {
      // A sample over budget is a caller error with a fixable message, not a
      // 500 and not a request that hangs until the client gives up.
      res.status(400).json({ success: false, error: (err as Error).message });
      return;
    }

    auditOps(req, {
      op: "s3-status",
      ns: ns ?? null,
      enabled: report.enabled,
      total: report.total,
      probed: verify,
      success: true,
    });

    res.json({ success: true, ...report });
  }),
);

/**
 * POST /api/ops/consolidate
 *
 * Body: { date?: "YYYY-MM-DD" } — default yesterday (UTC).
 *
 * The consolidate verb's analysis half: per-namespace delta rows, dedup counts
 * and the digest text for the target day. READ-ONLY by construction — the
 * `--write-digest` half (a memory POST into namespace `duckbrain`) stays on
 * the CLI because it needs that namespace's write grant and a durable actor
 * identity, and a maintenance route should not write memories on the caller's
 * behalf.
 */
router.post(
  "/consolidate",
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawDate = body.date;
    if (rawDate !== undefined && typeof rawDate !== "string") {
      throw new ApiError("date must be a string (YYYY-MM-DD)", 400, "VALIDATION_ERROR");
    }

    const date = parseTargetDate(rawDate) ?? (rawDate ? null : yesterdayUtc());
    if (!date) {
      throw new ApiError(
        "date must be a valid YYYY-MM-DD UTC day",
        400,
        "VALIDATION_ERROR",
      );
    }

    const root = resolveNamespacesPath();
    const deltas = collectNamespaceDeltas(root, date);
    const digest = buildDigestText(deltas, date);

    const totals = deltas.reduce(
      (acc, d) => ({
        rows: acc.rows + d.rows.length,
        unique: acc.unique + d.unique.length,
        duplicates: acc.duplicates + d.duplicates,
      }),
      { rows: 0, unique: 0, duplicates: 0 },
    );

    auditOps(req, {
      op: "consolidate-report",
      date,
      namespaces: deltas.length,
      rows: totals.rows,
      dryRun: true,
      success: true,
    });

    res.json({
      success: true,
      date,
      readOnly: true,
      namespacesScanned: deltas.length,
      totals,
      namespaces: deltas.map((d) => ({
        namespace: d.namespace,
        rows: d.rows.length,
        unique: d.unique.length,
        duplicates: d.duplicates,
      })),
      digest,
    });
  }),
);

export { router as createOpsRoutes };
export default router;
