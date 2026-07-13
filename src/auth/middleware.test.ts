/**
 * Authentication Middleware Tests
 *
 * Tests for basic auth, API key auth, and health endpoint bypass.
 */

import { describe, it, expect, vi } from 'vitest';
import { authMiddleware, requireAuth, AuthConfig } from './middleware.js';
import { Request, Response, NextFunction } from 'express';

// Helper to create mock request/response/next
function mockReq(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    path: '/',
    headers: {},
    ip: '127.0.0.1',
    ...overrides,
  } as Partial<Request>;
}

function mockRes(): { res: Partial<Response>; json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> } {
  const json = vi.fn().mockReturnThis();
  const status = vi.fn().mockReturnValue({ json });
  return {
    res: {
      status,
      json,
    } as Partial<Response>,
    json,
    status,
  };
}

function mockNext(): NextFunction {
  return vi.fn();
}

describe('authMiddleware', () => {
  describe('type=none', () => {
    it('should allow all requests when type is none', () => {
      const config: AuthConfig = { type: 'none' };
      const middleware = authMiddleware(config);
      const req = mockReq();
      const { res } = mockRes();
      const next = mockNext();

      middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('type=basic', () => {
    it('should return 401 when no Authorization header is provided', async () => {
      const config: AuthConfig = {
        type: 'basic',
        users: [{ username: 'admin', passwordHash: '$2a$10$testhashedpassword' }],
      };
      const middleware = authMiddleware(config);
      const req = mockReq({ path: '/namespaces' });
      const { res, status } = mockRes();
      const next = mockNext();

      await middleware(req as Request, res as Response, next);

      expect(status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when Authorization header has wrong scheme', async () => {
      const config: AuthConfig = {
        type: 'basic',
        users: [{ username: 'admin', passwordHash: '$2a$10$testhashedpassword' }],
      };
      const middleware = authMiddleware(config);
      const req = mockReq({
        path: '/namespaces',
        headers: { authorization: 'Bearer sometoken' },
      });
      const { res, status } = mockRes();
      const next = mockNext();

      await middleware(req as Request, res as Response, next);

      expect(status).toHaveBeenCalledWith(401);
    });

    it('should return 401 for invalid credentials', async () => {
      const config: AuthConfig = {
        type: 'basic',
        users: [{ username: 'admin', passwordHash: '$2a$10$testhashedpassword' }],
      };
      const middleware = authMiddleware(config);
      // Base64 encode "admin:wrongpassword"
      const encoded = Buffer.from('admin:wrongpassword').toString('base64');
      const req = mockReq({
        path: '/namespaces',
        headers: { authorization: `Basic ${encoded}` },
      });
      const { res, status } = mockRes();
      const next = mockNext();

      await middleware(req as Request, res as Response, next);

      expect(status).toHaveBeenCalledWith(401);
    });

    it('should call next() for valid credentials', async () => {
      // We'll use bcryptjs to generate a real hash for testing
      const bcrypt = await import('bcryptjs');
      const hash = await bcrypt.hash('testpass123', 4);

      const config: AuthConfig = {
        type: 'basic',
        users: [{ username: 'admin', passwordHash: hash }],
      };
      const middleware = authMiddleware(config);
      const encoded = Buffer.from('admin:testpass123').toString('base64');
      const req = mockReq({
        path: '/namespaces',
        headers: { authorization: `Basic ${encoded}` },
      });
      const { res } = mockRes();
      const next = mockNext();

      await middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('type=apikey', () => {
    it('should return 401 when no X-API-Key header is provided', () => {
      const config: AuthConfig = {
        type: 'apikey',
        apiKeys: [{ key: 'my-secret-key', name: 'test-key' }],
      };
      const middleware = authMiddleware(config);
      const req = mockReq({ path: '/namespaces' });
      const { res, status } = mockRes();
      const next = mockNext();

      middleware(req as Request, res as Response, next);

      expect(status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 for invalid API key', () => {
      const config: AuthConfig = {
        type: 'apikey',
        apiKeys: [{ key: 'my-secret-key', name: 'test-key' }],
      };
      const middleware = authMiddleware(config);
      const req = mockReq({
        path: '/namespaces',
        headers: { 'x-api-key': 'wrong-key' },
      });
      const { res, status } = mockRes();
      const next = mockNext();

      middleware(req as Request, res as Response, next);

      expect(status).toHaveBeenCalledWith(401);
    });

    it('should call next() for valid API key', () => {
      const config: AuthConfig = {
        type: 'apikey',
        apiKeys: [{ key: 'my-secret-key', name: 'test-key' }],
      };
      const middleware = authMiddleware(config);
      const req = mockReq({
        path: '/namespaces',
        headers: { 'x-api-key': 'my-secret-key' },
      });
      const { res } = mockRes();
      const next = mockNext();

      middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('health endpoint bypass', () => {
    it('should bypass auth for /health endpoint regardless of auth type', () => {
      const config: AuthConfig = {
        type: 'basic',
        users: [{ username: 'admin', passwordHash: 'hash' }],
      };
      const middleware = authMiddleware(config);
      const req = mockReq({ path: '/health' });
      const { res } = mockRes();
      const next = mockNext();

      middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalled();
    });

    it('should bypass auth for /health with API key auth type', () => {
      const config: AuthConfig = {
        type: 'apikey',
        apiKeys: [{ key: 'key123', name: 'test' }],
      };
      const middleware = authMiddleware(config);
      const req = mockReq({ path: '/health' });
      const { res } = mockRes();
      const next = mockNext();

      middleware(req as Request, res as Response, next);

      expect(next).toHaveBeenCalled();
    });
  });
});

describe('requireAuth', () => {
  it('should return 401 if no user is authenticated', () => {
    const req = mockReq();
    const { res, status } = mockRes();
    const next = mockNext();

    requireAuth(req as Request, res as Response, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should call next() if user is authenticated', () => {
    const req = mockReq();
    (req as any).user = { username: 'admin' };
    const { res } = mockRes();
    const next = mockNext();

    requireAuth(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });
});
