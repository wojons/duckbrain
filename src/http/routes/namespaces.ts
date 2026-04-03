/**
 * Namespace API Routes
 *
 * Express routes that wrap MCP namespace tool functions.
 * Provides namespace management for multi-repo support.
 */

import { Router, Request, Response } from 'express';
import { 
  listNamespacesTool, 
  createNamespaceTool, 
  switchNamespaceTool 
} from '../../mcp/tools/namespace';
import { asyncHandler, ApiError } from '../middleware/errorHandler';
import { NamespaceListResponse, NamespaceResponse } from '../types/api';

const router = Router();

/**
 * Transform MCP namespace to API response
 */
function transformNamespace(ns: any): NamespaceResponse {
  return {
    name: ns.name,
    path: ns.path,
    isDefault: ns.isDefault,
    memoryCount: undefined, // Would require expensive query
    lastModified: undefined
  };
}

/**
 * GET /api/namespaces
 * List all namespaces
 */
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const result = await listNamespacesTool({});

  if (!result.success) {
    throw new ApiError(result.error || 'Failed to list namespaces', 500);
  }

  const namespaces = result.namespaces.map(transformNamespace);

  const response: NamespaceListResponse = {
    namespaces,
    currentNamespace: result.currentNamespace || 'default'
  };

  res.json(response);
}));

/**
 * POST /api/namespaces
 * Create a new namespace
 */
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { name, setDefault } = req.body;

  if (!name || typeof name !== 'string') {
    throw new ApiError('Name is required', 400, 'VALIDATION_ERROR');
  }

  // Validate namespace name format
  if (!/^[a-z0-9_-]+$/.test(name)) {
    throw new ApiError(
      'Namespace name must be lowercase alphanumeric with hyphens/underscores only',
      400,
      'VALIDATION_ERROR'
    );
  }

  const result = await createNamespaceTool({
    name,
    setDefault: setDefault ?? false
  });

  if (!result.success) {
    if (result.error?.includes('already exists')) {
      throw new ApiError(result.error, 409, 'CONFLICT');
    }
    throw new ApiError(result.error || 'Failed to create namespace', 500);
  }

  const namespace: NamespaceResponse = {
    name,
    path: result.path!,
    isDefault: setDefault ?? false
  };

  res.status(201).json(namespace);
}));

/**
 * POST /api/namespaces/switch
 * Switch to a different namespace
 */
router.post('/switch', asyncHandler(async (req: Request, res: Response) => {
  const { name } = req.body;

  if (!name || typeof name !== 'string') {
    throw new ApiError('Name is required', 400, 'VALIDATION_ERROR');
  }

  const result = await switchNamespaceTool({ name });

  if (!result.success) {
    if (result.error?.includes('not found')) {
      throw new ApiError(result.error, 404, 'NOT_FOUND');
    }
    throw new ApiError(result.error || 'Failed to switch namespace', 500);
  }

  res.json({
    success: true,
    previous: result.previous,
    current: result.current
  });
}));

export { router as createNamespaceRoutes };
export default router;
