/**
 * Shared utility functions for MCP tools
 */

import path from "path";
import { getConfig } from "../../config/index";

/**
 * Resolve a namespace name from a namespace argument.
 *
 * Falls back to config's defaultNamespace when no namespace is provided, and
 * 'default' when the config has none set. The config defaultNamespace is the
 * ACTIVE namespace — switch_namespace persists it into duckbrain.config.json,
 * so it is sticky across processes (DOGFOOD-017).
 */
export function resolveNamespaceName(namespace?: string): string {
  const config = getConfig(".");
  return namespace || config.defaultNamespace || "default";
}

/**
 * Resolve a namespace name to its filesystem path
 *
 * Uses the config-based namespacesPath from duckbrain.config.json.
 * Falls back to './namespaces' if not configured, and 'default' if no namespace provided.
 */
export function resolveNamespacePath(namespace?: string): string {
  const config = getConfig(".");
  const ns = resolveNamespaceName(namespace);
  const nsPath = config.namespacesPath || "./namespaces";
  return path.join(nsPath, ns);
}
