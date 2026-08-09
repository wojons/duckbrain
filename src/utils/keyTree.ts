/**
 * Shared key-tree utilities
 *
 * The hierarchical tree builder used by the REST `/api/keys` route, plus a
 * plain-text renderer used by the human CLI (`list-keys`). Both surfaces share
 * one builder so the CLI tree and the API tree can never drift apart.
 */

import { KeyNode } from "../http/types/api";

/**
 * Build hierarchical tree from flat key list.
 *
 * Keys are stored with a leading slash (e.g. "/projects/duckbrain/status");
 * empty segments produced by splitting on "/" are filtered out so the root
 * level starts at the first real segment.
 */
export function buildKeyTree(keys: string[], maxDepth: number = 10): KeyNode[] {
  const root: KeyNode[] = [];
  const nodeMap = new Map<string, KeyNode>();

  // Sort keys for consistent ordering
  const sortedKeys = [...keys].sort();

  for (const key of sortedKeys) {
    const parts = key.split("/").filter((p) => p !== "");
    let currentPath = "";

    for (let i = 0; i < Math.min(parts.length, maxDepth); i++) {
      const part = parts[i];
      const parentPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${part}` : `/${part}`;

      // Create node if it doesn't exist
      if (!nodeMap.has(currentPath)) {
        const node: KeyNode = {
          id: currentPath,
          name: part,
          path: currentPath,
          type: i === parts.length - 1 ? "memory" : "folder",
          children: [],
          isExpanded: false,
          memoryCount: 0,
        };

        nodeMap.set(currentPath, node);

        // Add to parent's children or root
        if (parentPath) {
          const parent = nodeMap.get(parentPath);
          if (parent) {
            parent.children!.push(node);
            parent.type = "folder";
          }
        } else {
          root.push(node);
        }
      }

      // Increment memory count for all parent nodes
      let countPath = currentPath;
      while (countPath) {
        const node = nodeMap.get(countPath);
        if (node) {
          node.memoryCount = (node.memoryCount || 0) + 1;
        }
        // Get parent path
        const lastSlash = countPath.lastIndexOf("/");
        countPath = lastSlash > 0 ? countPath.substring(0, lastSlash) : "";
      }
    }
  }

  return root;
}

/**
 * Render a key tree as indented plain text for terminal output.
 *
 * Folders are printed with a trailing slash so they are distinguishable from
 * memory leaves. Each line shows the full key path, indented two spaces per
 * depth level, e.g.:
 *
 *   /projects/
 *     /projects/duckbrain/
 *       /projects/duckbrain/status
 *
 * Returns an empty string for an empty tree (caller decides the empty-state
 * message).
 */
export function renderKeyTreeText(nodes: KeyNode[]): string {
  const lines: string[] = [];

  const walk = (node: KeyNode, depth: number): void => {
    const indent = "  ".repeat(depth);
    const label = node.type === "folder" ? `${node.path}/` : node.path;
    lines.push(`${indent}${label}`);
    for (const child of node.children ?? []) {
      walk(child, depth + 1);
    }
  };

  for (const node of nodes) {
    walk(node, 0);
  }

  return lines.join("\n");
}
