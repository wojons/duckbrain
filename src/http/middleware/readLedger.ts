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

export interface ReadLedgerMiddlewareOptions {
  /**
   * OBSDB-001: sink for each RECORDED read, called with the row's normalized
   * route template, method, status and duration. Wired by the assembler to the
   * in-process `duckbrain_reads_total` counter and, since OBSDB-002, to
   * `duckbrain_read_duration_seconds` — the SAME `durMs` value the row stores
   * as `dur_ms`, so the histogram and the ledger can never disagree about how
   * long a read took. MUST never throw into the response path — the middleware
   * guards it, and a metric failure can never fail a read.
   *
   * The values passed are the same ones appended to the ledger: `route` is
   * already a template (never a raw URL), so the metric inherits the ledger's
   * no-keys/no-namespace guarantee by construction.
   */
  onRead?: (row: {
    route: string;
    method: string;
    status: number;
    durMs: number;
  }) => void;
}

export function createReadLedgerMiddleware(
  store: ReadLedgerStore,
  options: ReadLedgerMiddlewareOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const onRead = options.onRead;
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
      if (onRead) {
        try {
          onRead({
            route,
            method: method.toUpperCase(),
            status: res.statusCode,
            durMs,
          });
        } catch {
          /* metrics are never allowed to break a served read */
        }
      }
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
