/**
 * DB-SUPA-5 realtime change feed — `GET /api/ns/:ns/changes`.
 *
 * The one v1 subscription route. It requires the SUPA-4 namespace grant plus
 * `tables.read` on every selected table, and its query grammar is deliberately
 * small (`docs/specs/SUPA-5-realtime.md`):
 *
 *   tables  absent, or comma-separated declared table names (duplicates
 *           rejected; an unauthorized or unknown table fails the WHOLE request
 *           without revealing a partial stream)
 *   ops     absent, or a comma-separated subset of insert,update,delete
 *   cursor  one opaque cursor, mutually exclusive with a non-identical
 *           `Last-Event-ID`
 *
 * A successful response is `200 text/event-stream` with
 * `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, and
 * `X-Accel-Buffering: no`. It first emits `event: duckbrain.ready.v1`
 * (`{version, namespace, head}` — no SSE id), then one
 * `event: duckbrain.change.v1` frame per committed change with
 * `id: <cursor>`, plus a `: heartbeat` comment every configured interval.
 *
 * WebSocket is not in v1 and this module adds no second protocol: the
 * committed event JSON and cursor semantics are transport-independent, so a
 * future transport must reuse them after a separate compatibility decision.
 *
 * The legacy `/api/events/:namespace` scaffold is NOT this contract and
 * shares no connection state with it.
 */

import { Router, type Request, type Response } from "express";
import { getPrincipal } from "../../auth/middleware";
import { authorizeTableAccess } from "../../auth/roles";
import { getConfig } from "../../config";
import { invalidateTableRegistry, listTables } from "../../schema/table-registry";
import { ChangelogCorruptError } from "../../serialization/auditLedger";
import {
  CHANGE_OPERATIONS,
  MEMORIES_TABLE,
  type ChangeOperation,
} from "../../serialization/changeRecord";
import { RealtimeError } from "../realtime/cursor";
import {
  createHttpSseSink,
  getRealtimeHub,
  type RealtimeHub,
} from "../realtime/hub";

export const REALTIME_ROUTE_PATH = "/api/ns/:ns/changes";

/** Express 5 types named params as string | string[] (GAP-002 pattern). */
function param(req: Request, name: string): string {
  const value: unknown = req.params[name];
  return Array.isArray(value) ? value.join("/") : String(value ?? "");
}

function queryValue(req: Request, name: string): string | null {
  const value = req.query[name];
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new RealtimeError(
      "INVALID_SUBSCRIPTION",
      `'${name}' must appear at most once`,
    );
  }
  return value;
}

function parseCsv(value: string, name: string): string[] {
  if (value === "") {
    throw new RealtimeError(
      "INVALID_SUBSCRIPTION",
      `'${name}' must not be empty`,
    );
  }
  const tokens = value.split(",");
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token === "") {
      throw new RealtimeError(
        "INVALID_SUBSCRIPTION",
        `'${name}' contains an empty token`,
      );
    }
    if (seen.has(token)) {
      throw new RealtimeError(
        "INVALID_SUBSCRIPTION",
        `'${name}' contains the duplicate token '${token}'`,
      );
    }
    seen.add(token);
  }
  return tokens;
}

/** Every table the namespace exposes: the built-in `memories` plus declared tables. */
export function knownTables(namespace: string): string[] {
  let declared: string[] = [];
  try {
    declared = listTables(namespace).map((table) => table.name);
  } catch (error) {
    if (error instanceof ChangelogCorruptError) throw error;
    throw new RealtimeError(
      "INVALID_SUBSCRIPTION",
      `namespace '${namespace}' table declarations could not be read`,
    );
  }
  const known = new Set<string>([MEMORIES_TABLE, ...declared]);
  return [...known];
}

export interface RealtimeRouteOptions {
  hub?: RealtimeHub;
}

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  guidance?: string,
): void {
  if (res.headersSent) {
    // A stream is already open: never append a JSON error body to it.
    try {
      res.end();
    } catch {
      // Idempotent close.
    }
    return;
  }
  res.status(status).json({
    error: message,
    code,
    ...(guidance ? { guidance } : {}),
  });
}

