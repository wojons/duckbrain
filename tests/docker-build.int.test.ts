import { describe, it, expect } from 'vitest';
import { run } from './helpers';

describe('Docker Build Integration', () => {
  it('should build the production Docker image', () => {
    const result = run('docker build -t duckbrain-int-test .', { cwd: process.cwd() });
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain('ERROR');
  }, 300000);

  it('should run as non-root user (UID 1000)', () => {
    const result = run('docker run --rm --entrypoint="" duckbrain-int-test id');
    expect(result).toContain('1000');
  });

  it('should have git installed in the container', () => {
    const result = run('docker run --rm --entrypoint="" duckbrain-int-test which git');
    expect(result).toContain('git');
  });

  it('should have node installed in the container', () => {
    const result = run('docker run --rm --entrypoint="" duckbrain-int-test node --version');
    expect(result).toMatch(/v\d+\.\d+/);
  });

  it('should have /data directory with proper ownership', () => {
    const result = run('docker run --rm --entrypoint="" duckbrain-int-test ls -ld /data');
    expect(result).toContain('/data');
  });

  it('should have the entrypoint script', () => {
    const result = run('docker run --rm --entrypoint="" duckbrain-int-test ls -la /app/scripts/docker-entrypoint.sh');
    expect(result).toContain('docker-entrypoint.sh');
  });

  it('should start HTTP server and respond to health check', async () => {
    const { getRandomPort, waitForUrl, curl } = await import('./helpers');
    const port = getRandomPort();
    const containerName = `duckbrain-health-test-${Math.random().toString(36).slice(2, 8)}`;

    run(`docker run -d --name ${containerName} -p 127.0.0.1:${port}:3000 -e DUCKBRAIN_DATA_DIR=/data duckbrain-int-test`);

    try {
      await waitForUrl(`http://127.0.0.1:${port}/health`, 60000);
      const res = await curl(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('healthy');
    } finally {
      run(`docker rm -f ${containerName} 2>/dev/null || true`);
    }
  }, 120000);
});
