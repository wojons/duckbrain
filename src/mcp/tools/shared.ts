/**
 * Shared utility functions for MCP tools
 */

import path from 'path';
import { getConfig } from '../../config/index';

/**
 * Resolve a namespace name to its filesystem path
 *
 * Uses the config-based namespacesPath from duckbrain.config.json.
 * Falls back to './namespaces' if not configured, and 'default' if no namespace provided.
 */
export function resolveNamespacePath(namespace?: string): string {
  const config = getConfig('.');
  const ns = namespace || config.defaultNamespace || 'default';
  const nsPath = config.namespacesPath || './namespaces';
  return path.join(nsPath, ns);
}
