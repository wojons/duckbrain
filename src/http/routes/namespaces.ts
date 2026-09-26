/**
 * Namespace API Routes
 *
 * Express routes that wrap MCP namespace tool functions.
 * Provides namespace management for multi-repo support.
 */

import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import {
  listNamespacesTool,
  createNamespaceTool,
  switchNamespaceTool,
} from "../../mcp/tools/namespace";
import { deleteNamespace } from "../../namespaces/delete";
import { resolveNamespacesPath } from "../../config/index";
import { censusOnDiskNamespaces } from "./namespace-census";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { NamespaceListResponse, NamespaceResponse } from "../types/api";
import { requireNamespaceGrant } from "../../auth/middleware";

const router: Router = Router();

/**
 * REG-GONE-001: determine which namespace rows have NO directory on disk
 * (registry row survived an out-of-band `rm -rf`). Existence is checked via
 * fs.existsSync on each row's resolved absolute path — no root-anchor logic
 * needed; mappings may legitimately point anywhere on disk.
 */
function namesWithMissingDirectories(
  namespaces: { name: string; path: string }[],
): Set<string> {
  const missing = new Set<string>();
  for (const ns of namespaces) {
    if (!fs.existsSync(path.resolve(ns.path))) {
      missing.add(ns.name);
    }
  }
  return missing;
}

/**
 * Transform MCP namespace to API response
 */
function transformNamespace(
  ns: any,
  missingDirs?: Set<string>,
): NamespaceResponse {
  return {
    name: ns.name,
    path: ns.path,
    isDefault: ns.isDefault,
    memoryCount: undefined, // Would require expensive query
    lastModified: undefined,
    // REG-GONE-001: flag only rows whose directory is absent on disk;
    // healthy rows omit the field entirely.
    ...(missingDirs?.has(ns.name) ? { directoryMissing: true } : {}),
    // DF-0924-06: listNamespacesTool now shares the DB-GAP-057 census, so a
    // row that exists only as a directory arrives PRE-FLAGGED here —
    // preserve it (it would otherwise be silently dropped and re-added
    // below, losing isDefault fidelity).
    ...(ns.onDiskOnly ? { onDiskOnly: true } : {}),
  };
}

/**
 * GET /api/namespaces
 * List all namespaces
 */
router.get(
  "/",
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await listNamespacesTool({});

    if (!result.success) {
      throw new ApiError(result.error || "Failed to list namespaces", 500);
    }

    // DB-GAP-057: the registry (config mappings) is not the whole truth —
    // directories on disk can exist with NO mapping (the be129bc split-brain
    // produced exactly that for every HTTP/MCP create: dir under the
    // namespaces root, mapping in a stray config file). Take a one-shot
    // read-only census of the namespaces root and union it under the
    // registry rows. Read-only by contract: this route never mutates the
    // config — reconciliation of drifted prod state is an ops action.
    const nsRoot = resolveNamespacesPath();
    const onDisk = censusOnDiskNamespaces(nsRoot);

    const missingDirs = namesWithMissingDirectories(result.namespaces);
    const namespaces = result.namespaces.map((ns) =>
      transformNamespace(ns, missingDirs),
    );

    // Union: every on-disk namespace absent from the registry becomes an
    // onDiskOnly row (config rows keep their REG-GONE-001 directoryMissing
    // flag when their directory is gone). isDefault mirrors the registry
    // row rule (name === currentNamespace).
    //
    // DF-0924-06: the tool itself now runs the census, so most onDiskOnly
    // rows arrive pre-flagged (preserved by transformNamespace) — this
    // second census union remains as the safety net for mocked-tool suites
    // and callers that hand us mapping-only rows. Drift counts count BOTH
    // sources (tool-flagged + route-unioned) exactly once per name.
    const listedNames = new Set(result.namespaces.map((ns) => ns.name));
    const onDiskOnlyNames = new Set(
      result.namespaces.filter((ns: any) => ns.onDiskOnly).map((ns) => ns.name),
    );
    let onDiskOnlyCount = onDiskOnlyNames.size;
    for (const [name, nsPath] of onDisk) {
      if (listedNames.has(name)) continue;
      onDiskOnlyCount++;
      namespaces.push({
        name,
        path: nsPath,
        isDefault: name === result.currentNamespace,
        onDiskOnly: true,
      });
    }

    // Drift counts, both directions — omitted entirely when clean
    // (healthy-rows-omit-fields REG-GONE-001 style).
    const drift: { onDiskOnly: number; directoryMissing: number } | undefined =
      onDiskOnlyCount > 0 || missingDirs.size > 0
        ? { onDiskOnly: onDiskOnlyCount, directoryMissing: missingDirs.size }
        : undefined;

    const response: NamespaceListResponse = {
      namespaces,
      currentNamespace: result.currentNamespace || "default",
      ...(drift ? { drift } : {}),
    };

    res.json(response);
  }),
);

