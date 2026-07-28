/**
 * Unit tests for Namespace API routes (namespaces.ts)
 *
 * Tests route handlers with mocked MCP namespace tools.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';

// Mock MCP namespace tools before importing the route
vi.mock('../../mcp/tools/namespace', () => ({
  listNamespacesTool: vi.fn(),
  createNamespaceTool: vi.fn(),
  switchNamespaceTool: vi.fn(),
}));

import {
  listNamespacesTool,
  createNamespaceTool,
  switchNamespaceTool,
} from '../../mcp/tools/namespace';
import { createNamespaceRoutes } from './namespaces';

const mockedListNamespaces = vi.mocked(listNamespacesTool);
const mockedCreateNamespace = vi.mocked(createNamespaceTool);
const mockedSwitchNamespace = vi.mocked(switchNamespaceTool);

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/namespaces', createNamespaceRoutes);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || 'Internal server error',
      code: err.code,
    });
  });
  return app;
}

function httpRequest(
  app: express.Express,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr !== 'string' ? addr.port : 0;
      const http = require('http');
      const options: any = {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: { 'Host': 'localhost', 'Content-Type': 'application/json' },
      };
      const req = http.request(options, (res: any) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          server.close();
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      req.on('error', (err: Error) => {
        server.close();
        reject(err);
      });
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  });
}

describe('GET /api/namespaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 200 with namespaces list', async () => {
    mockedListNamespaces.mockResolvedValue({
      success: true,
      namespaces: [
        { name: 'default', path: '/data/default', isDefault: true },
        { name: 'work', path: '/data/work', isDefault: false },
      ],
      currentNamespace: 'default',
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, 'GET', '/api/namespaces');

    expect(status).toBe(200);
    expect(body.namespaces).toHaveLength(2);
    expect(body.namespaces[0].name).toBe('default');
    expect(body.namespaces[1].name).toBe('work');
    expect(body.currentNamespace).toBe('default');
  });

  it('should return 500 when listNamespacesTool fails', async () => {
    mockedListNamespaces.mockResolvedValue({
      success: false,
      namespaces: [],
      error: 'Failed to read config',
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, 'GET', '/api/namespaces');

    expect(status).toBe(500);
    expect(body.error).toContain('Failed to read config');
  });

  it('should return 500 with default error message when no error provided', async () => {
    mockedListNamespaces.mockResolvedValue({
      success: false,
      namespaces: [],
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, 'GET', '/api/namespaces');

    expect(status).toBe(500);
    expect(body.error).toContain('Failed to list namespaces');
  });

  it('should handle empty namespace list', async () => {
    mockedListNamespaces.mockResolvedValue({
      success: true,
      namespaces: [],
      currentNamespace: 'default',
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, 'GET', '/api/namespaces');

    expect(status).toBe(200);
    expect(body.namespaces).toEqual([]);
    expect(body.currentNamespace).toBe('default');
  });
});

describe('POST /api/namespaces (create)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 201 with created namespace', async () => {
    mockedCreateNamespace.mockResolvedValue({
      success: true,
      path: '/data/projects',
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, 'POST', '/api/namespaces', {
      name: 'projects',
      setDefault: false,
    });

    expect(status).toBe(201);
    expect(body.name).toBe('projects');
    expect(body.path).toBe('/data/projects');
    expect(body.isDefault).toBe(false);
  });

  it('should return 400 when name is missing', async () => {
    const app = createApp();
    const { status, body } = await httpRequest(app, 'POST', '/api/namespaces', {
      setDefault: true,
    });

    expect(status).toBe(400);
    expect(body.error).toContain('Name is required');
  });

  it('should return 400 when name is empty string', async () => {
    const app = createApp();
    const { status, body } = await httpRequest(app, 'POST', '/api/namespaces', {
      name: '',
    });

    expect(status).toBe(400);
    expect(body.error).toContain('Name is required');
  });

  it('should return 400 when name has invalid characters', async () => {
    const app = createApp();
    const { status, body } = await httpRequest(app, 'POST', '/api/namespaces', {
      name: 'My Namespace!',
    });

    expect(status).toBe(400);
    expect(body.error).toContain('lowercase alphanumeric');
  });

  it('should accept names with hyphens and underscores', async () => {
    mockedCreateNamespace.mockResolvedValue({
      success: true,
      path: '/data/my-ns_01',
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, 'POST', '/api/namespaces', {
      name: 'my-ns_01',
    });

    expect(status).toBe(201);
    expect(body.name).toBe('my-ns_01');
  });

  it('should return 409 when namespace already exists', async () => {
    mockedCreateNamespace.mockResolvedValue({
      success: false,
      error: 'Namespace "existing" already exists',
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, 'POST', '/api/namespaces', {
      name: 'existing',
    });

    expect(status).toBe(409);
    expect(body.error).toContain('already exists');
  });

  it('should return 500 for other creation errors', async () => {
    mockedCreateNamespace.mockResolvedValue({
      success: false,
      error: 'Permission denied',
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, 'POST', '/api/namespaces', {
      name: 'valid-name',
    });

    expect(status).toBe(500);
    expect(body.error).toEqual('Permission denied');
  });
});

describe('POST /api/namespaces/switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 200 with previous and current namespace', async () => {
    mockedSwitchNamespace.mockResolvedValue({
      success: true,
      previous: 'default',
      current: 'work',
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, 'POST', '/api/namespaces/switch', {
      name: 'work',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.previous).toBe('default');
    expect(body.current).toBe('work');
  });

  it('should return 400 when name is missing', async () => {
    const app = createApp();
    const { status, body } = await httpRequest(app, 'POST', '/api/namespaces/switch', {});

    expect(status).toBe(400);
    expect(body.error).toContain('Name is required');
  });

  it('should return 404 when namespace not found', async () => {
    mockedSwitchNamespace.mockResolvedValue({
      success: false,
      error: 'Namespace "ghost" not found',
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, 'POST', '/api/namespaces/switch', {
      name: 'ghost',
    });

    expect(status).toBe(404);
    expect(body.error).toContain('not found');
  });

  it('should return 500 for other switch errors', async () => {
    mockedSwitchNamespace.mockResolvedValue({
      success: false,
      error: 'Cannot switch: namespace is locked',
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, 'POST', '/api/namespaces/switch', {
      name: 'locked-ns',
    });

    expect(status).toBe(500);
    expect(body.error).toEqual('Cannot switch: namespace is locked');
  });
});
