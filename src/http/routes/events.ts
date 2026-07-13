/**
 * Server-Sent Events API Routes
 *
 * Express routes for SSE endpoint providing real-time updates.
 * Note: Full event publishing integration with memory changes to be enhanced later.
 */

import { Router, Request, Response } from 'express';
import { asyncHandler, ApiError } from '../middleware/errorHandler';

const router = Router();

/**
 * Active SSE connections by namespace
 */
const activeConnections = new Map<string, Response[]>();

/**
 * GET /api/events/:namespace
 * Server-Sent Events endpoint for real-time updates
 */
router.get('/:namespace', asyncHandler(async (req: Request, res: Response) => {
  const { namespace } = req.params as { namespace: string };

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*'); // CORS for SSE

  // Send initial connection event
  res.write(`data: ${JSON.stringify({
    type: 'connected',
    timestamp: new Date().toISOString(),
    namespace
  })}\n\n`);

  // Track connection
  if (!activeConnections.has(namespace)) {
    activeConnections.set(namespace, []);
  }
  activeConnections.get(namespace)!.push(res);

  // Handle client disconnect
  req.on('close', () => {
    const connections = activeConnections.get(namespace);
    if (connections) {
      const index = connections.indexOf(res);
      if (index > -1) {
        connections.splice(index, 1);
      }
      // Clean up empty namespace entries
      if (connections.length === 0) {
        activeConnections.delete(namespace);
      }
    }
  });

  // Send heartbeat every 30 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(`:heartbeat\n\n`);
  }, 30000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
  });
}));

/**
 * POST /api/events/:namespace/broadcast (internal endpoint)
 * Broadcast an event to all connected clients in a namespace
 * Note: This is for future integration with memory operations
 */
router.post('/:namespace/broadcast', asyncHandler(async (req: Request, res: Response) => {
  const { namespace } = req.params as { namespace: string };
  const { type, data } = req.body;

  if (!type) {
    throw new ApiError('Event type is required', 400, 'VALIDATION_ERROR');
  }

  const event = {
    type,
    data: data || {},
    timestamp: new Date().toISOString()
  };

  const connections = activeConnections.get(namespace);
  const sentCount = connections?.length || 0;

  // Send to all connected clients
  if (connections) {
    connections.forEach(client => {
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    });
  }

  res.json({
    success: true,
    namespace,
    connectionsNotified: sentCount,
    event
  });
}));

/**
 * GET /api/events/:namespace/stats
 * Get SSE connection statistics
 */
router.get('/:namespace/stats', asyncHandler(async (req: Request, res: Response) => {
  const { namespace } = req.params as { namespace: string };
  const connections = activeConnections.get(namespace) || [];

  res.json({
    namespace,
    activeConnections: connections.length,
    allNamespaces: Array.from(activeConnections.keys()).map(ns => ({
      namespace: ns,
      connections: activeConnections.get(ns)?.length || 0
    }))
  });
}));

export { router as createEventsRoutes };
export default router;
