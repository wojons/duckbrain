/**
 * OBS-DUCKBRAIN-001 — read-ledger middleware.
 *
 * Mounted once, BEFORE any route, with the server's durable ledger store
 * injected by the assembler (src/cli/http.ts). Every request is classified
 * through normalizeReadRoute (the single read-path truth table); non-read
 * traffic (writes, /health, /stats, unknown routes) returns null and costs
 * one regex pass — nothing is appended. The /api/reads query surface is NOT
 * recorded (no self-recursion; see readLedger.ts).
 *
 * The append never blocks the response: it is queued onto the store's
 * serialized tail and its failure is logged and swallowed, mirroring the
 * denial auditor's non-blocking contract (src/serialization/audit.ts) — a
 * telemetry failure must never fail a served read. The row's status and
 * duration are captured on res "finish" (response fully sent), so the ts of a
 * row is the request's COMPLETION time.
 */

import type { NextFunction, Request, Response } from "express";
import {
  normalizeReadRoute,
  readRowNamespace,
  type ReadLedgerStore,
} from "../readLedger";

/**
 * True when the request targets the read-ledger query surface itself
 * (any method — a POST would also be a ledger-surface hit and must not be
 * mistaken for a recordable read).
 */
export function isReadsQuerySurface(rawPath: string): boolean {
  const pathname = rawPath.split("?")[0];
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return /^\/api\/reads$/.test(trimmed);
}

export function createReadLedgerMiddleware(
  store: ReadLedgerStore,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const method = req.method;
    const rawPath = req.originalUrl || req.url || "";
    if (isReadsQuerySurface(rawPath)) {
      next();
      return;
    }
    const route = normalizeReadRoute(method, rawPath);
    if (route === null) {
      next();
      return;
    }
    const ns = readRowNamespace(rawPath, req.query as Record<string, unknown>);
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const durMs =
        startedAt === null
          ? 0
          : Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      store
        .append({
          ts: new Date().toISOString(),
          route,
          method: method.toUpperCase(),
          ns,
          status: res.statusCode,
          dur_ms: Math.max(0, Math.round(durMs)),
        })
        .catch(() => {
          /* logged + swallowed inside the store's tail */
        });
    });
    next();
  };
}
