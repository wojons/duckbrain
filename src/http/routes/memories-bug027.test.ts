/**
 * BUG-027 Integration Test: Tombstone filtering — GET /:id returns 404 for deleted memories
 *
 * Tests the full HTTP pipeline: create → delete → GET/404.
 *
 * This test exercises the fix in src/duckdb/queries.ts which uses
 * ROW_NUMBER() OVER (PARTITION BY id ORDER BY timestamp DESC)
 * to deduplicate memories and exclude tombstoned records.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHttpServer } from '../../cli/http';
import { createServer, Server } from 'http';

let server: Server;
let port: number;

interface HttpResponse {
  status: number;
  body: any;
}

function httpRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const options: any = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Host': 'localhost',
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res: any) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe('BUG-027: Tombstone filtering — GET /api/memories/:id after delete', () => {
  let createdId: string;

  beforeAll(async () => {
    const app = createHttpServer();
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') port = addr.port;
        resolve();
      });
    });
  });

  afterAll(() => {
    server.close();
  });

  it('Step 1: POST /api/memories — create a memory', async () => {
    const key = `/test/bug027-${Date.now()}`;
    const { status, body } = await httpRequest('POST', '/api/memories', {
      key,
      domain: 'raw_note',
      content: 'BUG-027 test memory — should be tombstoned and hidden',
      attributes: { test: 'bug027' },
    });

    expect(status).toBe(201);
    expect(body.id).toBeDefined();
    expect(body.key).toBe(key);
    expect(body.action).toBe('add');

    createdId = body.id;
  });

  it('Step 2: GET /api/memories/:id — should return the memory before deletion', async () => {
    expect(createdId).toBeDefined();

    const { status, body } = await httpRequest('GET', `/api/memories/${createdId}`);

    expect(status).toBe(200);
    expect(body.id).toBe(createdId);
    expect(body.action).not.toBe('tombstone');
  });

  it('Step 3: DELETE /api/memories/:id — delete (tombstone) the memory', async () => {
    expect(createdId).toBeDefined();

    const { status } = await httpRequest('DELETE', `/api/memories/${createdId}`);

    expect(status).toBe(204);
  });

  it('Step 4: GET /api/memories/:id — should return 404 after deletion (BUG-027)', async () => {
    expect(createdId).toBeDefined();

    const { status, body } = await httpRequest('GET', `/api/memories/${createdId}`);

    // BUG-027 fix: deleted (tombstoned) memories must return 404
    expect(status).toBe(404);
    expect(body.error).toBeDefined();
  });
});
