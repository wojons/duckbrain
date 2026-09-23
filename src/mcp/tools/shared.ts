/**
 * Shared utility functions for MCP tools
 */

import path from "path";
import {
  getConfig,
  resolveDuckbrainRoot,
  resolveNamespacesPath,
} from "../../config/index";

/**
 * Resolve a namespace name from a namespace argument.
 *
 * Falls back to config's defaultNamespace when no namespace is provided, and
 * 'default' when the config has none set. The config defaultNamespace is the
 * ACTIVE namespace — switch_namespace persists it into duckbrain.config.json,
 * so it is sticky across processes (DOGFOOD-017).
 *
 * GAP-062: read from the config file that OWNS this duckbrain instance
 * (`resolveDuckbrainRoot()`), never from whatever `duckbrain.config.json`
 * happens to sit next to the caller's cwd — otherwise a CLI invoked from an
 * unrelated checkout picks up a foreign defaultNamespace.
 */
export function resolveNamespaceName(namespace?: string): string {
  const config = getConfig(resolveDuckbrainRoot());
  return namespace || config.defaultNamespace || "default";
}

/**
 * Resolve a namespace name to its filesystem path
 *
 * Uses the config-based namespacesPath from duckbrain.config.json, resolved
 * against the duckbrain root — the directory holding that config file
 * (`resolveNamespacesPath()`, GAP-062). The returned path is ALWAYS absolute,
 * so a write from an unrelated cwd can never create `<cwd>/namespaces/<ns>`.
 * Falls back to 'default' if no namespace is provided.
 */
export function resolveNamespacePath(namespace?: string): string {
  const ns = resolveNamespaceName(namespace);
  return path.join(resolveNamespacesPath(), ns);
}
