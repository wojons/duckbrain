import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess } from 'child_process';
import {
  getRandomPort, startDuckbrainHttp, killProcess,
  waitForUrl, curl,
} from './helpers';

const port = getRandomPort();
let server: ChildProcess;

describe('Rate Limiting Integration', () => {
  beforeAll(async () => {
    server = await startDuckbrainHttp({ port, rateLimit: 5 });
    await waitForUrl(`http://127.0.0.1:${port}/health`, 15000);
  }, 30000);

  afterAll(() => {
    killProcess(server);
  });

  it('should allow requests under the limit', async () => {
    const res = await curl(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
  });

  it('should return 429 after exceeding rate limit', async () => {
    let got429 = false;
    for (let i = 0; i < 15; i++) {
      const res = await curl(`http://127.0.0.1:${port}/health`);
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });

  it('should include X-RateLimit-Limit header on successful requests', async () => {
    const rateLimitPort = getRandomPort();
    const rlServer = await startDuckbrainHttp({ port: rateLimitPort, rateLimit: 100 });
    try {
      await waitForUrl(`http://127.0.0.1:${rateLimitPort}/health`, 15000);
      const res = await curl(`http://127.0.0.1:${rateLimitPort}/health`);
      expect(res.status).toBe(200);
      expect(res.headers).toMatch(/X-RateLimit-Limit/i);
    } finally {
      killProcess(rlServer);
    }
  });
});
