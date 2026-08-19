/**
 * Shared Namespace Deletion Logic
 *
 * DB-GAP-032: REST namespace deletion was missing (DELETE /api/namespaces/:name
 * returned ROUTE_NOT_FOUND — deletion was MCP-only). The deletion core was
 * extracted from deleteNamespaceTool (DOGFOOD-004, src/mcp/tools/namespace.ts)
 * into this module so the MCP tool and the REST route both call the SAME
 * logic: same guards, same path-safety, same idempotency, same no-half-remove
 * behavior on fs failure.
 *
 * Guarantees (inherited from DOGFOOD-004):
 *  - confirm guard: deletion requires confirm === true.
 *  - resolves the REAL path from namespaceMappings, never from the caller-
 *    supplied name joined onto the root.
 *  - path-safety: refuses to delete anything resolving outside the namespaces
 *    root (blocks `../` traversal and malicious mapping values).
 *  - fs.rmSync recursive+force — removes current.jsonl, .git, .embeddings,
 *    everything.
 *  - idempotent: mapping present but dir already gone still succeeds and
 *    cleans up the stale mapping.
 *  - no half-remove: if rmSync throws, the config mapping is left intact and
 *    success:false is returned.
 */

import fs from "fs";
import path from "path";
import { getConfig, updateConfig } from "../config/index";

/**
 * Result of a namespace deletion attempt
 */
export interface DeleteNamespaceResult {
  success: boolean;
  /** Absolute path of the directory that was removed (only on success) */
  path?: string;
  error?: string;
}

/**
 * Delete a namespace directory + its git repo and unregister the mapping.
 *
 * Mirrors the MCP delete_namespace tool contract exactly (DOGFOOD-004):
 * confirm required, "default" blocked, currently-active namespace blocked,
 * path-traversal refused, idempotent, no half-remove on fs error.
 *
 * @param name - Namespace name to delete
 * @param confirm - Must be true to confirm deletion
 * @returns Deletion result
 */
export function deleteNamespace(
  name: string,
  confirm: boolean,
): DeleteNamespaceResult {
  // Require confirmation
  if (!confirm) {
    return {
      success: false,
      error: "Confirmation required. Set confirm=true to delete namespace.",
    };
  }

  const config = getConfig(".");

  // Validate namespace exists
  if (!config.namespaceMappings?.[name]) {
    return {
      success: false,
      error: `Namespace '${name}' not found`,
    };
  }

  // Prevent deleting default namespace
  if (name === "default") {
    return {
      success: false,
      error: "Cannot delete default namespace",
    };
  }

  // Prevent deleting current active namespace
  if (config.defaultNamespace === name) {
    return {
      success: false,
      error:
        "Cannot delete currently active namespace. Switch to a different namespace first.",
    };
  }

  // Resolve the real namespace path from the recorded mapping, then remove
  // the directory recursively before unregistering the mapping. DOGFOOD-004:
  // previously this only removed the config entry, orphaning current.jsonl,
  // .git, and .embeddings on disk — a data-retention surprise for users who
  // expected "delete" to actually delete.
  const recordedPath = config.namespaceMappings?.[name];

  if (recordedPath) {
    // Path-safety guard: the resolved path MUST live inside the namespaces
    // root. This blocks `../` traversal and any mapping pointing outside the
    // root — the deletion MUST NEVER remove an arbitrary filesystem path.
    const namespacesRoot = path.resolve(config.namespacesPath);
    const dirPath = path.resolve(recordedPath);
    const rel = path.relative(namespacesRoot, dirPath);
    const isInside =
      rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));

    if (!isInside) {
      return {
        success: false,
        error: "Refusing to delete path outside namespaces root: " + dirPath,
      };
    }

    // Only remove if the directory actually exists — idempotent: deleting an
    // already-gone namespace (mapping present but dir missing) still succeeds
    // and cleans up the stale mapping.
    if (fs.existsSync(dirPath)) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
      } catch (fsError) {
        // Do NOT half-remove: the directory is still on disk, so leave the
        // config mapping intact and surface the failure to the caller.
        return {
          success: false,
          error:
            "Failed to remove namespace directory: " +
            (fsError instanceof Error ? fsError.message : String(fsError)),
        };
      }
    }
  }

  // Remove from config — only after the directory is gone (or confirmed
  // already-absent), so config never reflects a dir that still exists.
  const { [name]: _, ...rest } = config.namespaceMappings || {};
  updateConfig(".", { namespaceMappings: rest });

  return {
    success: true,
    path: recordedPath ? path.resolve(recordedPath) : undefined,
  };
}
