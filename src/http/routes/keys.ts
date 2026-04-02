/**
 * Keys API Routes
 *
 * Express routes that wrap the listKeysTool MCP function.
 * Provides hierarchical key tree structure for the file-explorer UI.
 */

import { Router, Request, Response } from 'express';
import { listKeysTool } from '../../mcp/tools/list_keys';
import { asyncHandler, ApiError } from '../middleware/errorHandler';
import { KeyNode, KeyTreeResponse } from '../types/api';

const router = Router();

/**
 * Build hierarchical tree from flat key list
 */
function buildKeyTree(keys: string[], maxDepth: number = 10): KeyNode[] {
  const root: KeyNode[] = [];
  const nodeMap = new Map<string, KeyNode>();

  // Sort keys for consistent ordering
  const sortedKeys = [...keys].sort();

  for (const key of sortedKeys) {
    const parts = key.split('/').filter(p => p !== '');
    let currentPath = '';

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
          type: i === parts.length - 1 ? 'memory' : 'folder',
          children: [],
          isExpanded: false,
          memoryCount: 0
        };

        nodeMap.set(currentPath, node);

        // Add to parent's children or root
        if (parentPath) {
          const parent = nodeMap.get(parentPath);
          if (parent) {
            parent.children!.push(node);
            parent.type = 'folder';
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
        const lastSlash = countPath.lastIndexOf('/');
        countPath = lastSlash > 0 ? countPath.substring(0, lastSlash) : '';
      }
    }
  }

  return root;
}

/**
 * GET /api/keys
 * Get hierarchical key tree
 * 
 * Query params:
 * - prefix: Key prefix filter (e.g., /projects/)
 * - depth: Max hierarchy depth (default: 10)
 * - limit: Max keys to return (default: 100)
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const prefix = (req.query.prefix as string) || '/';
  const depth = req.query.depth ? parseInt(req.query.depth as string, 10) : 10;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
  const namespace = (req.query.namespace as string) || 'default';

  // Call listKeysTool to get flat key list
  const result = await listKeysTool({
    prefix,
    maxDepth: depth,
    limit,
    offset: 0,
    namespace
  });

  if (result.error) {
    throw new ApiError(result.error, 500);
  }

  // Build hierarchical tree
  const tree = buildKeyTree(result.keys, depth);

  const response: KeyTreeResponse = {
    tree,
    total: result.keys.length
  };

  res.json(response);
}));

/**
 * GET /api/keys/flat
 * Get flat list of keys (for autocomplete, etc.)
 * 
 * Query params:
 * - prefix: Key prefix filter
 * - limit: Max keys (default: 100)
 * - offset: Pagination offset
 */
router.get('/flat', asyncHandler(async (req: Request, res: Response) => {
  const prefix = (req.query.prefix as string) || '/';
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
  const namespace = (req.query.namespace as string) || 'default';

  const result = await listKeysTool({
    prefix,
    maxDepth: 1, // Flat list doesn't need depth
    limit: limit + 1, // Fetch one extra to detect hasMore
    offset,
    namespace
  });

  if (result.error) {
    throw new ApiError(result.error, 500);
  }

  const hasMore = result.hasMore;
  const keys = result.keys.slice(0, limit);

  res.json({
    keys,
    total: keys.length,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
    prefixes: result.prefixes
  });
}));

export { router as createKeyRoutes };
export default router;
