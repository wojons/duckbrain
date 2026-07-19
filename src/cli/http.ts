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
import { errorHandler, notFoundHandler } from '../http/middleware/errorHandler.js';
import { listNamespacesTool } from '../mcp/tools/namespace.js';
import { createMemoryRoutes } from '../http/routes/memories.js';
import { createKeyRoutes } from '../http/routes/keys.js';
import { createNamespaceRoutes } from '../http/routes/namespaces.js';
import { createEventsRoutes } from '../http/routes/events.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

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
function healthHandler(_req: Request, res: Response) {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
}

/**
 * Stats endpoint handler
 */
function statsHandler(_req: Request, res: Response) {
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
    app.use((_req: Request, _res: Response, next: NextFunction) => {
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
  
  // 3. Authentication — read credentials from ~/.duckbrain/auth.json if available
  const authConfig: AuthConfig = {
    type: options.authType ?? 'none'
  };
  const authFilePath = path.join(os.homedir(), '.duckbrain', 'auth.json');
  if (fs.existsSync(authFilePath)) {
    try {
      const authFile = JSON.parse(fs.readFileSync(authFilePath, 'utf-8'));
      if (authFile.users) authConfig.users = authFile.users;
      if (authFile.apiKeys) authConfig.apiKeys = authFile.apiKeys;
    } catch {
      console.error('[duckbrain] Warning: Could not parse auth.json');
    }
  }
  app.use(authMiddleware(authConfig));
  
  // 4. CORS middleware for UI development
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }
    
    next();
  });
  
  // 5. JSON body parser (after rate limit and auth)
  app.use(express.json());
  
  // Health check (bypasses auth via middleware, must be registered here)
  app.get('/health', healthHandler);
  
  // Stats
  app.get('/stats', statsHandler);
  
  // API Routes (new REST API)
  app.use('/api/memories', createMemoryRoutes);
  app.use('/api/keys', createKeyRoutes);
  app.use('/api/namespaces', createNamespaceRoutes);
  app.use('/api/events', createEventsRoutes);
  
  // Legacy namespaces — delegate to real MCP tool
  app.get('/namespaces', async (_req: Request, res: Response) => {
    const result = await listNamespacesTool({});
    if (!result.success) {
      res.status(500).json({ error: result.error || 'Failed to list namespaces' });
      return;
    }
    const namespaces = result.namespaces.map((ns: any) => ns.name);
    res.json({ namespaces, currentNamespace: result.currentNamespace });
  });

  // Users list (deprecated — no user data in DuckBrain)
  app.get('/users', (_req: Request, res: Response) => {
    res.status(410).json({
      error: 'The /users endpoint has been removed. Use the MCP tools or REST API to access memory data.',
      code: 'ENDPOINT_DEPRECATED'
    });
  });

  // Activity feed (deprecated — no activity data in DuckBrain)
  app.get('/activity', (_req: Request, res: Response) => {
    res.status(410).json({
      error: 'The /activity endpoint has been removed. Use the MCP tools or REST API to access event data.',
      code: 'ENDPOINT_DEPRECATED'
    });
  });
  
  // Legacy API stubs (redirect to new endpoints)
  app.get('/api/tree', (req: Request, res: Response) => {
    res.redirect(301, '/api/keys?prefix=' + (req.query.prefix || '/'));
  });
  
  app.get('/api/timeline', (req: Request, res: Response) => {
    res.redirect(301, '/api/memories?limit=' + (req.query.limit || '50'));
  });
  
  app.get('/api/search', (req: Request, res: Response) => {
    res.redirect(301, '/api/memories?q=' + (req.query.q || ''));
  });
  
  // Error handling (must be after all routes)
  app.use(errorHandler);
  app.use(notFoundHandler);
  
  // CLI remote execution endpoint (for --socket usage)
  // Whitelist: only safe/non-destructive CLI commands allowed via remote socket.
  // Blocked: stdio (launches MCP server), http (launches HTTP server),
  //          service (systemd management — stop/restart could take down the daemon).
  const CLI_COMMAND_WHITELIST = new Set([
    'remember', 'recall', 'list-keys', 'forget',
    'config', 'namespaces', 'namespace',
    'pull', 'push', 'remote',
    'status', 'token', 'squash',
    'ssh-test', 'ssh-connect', 'servers',
  ]);

  app.post('/cli', async (req: Request, res: Response) => {
    try {
      const { command, args: cmdArgs } = req.body;

      // Input validation: command must be a non-empty string
      if (!command || typeof command !== 'string') {
        res.status(400).json({ error: 'Missing or invalid command' });
        return;
      }

      // Command whitelist: reject disallowed commands
      if (!CLI_COMMAND_WHITELIST.has(command)) {
        res.status(403).json({ error: `Command not allowed: ${command}` });
        return;
      }

      // Args must be an array of strings (or absent)
      if (cmdArgs !== undefined && (!Array.isArray(cmdArgs) || cmdArgs.some((a: any) => typeof a !== 'string'))) {
        res.status(400).json({ error: 'args must be an array of strings' });
        return;
      }

      const { execFile } = await import('child_process');
      const binPath = path.resolve(process.cwd(), 'bin/duckbrain.ts');
      const fullArgs = [binPath, command, ...(cmdArgs || [])];

      execFile('npx', ['tsx', ...fullArgs], {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        cwd: process.cwd(),
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      }, (err: any, stdout: string, stderr: string) => {
        if (err) {
          const output = [stderr, stdout].filter(Boolean).join('\n').trim();
          res.json({ error: output || err.message, exitCode: err.code || 1 });
          return;
        }
        const output = stdout.trim();
        const errOutput = stderr.trim();
        res.json({ output, error: errOutput || undefined, exitCode: 0 });
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal error' });
    }
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
export async function startHttpMode(options: HttpServerOptions = {}): Promise<void> {
  const { port = 3000, bindAll = false } = options;
  const host = bindAll ? '0.0.0.0' : '127.0.0.1';
  
  try {
    const app = createHttpServer(options);
    
    // Start server
    await new Promise<void>((resolve, reject) => {
      const httpServer = app.listen(port, host, () => {
        console.error(`[duckbrain] HTTP server started at http://${host}:${port}`);
        
        // Write PID to local file for easy management
        const pidFile = path.join(process.env.DUCKBRAIN_DATA_DIR || os.tmpdir(), 'duckbrain-http.pid');
        fs.writeFileSync(pidFile, process.pid.toString());
        console.error(`[duckbrain] PID written to: ${pidFile}`);
        
        resolve();
      });
      
      httpServer.on('error', reject);
      
      // Graceful shutdown
      const shutdown = () => {
        // Remove PID file on shutdown
        const pidFile = path.join(process.env.DUCKBRAIN_DATA_DIR || os.tmpdir(), 'duckbrain-http.pid');
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
