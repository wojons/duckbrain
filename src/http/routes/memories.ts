/**
 * Memory API Routes
 *
 * Express routes that wrap MCP tool functions (recallTool, rememberTool, forgetTool)
 * per the centralized architecture pattern. All data flows through existing MCP tools.
 */

import { Router, Request, Response } from 'express';
import { recallTool } from '../../mcp/tools/recall';
import { rememberTool } from '../../mcp/tools/remember';
import { forgetTool } from '../../mcp/tools/forget';
import { asyncHandler, ApiError, NotFoundError } from '../middleware/errorHandler';
import { 
  MemoryResponse, 
  MemoryListResponse, 
  CreateMemoryRequest, 
  UpdateMemoryRequest,
  QueryParams 
} from '../types/api';

const router = Router();

/**
 * Transform MCP memory to API response format
 */
function transformMemory(memory: any): MemoryResponse {
  return {
    id: memory.id,
    key: memory.key,
    domain: memory.domain,
    content: memory.embedding_text,
    attributes: memory.attributes || {},
    timestamp: memory.timestamp,
    author: memory.author,
    isTombstone: memory.action === 'tombstone',
    action: memory.action
  };
}

/**
 * GET /api/memories
 * Query memories with filters
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const params: QueryParams = {
    prefix: req.query.prefix as string | undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 50,
    offset: req.query.offset ? parseInt(req.query.offset as string, 10) : 0,
    domain: req.query.domain as string | undefined,
    author: req.query.author as string | undefined,
    query: req.query.q as string | undefined,
    namespace: (req.query.namespace as string) || 'default'
  };

  // Call recallTool with filters
  const result = await recallTool({
    keyPrefix: params.prefix,
    limit: params.limit! + 1, // Fetch one extra to detect hasMore
    domain: params.domain,
    namespace: params.namespace
  });

  if (result.error) {
    throw new ApiError(result.error, 500);
  }

  const memories = result.memories.map(transformMemory);
  
  // Filter by author if specified
  const filteredMemories = params.author 
    ? memories.filter(m => m.author === params.author)
    : memories;

  // Check if there are more results
  const hasMore = filteredMemories.length > params.limit!;
  if (hasMore) {
    filteredMemories.pop(); // Remove the extra item
  }

  // Apply offset
  const offset = params.offset || 0;
  const paginatedMemories = filteredMemories.slice(offset, offset + params.limit!);

  const response: MemoryListResponse = {
    items: paginatedMemories,
    total: filteredMemories.length, // This is approximate
    offset,
    limit: params.limit!,
    hasMore,
    nextOffset: hasMore ? offset + params.limit! : null
  };

  res.json(response);
}));

/**
 * GET /api/memories/key/:key
 * Get single memory by key path
 * Must be defined BEFORE /:id route to avoid conflicts
 */
router.get('/key/:key', asyncHandler(async (req: Request, res: Response) => {
  const { key } = req.params as { key: string };
  const namespace = (req.query.namespace as string) || 'default';

  // Normalize key to start with /
  const normalizedKey = key.startsWith('/') ? key : `/${key}`;

  // Use exact key lookup in DuckDB — no in-memory scan
  const result = await recallTool({
    key: normalizedKey,
    limit: 10,
    namespace
  });

  if (result.error) {
    throw new ApiError(result.error, 500);
  }

  if (result.memories.length === 0) {
    throw new NotFoundError('Memory', key);
  }

  // Return the most recent non-tombstoned memory, or the most recent
  const memory = result.memories.find(m => m.action !== 'tombstone') || result.memories[0];

  res.json(transformMemory(memory));
}));

/**
 * GET /api/memories/:id
 * Get single memory by ID
 */
router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const namespace = (req.query.namespace as string) || 'default';

  // Use exact ID lookup in DuckDB — no in-memory scan
  const result = await recallTool({
    id,
    limit: 1,
    namespace
  });

  if (result.error) {
    throw new ApiError(result.error, 500);
  }

  const memory = result.memories.find(m => m.id === id);

  if (!memory) {
    throw new NotFoundError('Memory', id);
  }

  res.json(transformMemory(memory));
}));

/**
 * POST /api/memories
 * Create a new memory
 */
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as CreateMemoryRequest;

  // Validate required fields
  if (!body.key || !body.domain || !body.content) {
    throw new ApiError('Missing required fields: key, domain, content', 400, 'VALIDATION_ERROR');
  }

  // Call rememberTool to create memory
  const result = await rememberTool({
    key: body.key,
    domain: body.domain as any,
    attributes: body.attributes || {},
    embedding_text: body.content,
    namespace: (req.query.namespace as string) || 'default'
  });

  if (!result.success) {
    throw new ApiError(result.error || 'Failed to create memory', 500);
  }

  // Return the created memory
  const memory: MemoryResponse = {
    id: result.id!,
    key: result.key!,
    domain: body.domain,
    content: body.content,
    attributes: body.attributes || {},
    timestamp: new Date().toISOString(),
    author: result.author!,
    isTombstone: false,
    action: 'add'
  };

  res.status(201).json(memory);
}));

/**
 * PUT /api/memories/:id
 * Update a memory (forget + remember = new version)
 */
router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const body = req.body as UpdateMemoryRequest;
  const namespace = (req.query.namespace as string) || 'default';

  if (!body.content && !body.attributes) {
    throw new ApiError('No update data provided', 400, 'VALIDATION_ERROR');
  }

  // Step 1: Find existing memory by ID directly in DuckDB
  const findResult = await recallTool({
    id,
    limit: 1,
    namespace
  });

  if (findResult.error) {
    throw new ApiError(findResult.error, 500);
  }

  const existingMemory = findResult.memories.find(m => m.id === id);

  if (!existingMemory) {
    throw new NotFoundError('Memory', id);
  }

  // Step 2: Forget the old version (create tombstone)
  const forgetResult = await forgetTool({
    id,
    reason: 'Updated via API',
    namespace
  });

  if (!forgetResult.success) {
    throw new ApiError(forgetResult.error || 'Failed to update memory', 500);
  }

  // Step 3: Remember the new version
  const newContent = body.content || existingMemory.embedding_text;
  const newAttributes = body.attributes 
    ? { ...existingMemory.attributes, ...body.attributes }
    : existingMemory.attributes;

  const rememberResult = await rememberTool({
    key: existingMemory.key,
    domain: existingMemory.domain as any,
    attributes: newAttributes,
    embedding_text: newContent,
    namespace
  });

  if (!rememberResult.success) {
    throw new ApiError(rememberResult.error || 'Failed to create new memory version', 500);
  }

  // Return updated memory
  const memory: MemoryResponse = {
    id: rememberResult.id!,
    key: existingMemory.key,
    domain: existingMemory.domain,
    content: newContent,
    attributes: newAttributes,
    timestamp: new Date().toISOString(),
    author: rememberResult.author!,
    isTombstone: false,
    action: 'update'
  };

  res.json(memory);
}));

/**
 * DELETE /api/memories/:id
 * Delete a memory (create tombstone)
 */
router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const namespace = (req.query.namespace as string) || 'default';

  const result = await forgetTool({
    id,
    reason: 'Deleted via API',
    namespace
  });

  if (!result.success) {
    if (result.error?.includes('not found')) {
      throw new NotFoundError('Memory', id);
    }
    throw new ApiError(result.error || 'Failed to delete memory', 500);
  }

  res.status(204).send();
}));

export { router as createMemoryRoutes };
export default router;
