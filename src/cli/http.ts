/**
 * HTTP MCP Server
 *
 * HTTP server with Streamable HTTP transport for remote MCP access.
 * Includes DNS rebinding protection, authentication, rate limiting, and multi-user endpoints.
 *
 * Endpoints:
 * - POST /mcp, GET /mcp - Streamable HTTP transport
 * - GET /health - Health check (unauthenticated)
 * - GET /stats - System statistics
 * - GET /namespaces - List loaded namespaces
 * - GET /users - List unique authors
 * - GET /activity - Recent activity feed
 * - GET /api/tree - Hierarchical memory tree
 * - GET /api/timeline - Chronological feed
 * - GET /api/search - Search with filters
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { server, stopServer, registerTools } from '../mcp/server.js';
import { authMiddleware, AuthConfig } from '../auth/middleware.js';
import { rateLimitMiddleware, RateLimitConfig } from '../auth/ratelimit.js';
import path from 'path';
import fs from 'fs';

/**
 * HTTP server configuration options
 */
export interface HttpServerOptions {
  /** Port to listen on (default: 3000) */
  port?: number;
  /** Bind to all interfaces (0.0.0.0) instead of localhost only */
  bindAll?: boolean;
  /** Authentication type: none, basic, or apikey */
  authType?: 'none' | 'basic' | 'apikey';
  /** Rate limit: requests per minute per IP (default: 100) */
  rateLimit?: number;
}

/**
 * DNS rebinding protection middleware
 * Validates Host header against allowed hosts
 */
function dnsRebindingProtection(allowedHosts: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const host = req.headers.host?.split(':')[0];
    
    if (!host || !allowedHosts.includes(host)) {
      res.status(403).json({ error: 'Forbidden: Invalid host' });
      return;
    }
    
    next();
  };
}

/**
 * Health check endpoint handler
 */
function healthHandler(req: Request, res: Response) {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
}

/**
 * Stats endpoint handler
 */
function statsHandler(req: Request, res: Response) {
  res.json({
    memory: process.memoryUsage(),
    uptime: process.uptime(),
    nodeVersion: process.version
  });
}

/**
 * Create Express app with MCP transport, auth, and rate limiting
 *
 * Middleware order (critical):
 * 1. DNS rebinding protection (block bad hosts immediately)
 * 2. Rate limiting (catch abuse before auth processing)
 * 3. Authentication (verify credentials)
 * 4. JSON body parser (after rate limit/auth to avoid parsing overhead on rejected requests)
 * 5. Routes
 *
 * @param options - Server configuration options
 */
export function createHttpServer(options: HttpServerOptions = {}): Express {
  const app = express();
  
  // 1. DNS rebinding protection
  const allowedHosts = ['localhost', '127.0.0.1'];
  if (options.bindAll) {
    // When binding to all interfaces, allow any hostname
    // User explicitly chose to expose the server
    app.use((req: Request, res: Response, next: NextFunction) => {
      next(); // Skip DNS rebinding check when bindAll
    });
  } else {
    app.use(dnsRebindingProtection(allowedHosts));
  }
  
  // 2. Rate limiting (before auth to prevent credential stuffing/brute force)
  const rateLimitConfig: RateLimitConfig = {
    requestsPerMinute: options.rateLimit ?? 100
  };
  app.use(rateLimitMiddleware(rateLimitConfig));
  
  // 3. Authentication
  const authConfig: AuthConfig = {
    type: options.authType ?? 'none'
  };
  app.use(authMiddleware(authConfig));
  
  // 4. JSON body parser (after rate limit and auth)
  app.use(express.json());
  
  // Health check (bypasses auth via middleware, must be registered here)
  app.get('/health', healthHandler);
  
  // Stats
  app.get('/stats', statsHandler);
  
  // Namespaces list (stub - to be implemented)
  app.get('/namespaces', (req: Request, res: Response) => {
    res.json({ namespaces: ['default'] });
  });
  
  // Users list (stub - to be implemented)
  app.get('/users', (req: Request, res: Response) => {
    res.json({ users: [] });
  });
  
  // Activity feed (stub - to be implemented)
  app.get('/activity', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    res.json({ activities: [], limit });
  });
  
  // API: Memory tree (stub - to be implemented)
  app.get('/api/tree', (req: Request, res: Response) => {
    res.json({ tree: [] });
  });
  
  // API: Timeline (stub - to be implemented)
  app.get('/api/timeline', (req: Request, res: Response) => {
    res.json({ timeline: [] });
  });
  
  // API: Search (stub - to be implemented)
  app.get('/api/search', (req: Request, res: Response) => {
    res.json({ results: [] });
  });
  
  // Streamable HTTP transport for MCP
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  
  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      // Ensure tools are registered before handling MCP requests
      registerTools();
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('MCP request error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  
  app.get('/mcp', async (req: Request, res: Response) => {
    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('MCP GET error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  
  return app;
}

/**
 * Start HTTP server
 *
 * @param options Server options
 */
export async function startHttpMode(options: { port?: number; host?: string } = {}): Promise<void> {
  const { port = 3000, host = '127.0.0.1' } = options;
  
  try {
    const app = createHttpServer();
    
    // Start server
    await new Promise<void>((resolve, reject) => {
      const httpServer = app.listen(port, host, () => {
        console.error(`[duckbrain] HTTP server started at http://${host}:${port}`);
        
        // Write PID to local file for easy management
        const pidFile = path.join(process.cwd(), 'duckbrain-http.pid');
        fs.writeFileSync(pidFile, process.pid.toString());
        console.error(`[duckbrain] PID written to: ${pidFile}`);
        
        resolve();
      });
      
      httpServer.on('error', reject);
      
      // Graceful shutdown
      const shutdown = () => {
        // Remove PID file on shutdown
        const pidFile = path.join(process.cwd(), 'duckbrain-http.pid');
        try {
          if (fs.existsSync(pidFile)) {
            fs.unlinkSync(pidFile);
          }
        } catch (e) {
          // Ignore cleanup errors
        }
        
        httpServer.close(async () => {
          await stopServer();
          process.exit(0);
        });
      };
      
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
  } catch (error) {
    console.error('[duckbrain] Failed to start HTTP server:', error);
    process.exit(1);
  }
}

// Auto-start if run directly
if (process.argv[1]?.endsWith('http.ts') || process.argv[1]?.endsWith('http.js')) {
  startHttpMode().catch((error: unknown) => {
    console.error('[duckbrain] Unhandled error:', error);
    process.exit(1);
  });
}
