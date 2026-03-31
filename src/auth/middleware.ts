/**
 * Authentication Middleware
 *
 * Provides configurable authentication for the HTTP server.
 * Supports three modes: none, basic (HTTP Basic Auth with bcrypt),
 * and apikey (X-API-Key header).
 *
 * Health endpoint (/health) always bypasses authentication.
 */

import bcrypt from 'bcryptjs';
import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Authentication configuration
 */
export interface AuthConfig {
  /** Auth type: 'none' = no auth, 'basic' = HTTP Basic, 'apikey' = API key header */
  type: 'none' | 'basic' | 'apikey';
  /** Users for basic auth (passwords stored as bcrypt hashes) */
  users?: Array<{ username: string; passwordHash: string }>;
  /** API keys for apikey auth */
  apiKeys?: Array<{ key: string; name: string }>;
}

/**
 * Create authentication middleware based on config
 *
 * @param config - Authentication configuration
 * @returns Express middleware
 */
export function authMiddleware(config: AuthConfig): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Always allow health endpoint — pre-auth health check
    if (req.path === '/health') {
      return next();
    }

    // No auth required
    if (config.type === 'none') {
      return next();
    }

    // HTTP Basic Auth
    if (config.type === 'basic') {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.status(401).json({ error: 'Unauthorized: Basic auth required' });
        return;
      }

      try {
        const encoded = authHeader.slice(6); // Remove "Basic "
        const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
        const colonIndex = decoded.indexOf(':');
        if (colonIndex === -1) {
          res.status(401).json({ error: 'Unauthorized: Invalid credentials format' });
          return;
        }

        const username = decoded.slice(0, colonIndex);
        const password = decoded.slice(colonIndex + 1);

        const user = config.users?.find(u => u.username === username);
        if (!user) {
          res.status(401).json({ error: 'Unauthorized: Invalid credentials' });
          return;
        }

        // Verify bcrypt hash
        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
          res.status(401).json({ error: 'Unauthorized: Invalid credentials' });
          return;
        }

        // Attach user info to request for downstream use
        (req as any).user = { username };
        return next();
      } catch {
        res.status(401).json({ error: 'Unauthorized: Invalid credentials' });
        return;
      }
    }

    // API Key Auth
    if (config.type === 'apikey') {
      const apiKey = req.headers['x-api-key'] as string | undefined;
      if (!apiKey) {
        res.status(401).json({ error: 'Unauthorized: API key required' });
        return;
      }

      const keyEntry = config.apiKeys?.find(k => k.key === apiKey);
      if (!keyEntry) {
        res.status(401).json({ error: 'Unauthorized: Invalid API key' });
        return;
      }

      // Attach key info to request
      (req as any).user = { name: keyEntry.name, authenticated: true };
      return next();
    }

    // Unknown auth type — deny by default
    res.status(500).json({ error: 'Unknown auth type' });
  };
}

/**
 * Require authentication — use after authMiddleware to ensure user is set
 * Useful for protecting specific routes
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!(req as any).user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}
