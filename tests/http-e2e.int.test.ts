import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess } from 'child_process';
import {
  getRandomPort, startDuckbrainHttp, killProcess,
  waitForUrl, curl,
} from './helpers';

const port = getRandomPort();
let server: ChildProcess;

describe('HTTP Server E2E Integration', () => {
  beforeAll(async () => {
    server = await startDuckbrainHttp({ port });
    await waitForUrl(`http://127.0.0.1:${port}/health`, 15000);
  }, 30000);

  afterAll(() => {
    killProcess(server);
  });

  it('should respond to /health with uptime and status', async () => {
    const res = await curl(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('healthy');
    expect(body.uptime).toBeGreaterThan(0);
    expect(body.timestamp).toBeTruthy();
  });

  it('should respond to /stats', async () => {
    const res = await curl(`http://127.0.0.1:${port}/stats`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.nodeVersion).toBeTruthy();
  });

  it('should respond to /namespaces', async () => {
    const res = await curl(`http://127.0.0.1:${port}/namespaces`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.namespaces).toBeDefined();
  });

  it('should respond to /users', async () => {
    const res = await curl(`http://127.0.0.1:${port}/users`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.users).toBeDefined();
  });

  it('should respond to /activity', async () => {
    const res = await curl(`http://127.0.0.1:${port}/activity`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.activities).toBeDefined();
  });

  it('should respond to /api/tree with redirect to /api/keys', async () => {
    const res = await curl(`http://127.0.0.1:${port}/api/tree`);
    expect(res.status).toBe(301);
    expect(res.headers).toContain('/api/keys');
  });

  it('should respond to /api/timeline with redirect to /api/memories', async () => {
    const res = await curl(`http://127.0.0.1:${port}/api/timeline`);
    expect(res.status).toBe(301);
    expect(res.headers).toContain('/api/memories');
  });

  it('should respond to /api/search with redirect to /api/memories', async () => {
    const res = await curl(`http://127.0.0.1:${port}/api/search`);
    expect(res.status).toBe(301);
    expect(res.headers).toContain('/api/memories');
  });

  it('should reject unknown routes with 404', async () => {
    const res = await curl(`http://127.0.0.1:${port}/nonexistent`);
    expect(res.status).toBe(404);
  });

  it('should bind to localhost only by default', async () => {
    const localPort = getRandomPort();
    const localServer = await startDuckbrainHttp({ port: localPort });
    try {
      await waitForUrl(`http://127.0.0.1:${localPort}/health`, 15000);
      const res = await curl(`http://127.0.0.1:${localPort}/health`);
      expect(res.status).toBe(200);
    } finally {
      killProcess(localServer);
    }
  });
});
