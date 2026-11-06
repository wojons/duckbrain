/**
 * SURFACE-S3-001 — the durability plane's own verbs, reachable from HTTP.
 *
 * The store's whole pitch is that it survives losing the box, and the one
 * action that makes that true (`s3 sync`) was the one an agent could not take:
 * `duckbrain s3 status|sync|query|config|clear|ghosts` existed only as CLI
 * verbs, so a remote agent could read and write memories but could not answer
 * "is this namespace pushed?", "push it now", or "clean up after a compaction"
 * without a shell on the host.
 *
 * SURFACE-HTTP-OPS-001 had already put `s3 status` on HTTP (GET
 * /api/ops/s3/status) and written a decision that `s3 sync` stays CLI-only
 * (docs/api/ops-surface-decisions.md) for a real reason: a sync holds a
 * per-namespace-root lock and reports progress on its own stderr, and a client
 * that hangs up leaves the lock held. This module answers that reason instead
 * of ignoring it, which is what lets the decision change:
 *
 *   - the lock is NOT bypassed: the same `syncNamespace()` the CLI calls takes
 *     it, and a second concurrent trigger is refused with 409 SYNC_IN_PROGRESS
 *     naming the lock (no queue, no silent no-op);
 *   - every sync is deadline-bounded by the engine's own watchdog
 *     (S3-DEADLINE-001), so a disconnected caller cannot pin the lock past
 *     that budget — the failure lands as an error on the run, not a wedge;
 *   - the response carries the counts the CLI prints (uploaded/downloaded/
 *     skipped/failed/verified/unverified + duration), and the per-object
 *     failures are listed, so a partial push can never look like success;
 *   - who asked and what happened land in the namespace lifecycle ledger.
 *
 * Routes (namespace from the mount path, so a grant is graded on the same
 * value the handler touches):
 *
 *   GET  /api/ns/:ns/s3            object count (local + remote) and drift,
 *                                  last push time, resolved bucket/prefix
 *   POST /api/ns/:ns/s3/sync       { direction?: "push"|"pull" } → CLI counts
 *   GET  /api/ns/:ns/s3/ghosts     ghost sync state (dir gone, still on the
 *                                  push cadence) — the compaction runbook step
 *   POST /api/ns/:ns/s3/ghosts     same listing (POST, for callers that cannot
 *                                  send a query string)
 *   POST /api/ns/:ns/s3/ghosts/clear
 *                                  prune THIS namespace's ghost manifest +
 *                                  stale registry mapping (confirm + audit)
 *   POST /api/ns/:ns/s3/clear      DESTROY the namespace's remote objects
 *                                  (dry run by default; confirm + who/why)
 *
 * Authorization: the namespace grant is the OUTER scope on every verb (the
 * same `requireNamespaceGrant` middleware the tables surface uses). Inside it,
 * mutations additionally need a role — `admin` or `writer` for sync (a push
 * publishes the caller's namespace), `admin` alone for the two destructive
 * verbs. Read-only status/ghosts need only the grant, like the declared-table
 * LIST.
 *
 * `s3 query` and `s3 config` stay CLI-only on purpose (query runs arbitrary SQL
 * against the bucket through DuckDB httpfs and needs a host-side credential
 * decision; config prints the resolved store). Their reason is recorded in
 * docs/api/ops-surface-decisions.md and asserted by this module's tests.
 *
 * Cost: `src/s3/*` pulls in @aws-sdk/client-s3 (~91ms, PERF-004), so every
 * handler imports it lazily. Daemon startup is unchanged for the common case
 * where nobody asks about the object store.
 */

import path from "path";
import { Router, Request, Response } from "express";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import {
  getPrincipal,
  requireNamespaceGrant,
  requireRole,
} from "../../auth/middleware";
import {
  getConfig,
  resolveDuckbrainRoot,
  resolveNamespacesPath,
} from "../../config/index";
import {
  clearNamespaceFromS3,
  findGhostSyncState,
  logLifecycle,
  planS3Clear,
  sweepGhostSyncState,
} from "../../namespaces/lifecycle";
import type { S3Config } from "../../s3/config";

