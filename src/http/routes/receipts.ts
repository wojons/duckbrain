/**
 * Session Activity Receipts API Routes (DB-GAP-66)
 *
 * Mounted at /api/receipts in src/cli/http.ts (after authMiddleware, like the
 * sibling API routes). Backed by the append-only receipt store in
 * src/receipts/sessionActivityReceipt.ts (hidden `.duckbrain-receipts/`
 * storage namespace — these rows are not memories).
 *
 *   POST /api/receipts                    ingest one session_activity_receipt/v1
 *     201 { status: "recorded", ... }     new receipt durably appended
 *     200 { status: "duplicate", ... }    same receipt_id, identical observation
 *     409 { status: "quarantined" }       same receipt_id, different observation
 *     422 { status: "rejected", reason }  forbidden key/value, unsafe key,
 *                                         oversized, or invalid shape (the
 *                                         offending payload is never persisted;
 *                                         a payload-free row lands in the
 *                                         quarantine ledger)
 *     400 VALIDATION_ERROR                body missing / not a JSON object
 *
 *   GET  /api/receipts/skill/:skillRef    exposure vs activation for skill X
 *   GET  /api/receipts/session/:sessionRef  observed counters + coverage for
 *                                         session Y (404 when nobody ever
 *                                         reported the session)
 *
 * The claim boundary is in-band on every stored receipt: these rows are NOT
 * execution, verification, review, or merge evidence.
 */

import { Router, Request, Response } from "express";
import {
  asyncHandler,
  NotFoundError,
  ValidationError,
} from "../middleware/errorHandler";
import { resolveNamespacesPath } from "../../config/index";
import {
  createSessionReceiptStore,
  querySkillExposure,
  querySessionCounters,
  OPAQUE_REF_RE,
  RECEIPTS_DIR,
  RECEIPTS_FILE,
  QUARANTINE_FILE,
  RECEIPTS_MAX_BYTES,
  MAX_RECEIPT_BYTES,
  MAX_SKILLS_PER_RECEIPT,
} from "../../receipts/sessionActivityReceipt";

function parseRefParam(raw: unknown, name: string): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !OPAQUE_REF_RE.test(value)) {
    throw new ValidationError(
      `Route parameter '${name}' must be an opaque reference (1-256 chars: letters, digits, _ . : -)`,
    );
  }
  return value;
}

export function createReceiptsRoutes(): Router {
  const router: Router = Router();

  router.post(
    "/",
    asyncHandler(async (req: Request, res: Response) => {
      // DF-2026-5/6 lesson: guard req.body before any field read — Express 5
      // leaves req.body undefined when no JSON Content-Type was sent, and a
      // TypeError here would surface as a misclassified 500.
      if (
        req.body === undefined ||
        req.body === null ||
        typeof req.body !== "object" ||
        Array.isArray(req.body)
      ) {
        throw new ValidationError(
          "Body must be a JSON object carrying a session_activity_receipt/v1 receipt",
        );
      }
      const store = createSessionReceiptStore(resolveNamespacesPath());
      const result = await store.ingest(req.body);
      switch (result.status) {
        case "recorded":
          res.status(201).json(result);
          return;
        case "duplicate":
          res.status(200).json(result);
          return;
        case "quarantined":
          res.status(409).json(result);
          return;
        case "rejected":
          res.status(422).json(result);
          return;
      }
    }),
  );

  router.get(
    "/skill/:skillRef",
    asyncHandler(async (req: Request, res: Response) => {
      const skillRef = parseRefParam(req.params.skillRef, "skillRef");
      const report = querySkillExposure(resolveNamespacesPath(), skillRef);
      res.json({
        ...report,
        claim_boundary:
          "observation only — not execution, verification, review, or merge evidence",
      });
    }),
  );

  router.get(
    "/session/:sessionRef",
    asyncHandler(async (req: Request, res: Response) => {
      const sessionRef = parseRefParam(req.params.sessionRef, "sessionRef");
      const report = querySessionCounters(resolveNamespacesPath(), sessionRef);
      if (report.receipt_count === 0) {
        throw new NotFoundError("session activity receipts for session", sessionRef);
      }
      res.json({
        ...report,
        claim_boundary:
          "observation only — not execution, verification, review, or merge evidence",
      });
    }),
  );

  router.get(
    "/",
    asyncHandler(async (_req: Request, res: Response) => {
      res.json({
        receipt_kind: "session_activity_receipt/v1",
        ledger: {
          dir: RECEIPTS_DIR,
          file: RECEIPTS_FILE,
          quarantine: QUARANTINE_FILE,
          segments: "receipts.NNNN.jsonl / quarantine.NNNN.jsonl (sealed, monotonic)",
          max_bytes: RECEIPTS_MAX_BYTES,
          max_receipt_bytes: MAX_RECEIPT_BYTES,
          max_skills_per_receipt: MAX_SKILLS_PER_RECEIPT,
        },
        endpoints: {
          ingest: "POST /api/receipts",
          skill: "GET /api/receipts/skill/:skillRef",
          session: "GET /api/receipts/session/:sessionRef",
        },
      });
    }),
  );

  return router;
}

export default createReceiptsRoutes;
