import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess } from 'child_process';
import {
  uniqueId, getRandomPort, startDuckbrainHttp, killProcess,
  waitForUrl, curl, run,
} from './helpers';
import fs from 'fs';
import path from 'path';
import os from 'os';
import bcrypt from 'bcryptjs';

const id = uniqueId();
const port = getRandomPort();
let server: ChildProcess;
const authDir = path.join(os.homedir(), '.duckbrain');
const authFile = path.join(authDir, 'auth.json');
let savedAuth: string | null = null;

describe('HTTP Auth Integration', () => {
  beforeAll(async () => {
    if (fs.existsSync(authFile)) {
      savedAuth = fs.readFileSync(authFile, 'utf-8');
    }
    const hash = await bcrypt.hash('testpass123', 4);
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }
    fs.writeFileSync(authFile, JSON.stringify({
      users: [{ username: 'admin', passwordHash: hash }],
      apiKeys: [{ key: 'test-api-key-123', name: 'test-key' }],
    }));

    server = await startDuckbrainHttp({ port, authType: 'basic' });
    await waitForUrl(`http://127.0.0.1:${port}/health`, 15000);
  }, 30000);

  afterAll(() => {
    killProcess(server);
    if (savedAuth !== null) {
      fs.writeFileSync(authFile, savedAuth);
    } else {
      try { fs.unlinkSync(authFile); } catch {}
    }
  });

  it('should allow /health without auth', async () => {
    const res = await curl(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('healthy');
  });

  it('should reject /namespaces without auth', async () => {
    const res = await curl(`http://127.0.0.1:${port}/namespaces`);
    expect(res.status).toBe(401);
  });

  it('should reject /stats with wrong credentials', async () => {
    const res = await curl(`-u wrong:creds http://127.0.0.1:${port}/stats`);
    expect(res.status).toBe(401);
  });

  it('should reject /namespaces with wrong auth header format', async () => {
    const res = await curl(`-H "Authorization: Bearer sometoken" http://127.0.0.1:${port}/namespaces`);
    expect(res.status).toBe(401);
  });

  it('should allow /namespaces with correct basic auth', async () => {
    const res = await curl(`-u admin:testpass123 http://127.0.0.1:${port}/namespaces`);
    expect(res.status).toBe(200);
  });

  it('should allow /stats with correct basic auth', async () => {
    const res = await curl(`-u admin:testpass123 http://127.0.0.1:${port}/stats`);
    expect(res.status).toBe(200);
  });
});