/** Express 5 types named params as string | string[] (GAP-002 pattern). */
function param(req: Request, name: string): string {
  const p: unknown = req.params[name];
  return Array.isArray(p) ? p.join("/") : String(p ?? "");
}

/**
 * Refuse a namespace name that is not one directory under the namespaces root.
 *
 * `namespacePath()` (src/s3/sync.ts) is `path.resolve(root, ns)` — it has no
 * traversal guard because every CLI caller is the operator. Over HTTP the name
 * arrives in a URL, so `..%2F..%2Fetc` must be a 400, not a different
 * directory: a push would otherwise read and publish files from OUTSIDE the
 * namespace root into the bucket.
 */
function assertNamespaceName(ns: string): string {
  if (!ns || ns === "." || ns === ".." || ns.includes("/") || ns.includes("\\") || ns.includes("\0")) {
    throw new ApiError(
      `Invalid namespace name '${ns}': one directory name under the namespaces root is required`,
      400,
      "INVALID_NAMESPACE",
    );
  }
  return ns;
}

/** The daemon's own root — never the caller's cwd (GAP-062). */
function duckbrainRoot(): string {
  return resolveDuckbrainRoot();
}

function namespacesRoot(): string {
  return resolveNamespacesPath(duckbrainRoot());
}

/** Configured S3 block (may be disabled — every caller decides). */
function s3Config(): S3Config {
  return getConfig(duckbrainRoot()).s3;
}

/**
 * The enabled-store gate. The CLI `exit(1)`s here (requireEnabled); a route
 * must answer, so it becomes a 409 naming the exact config key to flip. Not
 * retryable and not a server fault: the capability is switched off.
 */
function requireS3Enabled(): S3Config {
  const s3 = s3Config();
  if (!s3?.enabled) {
    throw new ApiError(
      "S3 is disabled on this daemon: set s3.enabled=true in duckbrain.config.json (see docs/s3-native.md)",
      409,
      "S3_DISABLED",
    );
  }
  return s3;
}

/** Principal name for the audit ledger; auth=none (local) has none. */
function principalName(req: Request): string {
  return getPrincipal(req)?.name ?? "local";
}

/** One lifecycle-ledger line per run — the ledger deletion/clear already use. */
function auditS3(req: Request, entry: Record<string, unknown>): void {
  logLifecycle(namespacesRoot(), {
    surface: "rest",
    principal: principalName(req),
    ...entry,
  });
}

/** Boolean body field with a type check that names the offender. */
function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ApiError(`${field} must be a boolean`, 400, "VALIDATION_ERROR");
  }
  return value;
}

/** Optional body string with a type check. */
function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ApiError(`${field} must be a string`, 400, "VALIDATION_ERROR");
  }
  return value;
}

