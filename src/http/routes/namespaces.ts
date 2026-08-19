/**
 * Namespace API Routes
 *
 * Express routes that wrap MCP namespace tool functions.
 * Provides namespace management for multi-repo support.
 */

import { Router, Request, Response } from "express";
import {
  listNamespacesTool,
  createNamespaceTool,
  switchNamespaceTool,
} from "../../mcp/tools/namespace";
import { deleteNamespace } from "../../namespaces/delete";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { NamespaceListResponse, NamespaceResponse } from "../types/api";
import { requireNamespaceGrant } from "../../auth/middleware";

const router: Router = Router();

/**
 * Transform MCP namespace to API response
 */
function transformNamespace(ns: any): NamespaceResponse {
  return {
    name: ns.name,
    path: ns.path,
    isDefault: ns.isDefault,
    memoryCount: undefined, // Would require expensive query
    lastModified: undefined,
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

    const namespaces = result.namespaces.map(transformNamespace);

    const response: NamespaceListResponse = {
      namespaces,
      currentNamespace: result.currentNamespace || "default",
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