/**
 * POST /api/namespaces
 * Create a new namespace
 */
router.post(
  "/",
  // DB-GAP-031: creating a namespace requires a grant for that namespace
  // (restricted tokens). Unrestricted tokens and auth=none pass through.
  requireNamespaceGrant(
    (req) => (req.body as { name?: string } | undefined)?.name ?? "",
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const { name, setDefault } = req.body;

    if (!name || typeof name !== "string") {
      throw new ApiError("Name is required", 400, "VALIDATION_ERROR");
    }

    // Validate namespace name format
    if (!/^[a-z0-9_-]+$/.test(name)) {
      throw new ApiError(
        "Namespace name must be lowercase alphanumeric with hyphens/underscores only",
        400,
        "VALIDATION_ERROR",
      );
    }

    const result = await createNamespaceTool({
      name,
      setDefault: setDefault ?? false,
    });

    if (!result.success) {
      if (result.error?.includes("already exists")) {
        throw new ApiError(result.error, 409, "CONFLICT");
      }
      throw new ApiError(result.error || "Failed to create namespace", 500);
    }

    const namespace: NamespaceResponse = {
      name,
      path: result.path!,
      isDefault: setDefault ?? false,
    };

    res.status(201).json(namespace);
  }),
);

/**
 * POST /api/namespaces/switch
 * Switch to a different namespace
 */
router.post(
  "/switch",
  asyncHandler(async (req: Request, res: Response) => {
    const { name } = req.body;

    if (!name || typeof name !== "string") {
      throw new ApiError("Name is required", 400, "VALIDATION_ERROR");
    }

    const result = await switchNamespaceTool({ name });

    if (!result.success) {
      if (result.error?.includes("not found")) {
        throw new ApiError(result.error, 404, "NOT_FOUND");
      }
      throw new ApiError(result.error || "Failed to switch namespace", 500);
    }

    res.json({
      success: true,
      previous: result.previous,
      current: result.current,
    });
  }),
);

/**
 * DELETE /api/namespaces/:name
 * Delete a namespace (directory + git repo + config mapping)
 *
 * DB-GAP-032: deletion was MCP-only (delete_namespace with confirm:true);
 * HTTP users could not clean up orphaned namespaces. The route delegates to
 * the SAME shared deletion core as the MCP tool (src/namespaces/delete.ts),
 * so guards are identical: confirm:true required in the body, "default" and
 * the currently-active namespace blocked, path-traversal refused, idempotent,
 * no half-remove on fs failure.
 */
router.delete(
  "/:name",
  // DB-GAP-031: deleting a namespace requires a grant for that namespace
  // (restricted tokens). Unrestricted tokens and auth=none pass through.
  requireNamespaceGrant((req) => {
    // Express 5 (path-to-regexp v8) types named params as string | string[];
    // a plain `/:name` segment is always a string at runtime.
    const param: unknown = req.params.name;
    return Array.isArray(param) ? param.join("/") : String(param ?? "");
  }),
  asyncHandler(async (req: Request, res: Response) => {
    // Express 5 types named params as string | string[] (GAP-002 pattern);
    // `/:name` is a single segment, so this is always a plain string.
    const param: unknown = req.params.name;
    const name = Array.isArray(param) ? param.join("/") : String(param ?? "");

    if (!name) {
      throw new ApiError("Name is required", 400, "VALIDATION_ERROR");
    }

    // Validate namespace name format (mirrors POST /api/namespaces)
    if (!/^[a-z0-9_-]+$/.test(name)) {
      throw new ApiError(
        "Namespace name must be lowercase alphanumeric with hyphens/underscores only",
        400,
        "VALIDATION_ERROR",
      );
    }

    // Deletion requires explicit confirmation — mirrors the MCP tool's
    // confirm guard. Anything other than exactly true is rejected.
    const { confirm } = (req.body ?? {}) as { confirm?: unknown };
    if (confirm !== true) {
      throw new ApiError(
        "Confirmation required. Set confirm=true to delete namespace.",
        400,
        "VALIDATION_ERROR",
      );
    }

    const result = deleteNamespace(name, true);

    if (!result.success) {
      const error = result.error || "Failed to delete namespace";
      if (error.includes("not found")) {
        throw new ApiError(error, 404, "NOT_FOUND");
      }
      if (
        error.includes("Cannot delete") ||
        error.includes("Refusing to delete")
      ) {
        throw new ApiError(error, 400, "VALIDATION_ERROR");
      }
      // DF-0923-01: a push-in-flight refusal is a transient state conflict,
      // not a validation error — surface it as 409 CONFLICT so clients can
      // distinguish "retry after the push completes" from "fix your request".
      if (error.startsWith("Push in flight")) {
        throw new ApiError(error, 409, "CONFLICT");
      }
      throw new ApiError(error, 500);
    }

    res.json({
      success: true,
      path: result.path,
    });
  }),
);

export { router as createNamespaceRoutes };
export default router;