function createS3Routes(): Router {
  // mergeParams: the :ns lives on the MOUNT path (see cli/http.ts).
  const router: Router = Router({ mergeParams: true });
  const grantNs = (req: Request): string => param(req, "ns");

  /** Namespace grant first on every verb; role gates are per-route. */
  router.use(requireNamespaceGrant(grantNs));

  // ── status ───────────────────────────────────────────────────────────────
  /**
   * GET /api/ns/:ns/s3?probe=false
   *
   * Object count on both sides plus the drift between them, the last push
   * time and the resolved store. Pure read: no manifest is written, no lock is
   * taken. `probe=false` skips the bucket listing for callers that must not
   * touch the network (the remote half is then `null` with state "unknown" —
   * never 0, which would read as "nothing pushed yet").
   */
  router.get(
    "/",
    asyncHandler(async (req: Request, res: Response) => {
      const ns = assertNamespaceName(param(req, "ns"));
      const probe = req.query.probe !== "false";
      const s3 = s3Config();
      const enabled = s3?.enabled === true;
      const root = namespacesRoot();

      const { walkLocal } = await import("../../s3/sync.js");
      const { loadManifest } = await import("../../s3/manifest.js");
      const files = walkLocal(path.join(root, ns));
      const localBytes = [...files.values()].reduce((acc, f) => acc + f.size, 0);
      const manifest = loadManifest(root, ns);

      let remoteObjects: number | null = null;
      let bookkeepingObjects = 0;
      let listingError: string | undefined;
      if (enabled && probe) {
        try {
          const { buildClient, listRemoteObjects } = await import("../../s3/client.js");
          const remote = await listRemoteObjects(
            buildClient(s3),
            s3.bucket,
            `${s3.prefix}/${ns}/`,
          );
          // The engine keeps its own bookkeeping object under
          // `<prefix>/<ns>/.s3state/` (the checksum ledger). It is remote
          // state ABOUT the namespace, not namespace data, so counting it as
          // a data object would make every healthy namespace look one object
          // ahead of disk forever. It is reported separately instead of being
          // hidden: the two numbers still add up to the listing.
          for (const key of remote.keys()) {
            const rel = key.slice(`${s3.prefix}/${ns}/`.length);
            if (rel.startsWith(".s3state/")) bookkeepingObjects += 1;
          }
          remoteObjects = remote.size;
        } catch (err) {
          // A listing failure is reported as a NUMBER THAT IS ABSENT, never as
          // zero: "the bucket did not answer" and "the bucket is empty" are
          // opposite operational facts.
          listingError = (err as Error).message;
        }
      }

      // Drift compares DATA objects: local files against remote objects minus
      // the engine's own bookkeeping (see above). An absent listing stays
      // null — "the bucket did not answer" is not "everything is pushed".
      const dataObjects =
        remoteObjects === null ? null : remoteObjects - bookkeepingObjects;
      const delta = dataObjects === null ? null : files.size - dataObjects;
      const driftState = !enabled
        ? "s3-disabled"
        : remoteObjects === null
          ? "unknown"
          : delta === 0
            ? "in-sync"
            : delta! > 0
              ? "local-ahead"
              : "remote-ahead";

      auditS3(req, {
        op: "s3-status",
        ns,
        enabled,
        probed: enabled && probe,
        localObjects: files.size,
        remoteObjects,
        bookkeepingObjects,
        driftObjects: delta,
        driftState,
        success: true,
      });

      res.json({
        success: true,
        namespace: ns,
        enabled,
        store: enabled
          ? {
              endpoint: s3.endpoint ?? null,
              bucket: s3.bucket,
              prefix: s3.prefix,
              pathStyle: s3.forcePathStyle,
            }
          : null,
        objects: {
          local: files.size,
          remote: remoteObjects,
          // The subset of `remote` that is engine bookkeeping, not data.
          bookkeeping: remoteObjects === null ? null : bookkeepingObjects,
          data: dataObjects,
        },
        bytes: { local: localBytes },
        drift: { state: driftState, objects: delta },
        lastPushAt: manifest?.lastSyncAt ?? null,
        ...(listingError === undefined ? {} : { listingError }),
      });
    }),
  );

  // ── sync trigger ─────────────────────────────────────────────────────────
  /**
   * POST /api/ns/:ns/s3/sync
   *
   * Body: { direction?: "push" (default) | "pull" }
   *
   * Runs exactly what `duckbrain s3 sync <ns> <direction>` runs — the same
   * `syncNamespace()` engine, lock, deadline watchdog and per-object
   * verification — and answers with the counts the CLI prints. 409 when
   * another sync holds the lock (naming it), 404 on a push for a namespace
   * with no local directory (pull bootstraps instead), 502 when the run itself
   * failed (the message says which leg).
   */
  router.post(
    "/sync",
    requireRole("admin", "writer"),
    asyncHandler(async (req: Request, res: Response) => {
      const ns = assertNamespaceName(param(req, "ns"));
      const s3 = requireS3Enabled();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawDirection = optionalString(body, "direction");
      const direction = rawDirection === undefined ? "push" : rawDirection;
      if (direction !== "push" && direction !== "pull") {
        throw new ApiError(
          `direction must be "push" or "pull" (got "${String(direction)}")`,
          400,
          "VALIDATION_ERROR",
        );
      }

      const root = namespacesRoot();
      const { syncNamespace } = await import("../../s3/sync.js");
      let stats;
      try {
        stats = await syncNamespace(s3, ns, root, direction);
      } catch (err) {
        const message = (err as Error).message;
        if (/lock held/.test(message)) {
          throw new ApiError(
            `${message} — a sync already owns the namespaces-root lock; retry when it finishes`,
            409,
            "SYNC_IN_PROGRESS",
          );
        }
        if (/^Namespace not found/.test(message)) {
          throw new ApiError(
            `${message} (push needs a local namespace directory; use direction="pull" to restore one)`,
            404,
            "NAMESPACE_NOT_FOUND",
          );
        }
        throw new ApiError(`S3 ${direction} failed for '${ns}': ${message}`, 502, "SYNC_FAILED");
      }
      if (!stats) {
        throw new ApiError(
          `S3 sync skipped for '${ns}': s3.enabled is false`,
          409,
          "S3_DISABLED",
        );
      }

      // The CLI's own summary line, so an agent's log and an operator's log
      // read the same sentence about the same run.
      const failureDetail =
        direction === "pull"
          ? ` verified=${stats.verified ?? 0} unverified=${stats.unverified ?? 0} failed=${stats.failed ?? 0}`
          : (stats.failed ?? 0) > 0
            ? ` failed=${stats.failed ?? 0}`
            : "";
      const summary = `[S3] ${direction} ${stats.ns}: uploaded=${stats.uploaded} downloaded=${stats.downloaded} skipped=${stats.skipped}${failureDetail} in ${stats.durationMs}ms`;

      auditS3(req, {
        op: `s3-${direction}`,
        ns,
        uploaded: stats.uploaded,
        downloaded: stats.downloaded,
        skipped: stats.skipped,
        failed: stats.failed ?? 0,
        verified: stats.verified ?? 0,
        unverified: stats.unverified ?? 0,
        durationMs: stats.durationMs,
        checksumLedger: stats.checksumLedger,
        success: (stats.failed ?? 0) === 0,
      });

      res.json({
        success: (stats.failed ?? 0) === 0,
        namespace: stats.ns,
        direction,
        uploaded: stats.uploaded,
        downloaded: stats.downloaded,
        skipped: stats.skipped,
        failed: stats.failed ?? 0,
        verified: stats.verified ?? 0,
        unverified: stats.unverified ?? 0,
        durationMs: stats.durationMs,
        checksumLedger: stats.checksumLedger,
        failures: stats.failures ?? [],
        summary,
      });
    }),
  );

  // ── ghost sync state ─────────────────────────────────────────────────────
  /** Shared listing body for GET and POST /ghosts. */
  const listGhosts = asyncHandler(async (req: Request, res: Response) => {
    const ns = assertNamespaceName(param(req, "ns"));
    const root = namespacesRoot();
    const plan = findGhostSyncState(root, { configDir: duckbrainRoot() });
    const manifest = plan.ghostManifests.find((g) => g.ns === ns);
    const mapping = plan.ghostMappings.find((g) => g.name === ns);
    const isGhost = manifest !== undefined || mapping !== undefined;

    auditS3(req, { op: "s3-ghosts-list", ns, isGhost, total: plan.ghostManifests.length + plan.ghostMappings.length, success: true });

    res.json({
      success: true,
      namespace: ns,
      isGhost,
      thisNamespace: {
        ghostManifest: manifest ?? null,
        ghostMapping: mapping ?? null,
      },
      // The whole plan: a ghost sweep is a ROOT-level operation and an agent
      // running the compaction runbook needs the full list, not just its own
      // row. Counts carry the totals so a caller can see the blast radius
      // before asking for the clear.
      ghosts: {
        manifests: plan.ghostManifests,
        mappings: plan.ghostMappings,
        total: plan.ghostManifests.length + plan.ghostMappings.length,
      },
    });
  });

  /**
   * GET /api/ns/:ns/s3/ghosts — is this namespace ghost state, and what is the
   * rest of the plan? (POST below is the same listing for clients that cannot
   * put a query string on a GET.)
   */
  router.get("/ghosts", listGhosts);
  router.post("/ghosts", listGhosts);

  /**
   * POST /api/ns/:ns/s3/ghosts/clear
   *
   * Body: { confirm: true, reason?: string }
   *
   * Prunes THIS namespace's ghost sync manifest (and its stale registry
   * mapping) — the `s3 ghosts --sweep` step of the compaction runbook, scoped
   * to the namespace in the path so a caller cannot sweep another tenant's
   * state by accident. Admin-only, confirm-gated, one lifecycle ledger line.
   * A namespace that is not a ghost is a 200 with `cleared: false` — the
   * question was answered, nothing was destroyed.
   */
  router.post(
    "/ghosts/clear",
    requireRole("admin"),
    asyncHandler(async (req: Request, res: Response) => {
      const ns = assertNamespaceName(param(req, "ns"));
      const body = (req.body ?? {}) as Record<string, unknown>;
      const confirm = optionalBoolean(body, "confirm") ?? false;
      const reason = optionalString(body, "reason");
      if (!confirm) {
        throw new ApiError(
          "Confirmation required. GET /api/ns/<ns>/s3/ghosts for the plan, then POST with confirm=true.",
          400,
          "CONFIRMATION_REQUIRED",
        );
      }

      const root = namespacesRoot();
      const result = sweepGhostSyncState(root, {
        confirm: true,
        requestedBy: principalName(req),
        reason: reason ?? `ghost sweep from REST for ${ns}`,
        configDir: duckbrainRoot(),
        only: [ns],
      });

      auditS3(req, {
        op: "s3-ghosts-clear",
        ns,
        manifestsPruned: result.manifestsPruned,
        mappingsRemoved: result.mappingsRemoved,
        success: result.success,
      });

      res.json({
        success: result.success,
        namespace: ns,
        cleared: result.manifestsPruned.length + result.mappingsRemoved.length > 0,
        manifestsPruned: result.manifestsPruned,
        mappingsRemoved: result.mappingsRemoved,
      });
    }),
  );

  // ── destructive remote clear ─────────────────────────────────────────────
  /**
   * POST /api/ns/:ns/s3/clear
   *
   * Body: { dryRun?: boolean = true, confirm?: boolean, reason?: string }
   *
   * The `s3 clear <ns>` verb: destroys the namespace's objects in the bucket
   * (disk is never touched). Dry run unless the caller asserts BOTH
   * `dryRun: false` and `confirm: true`; `reason` is required for the audit
   * line. Admin-only. The plan is re-listed at execution time by the core, so
   * it destroys exactly what it announced.
   */
  router.post(
    "/clear",
    requireRole("admin"),
    asyncHandler(async (req: Request, res: Response) => {
      const ns = assertNamespaceName(param(req, "ns"));
      const s3 = requireS3Enabled();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const dryRun = optionalBoolean(body, "dryRun") ?? true;
      const confirm = optionalBoolean(body, "confirm") ?? false;
      const reason = optionalString(body, "reason");
      const root = namespacesRoot();

      if (dryRun) {
        const plan = await planS3Clear(s3, ns, { namespacesPath: root });
        auditS3(req, {
          op: "s3-clear",
          ns,
          dryRun: true,
          objectCount: plan.objectCount,
          totalBytes: plan.totalBytes,
          success: true,
        });
        res.json({ success: true, dryRun: true, namespace: ns, plan });
        return;
      }

      if (!confirm) {
        throw new ApiError(
          "Confirmation required. Run the dry run first, then send dryRun=false with confirm=true and a reason.",
          400,
          "CONFIRMATION_REQUIRED",
        );
      }
      if (!reason?.trim()) {
        throw new ApiError(
          "reason is required: a destructive S3 clear must record why",
          400,
          "VALIDATION_ERROR",
        );
      }

      const result = await clearNamespaceFromS3(s3, ns, {
        confirm: true,
        requestedBy: principalName(req),
        reason,
        namespacesPath: root,
      });
      if (!result.success) {
        throw new ApiError(
          result.error ?? `S3 clear failed for '${ns}'`,
          502,
          "S3_CLEAR_FAILED",
        );
      }

      auditS3(req, {
        op: "s3-clear",
        ns,
        dryRun: false,
        deleted: result.deleted,
        failed: result.failed,
        success: true,
      });

      res.json({
        success: true,
        dryRun: false,
        namespace: ns,
        deleted: result.deleted,
        failed: result.failed,
        plan: result.plan,
      });
    }),
  );

  return router;
}

export { createS3Routes };
export default createS3Routes;
