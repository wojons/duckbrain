/**
 * Reads API Routes (OBS-DUCKBRAIN-001)
 *
 * GET /api/reads — aggregate the per-route read ledger
 * (.duckbrain-audit/reads.jsonl) over an arbitrary historical window.
 *
 * Auth-gated like every sibling API route: the middleware mounts AFTER
 * authMiddleware in src/cli/http.ts, and a scoped principal is confined to
 * its namespace grants (DB-GAP-062 doctrine): rows whose ns is an ungranted
 * namespace are excluded from the aggregation; ns-null rows stay visible
 * because they carry no namespace name at all.
 *
 * Query parameters (all optional, combinable):
 *   from  — inclusive ISO lower ts bound
 *   to    — inclusive ISO upper ts bound
 *   route — exact normalized route template (e.g. "GET /api/memories")
 *   ns    — exact explicitly-scoped namespace value
 *
 * Bad input is a 400 with code VALIDATION_ERROR (ValidationError), never a
 * silent narrowing of the window. The window is allowed to lie entirely
 * BEFORE the process started — the ledger is durable on disk, so historical
 * queries need no process to have been alive in the window.
 */

import { Router, Request, Response } from "express";
import {
  asyncHandler,
  ValidationError,
} from "../middleware/errorHandler";
import {
  aggregateReadRows,
  flushReadLedgerForTests,
  READS_FILE,
  READS_MAX_BYTES,
} from "../readLedger";
import { getPrincipal } from "../../auth/middleware";
import { resolveNamespacesPath } from "../../config/index";

/** Query-parameter parse result: a typed value, or null = "param absent". */
type OptionalParam<T> = { ok: true; value: T | null } | { ok: false; error: string };

function parseOptionalIso(
  raw: unknown,
  name: string,
): OptionalParam<string> {
  if (raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: `Query parameter '${name}' must be a non-empty ISO 8601 timestamp` };
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return { ok: false, error: `Query parameter '${name}' is not a valid ISO 8601 timestamp: '${raw}'` };
  }
  return { ok: true, value: new Date(parsed).toISOString() };
}

function parseOptionalString(
  raw: unknown,
  name: string,
): OptionalParam<string> {
  if (raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: `Query parameter '${name}' must be a non-empty string` };
  }
  return { ok: true, value: raw };
}

export function createReadsRoutes(): Router {
  const router: Router = Router();

  router.get(
    "/",
    asyncHandler(async (req: Request, res: Response) => {
      const from = parseOptionalIso(req.query.from, "from");
      if (!from.ok) throw new ValidationError(from.error);
      const to = parseOptionalIso(req.query.to, "to");
      if (!to.ok) throw new ValidationError(to.error);
      const route = parseOptionalString(req.query.route, "route");
      if (!route.ok) throw new ValidationError(route.error);
      const ns = parseOptionalString(req.query.ns, "ns");
      if (!ns.ok) throw new ValidationError(ns.error);

      // Drain any appends still queued by requests that have already
      // finished sending (the ledger tail is asynchronous by design); a
      // query issued immediately after reads therefore sees its own rows.
      await flushReadLedgerForTests();

      // DB-GAP-062: a scoped token sees only its granted namespaces.
      const principal = getPrincipal(req);
      const visibleNamespaces = principal?.namespaces;

      const result = aggregateReadRows(resolveNamespacesPath(), {
        from: from.value,
        to: to.value,
        route: route.value,
        ns: ns.value,
        visibleNamespaces,
      });

      res.json({
        ...result,
        ledger: {
          file: `.duckbrain-audit/${READS_FILE}`,
          segments: "reads.NNNN.jsonl (sealed, monotonic)",
          max_bytes: READS_MAX_BYTES,
        },
      });
    }),
  );

  return router;
}