export function createRealtimeRoutes(
  options: RealtimeRouteOptions = {},
): Router {
  const router: Router = Router({ mergeParams: true });

  router.get("/", async (req: Request, res: Response): Promise<void> => {
    let hub: RealtimeHub;
    try {
      hub = options.hub ?? getRealtimeHub();
    } catch (error) {
      sendError(
        res,
        500,
        "INTERNAL_ERROR",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    try {
      if (!getConfig(".").realtime.enabled) {
        sendError(res, 404, "NOT_FOUND", "Realtime change feed is disabled");
        return;
      }

      const namespace = param(req, "ns");
      if (namespace === "") {
        sendError(res, 400, "INVALID_SUBSCRIPTION", "namespace is required");
        return;
      }

      // ---- grammar -----------------------------------------------------
      const opsToken = queryValue(req, "ops");
      let ops: ChangeOperation[];
      if (opsToken === null) {
        ops = [...CHANGE_OPERATIONS];
      } else {
        const requested = parseCsv(opsToken, "ops");
        for (const token of requested) {
          if (!(CHANGE_OPERATIONS as readonly string[]).includes(token)) {
            sendError(
              res,
              400,
              "INVALID_SUBSCRIPTION",
              `'${token}' is not a valid op (expected one of ${CHANGE_OPERATIONS.join(",")})`,
            );
            return;
          }
        }
        ops = requested as ChangeOperation[];
      }

      const tablesToken = queryValue(req, "tables");
      const requestedTables =
        tablesToken === null ? null : parseCsv(tablesToken, "tables");

      const cursorParam = queryValue(req, "cursor");
      if (cursorParam !== null && cursorParam === "") {
        throw new RealtimeError(
          "INVALID_CURSOR",
          "cursor must not be empty",
        );
      }
      const lastEventId =
        typeof req.headers["last-event-id"] === "string"
          ? req.headers["last-event-id"]
          : null;
      if (
        cursorParam !== null &&
        lastEventId !== null &&
        cursorParam !== lastEventId
      ) {
        throw new RealtimeError(
          "INVALID_SUBSCRIPTION",
          "cursor and Last-Event-ID must be identical when both are supplied",
        );
      }
      const cursor = cursorParam ?? lastEventId;

      // ---- authorization ----------------------------------------------
      // Authorize every requested table BEFORE any existence check so an
      // unauthorized table never reveals whether it exists, and never yields a
      // partial stream (all-or-nothing).
      const principal = getPrincipal(req);
      const known = knownTables(namespace);

      const scopeDecision = authorizeTableAccess(
        principal,
        namespace,
        MEMORIES_TABLE,
        "read",
      );
      if (!scopeDecision.allowed && scopeDecision.reason === "namespace_scope") {
        sendError(res, 403, "FORBIDDEN", scopeDecision.message);
        return;
      }

      if (requestedTables !== null) {
        for (const table of requestedTables) {
          const decision = authorizeTableAccess(
            principal,
            namespace,
            table,
            "read",
          );
          if (!decision.allowed) {
            sendError(
              res,
              403,
              "FORBIDDEN",
              `Forbidden: subscription to namespace '${namespace}' denied`,
            );
            return;
          }
        }
        for (const table of requestedTables) {
          if (!known.includes(table)) {
            sendError(
              res,
              400,
              "INVALID_SUBSCRIPTION",
              `'${table}' is not a declared table in namespace '${namespace}'`,
            );
            return;
          }
        }
      }

      const selected =
        requestedTables ??
        known.filter(
          (table) =>
            authorizeTableAccess(principal, namespace, table, "read").allowed,
        );

      // ---- commit ------------------------------------------------------
      const subscription = await hub.subscribe(
        {
          ns: namespace,
          principal,
          tables: selected,
          ops,
          cursor,
          sink: createHttpSseSink(res),
        },
        () => {
          res.status(200);
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache, no-transform");
          res.setHeader("Connection", "keep-alive");
          res.setHeader("X-Accel-Buffering", "no");
        },
      );

      const close = (): void => subscription.close();
      req.on("close", close);
      res.on("close", close);
    } catch (error) {
      if (error instanceof RealtimeError) {
        sendError(
          res,
          error.status,
          error.code,
          error.message,
          error.guidance,
        );
        return;
      }
      if (error instanceof ChangelogCorruptError) {
        const detail = [
          error.detail.commit ? `commit ${error.detail.commit}` : null,
          error.detail.path
            ? `${error.detail.path}${
                error.detail.line !== undefined ? `:${error.detail.line}` : ""
              }`
            : null,
        ]
          .filter(Boolean)
          .join(" ");
        console.warn(`[realtime] ${error.message}${detail ? ` (${detail})` : ""}`);
        sendError(res, 500, "CHANGELOG_CORRUPT", error.message);
        return;
      }
      sendError(
        res,
        500,
        "INTERNAL_ERROR",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  return router;
}

/** Test seam: drop the cached table declarations the feed reads for a namespace. */
export function invalidateRealtimeTableCache(namespace?: string): void {
  invalidateTableRegistry(namespace);
}

export default createRealtimeRoutes;
