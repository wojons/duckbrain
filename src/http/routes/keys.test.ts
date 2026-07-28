/**
 * Unit tests for Keys API routes (keys.ts)
 *
 * Tests the buildKeyTree function and route handlers
 * with mocked listKeysTool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';

// Mock listKeysTool before importing the route
vi.mock('../../mcp/tools/list_keys', () => ({
  listKeysTool: vi.fn(),
}));

import { listKeysTool } from '../../mcp/tools/list_keys';
import { createKeyRoutes } from './keys';

const mockedListKeysTool = vi.mocked(listKeysTool);

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/keys', createKeyRoutes);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || 'Internal server error',
      code: err.code,
    });
  });
  return app;
}

function request(
  app: express.Express,
  method: string,
  path: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr !== 'string' ? addr.port : 0;
      const http = require('http');
      const req = http.request(
        { hostname: '127.0.0.1', port, path, method, headers: { Host: 'localhost' } },
        (res: any) => {
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
        },
      );
      req.on('error', (err: Error) => {
        server.close();
        reject(err);
      });
      req.end();
    });
  });
}

describe('buildKeyTree (indirect via GET /api/keys)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 200 with empty tree for no keys', async () => {
    mockedListKeysTool.mockResolvedValue({
      keys: [],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
    });

    const app = createApp();
    const { status, body } = await request(app, 'GET', '/api/keys');

    expect(status).toBe(200);
    expect(body.tree).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('should build single-level tree from flat keys', async () => {
    mockedListKeysTool.mockResolvedValue({
      keys: ['/projects', '/notes', '/config'],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
    });

    const app = createApp();
    const { status, body } = await request(app, 'GET', '/api/keys');

    expect(status).toBe(200);
    expect(body.tree).toHaveLength(3);
    expect(body.total).toBe(3);
  });

  it('should build nested tree from hierarchical keys', async () => {
    mockedListKeysTool.mockResolvedValue({
      keys: ['/projects/mcp', '/projects/ui', '/notes/personal'],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
    });

    const app = createApp();
    const { status, body } = await request(app, 'GET', '/api/keys');

    expect(status).toBe(200);
    expect(body.tree).toHaveLength(2); // projects and notes
    const projects = body.tree.find((n: any) => n.name === 'projects');
    expect(projects).toBeDefined();
    expect(projects.type).toBe('folder');
    expect(projects.children).toHaveLength(2);
    expect(body.total).toBe(3);
  });

  it('should set type=memory for leaf nodes', async () => {
    mockedListKeysTool.mockResolvedValue({
      keys: ['/single'],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
    });

    const app = createApp();
    const { status, body } = await request(app, 'GET', '/api/keys');

    expect(status).toBe(200);
    expect(body.tree[0].type).toBe('memory');
  });

  it('should track memoryCount on nodes', async () => {
    mockedListKeysTool.mockResolvedValue({
      keys: ['/a/b', '/a/c', '/a/d'],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
    });

    const app = createApp();
    const { status, body } = await request(app, 'GET', '/api/keys');

    expect(status).toBe(200);
    const a = body.tree[0];
    // a is a folder with 3 children, memoryCount counts all 3 leafs
    expect(a.memoryCount).toBeGreaterThan(0);
  });
});

describe('GET /api/keys query params', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use default params when none provided', async () => {
    mockedListKeysTool.mockResolvedValue({
      keys: [],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
    });

    const app = createApp();
    await request(app, 'GET', '/api/keys');

    expect(mockedListKeysTool).toHaveBeenCalledWith(
      expect.objectContaining({
        prefix: '/',
        maxDepth: 10,
        limit: 100,
        offset: 0,
      }),
    );
  });

  it('should pass prefix, depth, and limit from query', async () => {
    mockedListKeysTool.mockResolvedValue({
      keys: [],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
    });

    const app = createApp();
    await request(app, 'GET', '/api/keys?prefix=/projects/&depth=3&limit=25&namespace=testns');

    expect(mockedListKeysTool).toHaveBeenCalledWith(
      expect.objectContaining({
        prefix: '/projects/',
        maxDepth: 3,
        limit: 25,
        namespace: 'testns',
      }),
    );
  });

  it('should return 500 on listKeysTool error', async () => {
    mockedListKeysTool.mockResolvedValue({
      keys: [],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
      error: 'Database connection failed',
    });

    const app = createApp();
    const { status, body } = await request(app, 'GET', '/api/keys');

    expect(status).toBe(500);
    expect(body.error).toContain('Database connection failed');
  });
});

describe('GET /api/keys/flat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 200 with flat key list', async () => {
    mockedListKeysTool.mockResolvedValue({
      keys: ['/a', '/b', '/c', '/d'],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
    });

    const app = createApp();
    const { status, body } = await request(app, 'GET', '/api/keys/flat?limit=3');

    expect(status).toBe(200);
    expect(body.keys).toEqual(['/a', '/b', '/c']);
    expect(body.total).toBe(3);
    expect(body.hasMore).toBe(false);
  });

  it('should detect hasMore and return nextOffset', async () => {
    mockedListKeysTool.mockResolvedValue({
      keys: ['/a', '/b', '/c', '/d'],
      hasMore: true,
      nextOffset: null,
      prefixes: {},
    });

    const app = createApp();
    const { status, body } = await request(app, 'GET', '/api/keys/flat?limit=3');

    expect(status).toBe(200);
    expect(body.keys).toHaveLength(3);
    expect(body.hasMore).toBe(true);
    expect(body.nextOffset).toBe(3);
  });

  it('should handle offset pagination', async () => {
    mockedListKeysTool.mockResolvedValue({
      keys: ['/x', '/y'],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
    });

    const app = createApp();
    await request(app, 'GET', '/api/keys/flat?offset=10&limit=5');

    expect(mockedListKeysTool).toHaveBeenCalledWith(
      expect.objectContaining({
        offset: 10,
        limit: 6, // limit + 1
      }),
    );
  });

  it('should return nextOffset=null when !hasMore', async () => {
    mockedListKeysTool.mockResolvedValue({
      keys: ['/only'],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
    });

    const app = createApp();
    const { status, body } = await request(app, 'GET', '/api/keys/flat');

    expect(status).toBe(200);
    expect(body.nextOffset).toBeNull();
  });

  it('should return 500 on error', async () => {
    mockedListKeysTool.mockResolvedValue({
      keys: [],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
      error: 'Something went wrong',
    });

    const app = createApp();
    const { status, body } = await request(app, 'GET', '/api/keys/flat');

    expect(status).toBe(500);
    expect(body.error).toBeDefined();
  });
});
