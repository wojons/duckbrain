/**
 * Security tests for /cli endpoint
 *
 * Tests command validation, path traversal rejection, null byte rejection,
 * newline injection rejection, arg type validation, and DoS limits.
 *
 * All rejection tests run synchronously against the Express app (fast).
 * Execution tests make real HTTP requests (slower, may skip if timeout).
 */

import { describe, it, expect } from 'vitest';
import { createHttpServer } from './http';
import { createServer } from 'http';

/**
 * Send a POST to /cli on the Express app via a real HTTP server.
 */
async function postCli(body: unknown): Promise<{ status: number; body: any }> {
  const app = createHttpServer();
  const server = createServer(app);

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not get server address'));
        return;
      }
      const port = addr.port;
      const payload = JSON.stringify(body);

      const http = require('http');
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/cli',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            Host: 'localhost',
          },
        },
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
        }
      );

      req.on('error', (err: Error) => {
        server.close();
        // ECONNRESET can happen if execFile outlives the test — treat as timeout
        resolve({ status: 504, body: { error: err.message } });
      });

      req.setTimeout(8000, () => {
        req.destroy();
        server.close();
        resolve({ status: 504, body: { error: 'Request timed out' } });
      });

      req.write(payload);
      req.end();
    });
  });
}

describe('/cli endpoint security', () => {
  // ═══════════════════════════════════════════════════════════════
  // COMMAND VALIDATION (synchronous rejections — fast)
  // ═══════════════════════════════════════════════════════════════
  describe('command validation', () => {
    it('rejects missing command', async () => {
      const { status, body } = await postCli({});
      expect(status).toBe(400);
      expect(body.error).toBe('Missing or invalid command');
    });

    it('rejects non-string command (number)', async () => {
      const { status, body } = await postCli({ command: 123 });
      expect(status).toBe(400);
      expect(body.error).toBe('Missing or invalid command');
    });

    it('rejects null command', async () => {
      const { status, body } = await postCli({ command: null });
      expect(status).toBe(400);
      expect(body.error).toBe('Missing or invalid command');
    });

    it('rejects empty string command', async () => {
      const { status, body } = await postCli({ command: '' });
      expect(status).toBe(400);
      expect(body.error).toBe('Missing or invalid command');
    });

    it('rejects disallowed command: stdio', async () => {
      const { status, body } = await postCli({ command: 'stdio' });
      expect(status).toBe(403);
      expect(body.error).toBe('Command not allowed: stdio');
    });

    it('rejects disallowed command: http', async () => {
      const { status, body } = await postCli({ command: 'http' });
      expect(status).toBe(403);
      expect(body.error).toBe('Command not allowed: http');
    });

    it('rejects disallowed command: service', async () => {
      const { status, body } = await postCli({ command: 'service' });
      expect(status).toBe(403);
      expect(body.error).toBe('Command not allowed: service');
    });

    it('rejects unknown command not in whitelist', async () => {
      const { status, body } = await postCli({ command: 'rm' });
      expect(status).toBe(403);
      expect(body.error).toBe('Command not allowed: rm');
    });

    it('rejects shell injection payload as command', async () => {
      const { status, body } = await postCli({ command: '; rm -rf /' });
      expect(status).toBe(403);
      expect(body.error).toContain('Command not allowed');
    });

    it('rejects command containing sub-shell syntax', async () => {
      const { status, body } = await postCli({ command: 'status$(whoami)' });
      expect(status).toBe(403);
      expect(body.error).toContain('Command not allowed');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // PATH TRAVERSAL IN ARGS
  // ═══════════════════════════════════════════════════════════════
  describe('path traversal rejection', () => {
    it('rejects ../ prefix', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: ['../../etc/passwd'],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('path traversal');
    });

    it('rejects /../ in middle', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: ['/var/log/../../etc/shadow'],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('path traversal');
    });

    it('rejects ".." as lone argument', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: ['..'],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('path traversal');
    });

    it('rejects Windows-style traversal (\\..)', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: ['..\\..\\Windows\\System32\\config\\SAM'],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('path traversal');
    });

    it('rejects traversal inside flag value', async () => {
      const { status, body } = await postCli({
        command: 'recall',
        args: ['--prefix=../../etc'],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('path traversal');
    });

    it('allows legitimate dotted names without traversal', async () => {
      const { status } = await postCli({
        command: 'status',
        args: ['.gitignore', '--file=config.yaml'],
      });
      // Must NOT be 400 — dots alone (without .. traversal) are safe
      expect(status).not.toBe(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // NULL BYTE INJECTION
  // ═══════════════════════════════════════════════════════════════
  describe('null byte rejection', () => {
    it('rejects null byte in arg', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: ['normal\x00injected'],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('null byte');
    });

    it('rejects null byte mid-string', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: ['--name=foo\x00.sh'],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('null byte');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // NEWLINE INJECTION
  // ═══════════════════════════════════════════════════════════════
  describe('newline rejection', () => {
    it('rejects LF in arg', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: ['normal\nmalicious'],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('newline');
    });

    it('rejects CR in arg', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: ['normal\rmalicious'],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('newline');
    });

    it('rejects CRLF in arg', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: ['normal\r\nmalicious'],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('newline');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ARG TYPE VALIDATION
  // ═══════════════════════════════════════════════════════════════
  describe('arg type validation', () => {
    it('rejects non-array args', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: 'not-an-array',
      });
      expect(status).toBe(400);
      expect(body.error).toContain('must be an array of strings');
    });

    it('rejects args containing a number', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: ['--limit', 42],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('must be an array of strings');
    });

    it('rejects args containing an object', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: [{ inject: true }],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('must be an array of strings');
    });

    it('rejects args containing null', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: [null],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('must be an array of strings');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // DoS PREVENTION
  // ═══════════════════════════════════════════════════════════════
  describe('DoS prevention', () => {
    it('rejects >100 args', async () => {
      const args = Array.from({ length: 101 }, (_, i) => `arg${i}`);
      const { status, body } = await postCli({ command: 'status', args });
      expect(status).toBe(400);
      expect(body.error).toContain('exceeds maximum');
    });

    it('rejects arg >4096 chars', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: ['A'.repeat(4097)],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('exceeds maximum length');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SHELL METACHARACTER SAFETY (execFile avoids shell, but combined
  // attacks with path traversal must still be caught)
  // ═══════════════════════════════════════════════════════════════
  describe('combined injection payloads', () => {
    it('rejects shell metachar + path traversal (;)', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: ['foo;../../etc/passwd'],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('path traversal');
    });

    it('rejects shell metachar + path traversal (|)', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: ['foo|../../etc/passwd'],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('path traversal');
    });

    it('rejects shell metachar + path traversal ($)', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: ['foo$(../../etc/passwd)'],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('path traversal');
    });

    it('rejects backtick + path traversal', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: ['foo`../../etc/passwd`'],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('path traversal');
    });

    it('rejects newline + path traversal', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: ['foo\n../../etc/passwd'],
      });
      expect(status).toBe(400);
      // Newline check fires before path traversal check — either error is fine
      expect([400]).toContain(status);
    });

    it('rejects semicolon in args that would enable secondary command', async () => {
      // ; rm -rf / — path traversal check catches the ..
      const { status } = await postCli({
        command: 'status',
        args: ['--name=test;../../tmp/malicious'],
      });
      expect(status).toBe(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // HAPPY PATH — Valid requests that reach execFile
  // (may timeout if npx/tsx is slow, but validation must pass)
  // ═══════════════════════════════════════════════════════════════
  describe('valid requests pass validation', () => {
    it('accepts whitelisted command with no args (reaches execFile)', async () => {
      const { status, body } = await postCli({ command: 'status' });
      // 400/403 = validation rejected → FAIL
      // 200/504 = passed validation, execFile response/timeout → PASS
      expect([200, 504]).toContain(status);
      if (status === 200) {
        // If we got a real response, it should have exitCode
        expect(body).toHaveProperty('exitCode');
      }
    }, 15000);

    it('accepts whitelisted command with safe string args', async () => {
      const { status, body } = await postCli({
        command: 'recall',
        args: ['--namespace=default', '--limit=10'],
      });
      expect([200, 504]).toContain(status);
      if (status === 200) {
        expect(body).toHaveProperty('exitCode');
      }
    }, 15000);

    it('accepts args as empty array', async () => {
      const { status, body } = await postCli({
        command: 'status',
        args: [],
      });
      expect([200, 504]).toContain(status);
      if (status === 200) {
        expect(body).toHaveProperty('exitCode');
      }
    }, 15000);

    it('accepts shell metacharacters in args (safe with execFile)', async () => {
      // execFile does not invoke a shell, so $(), |, ;, &&, `` in args
      // are passed literally to the child process — safe.
      const { status } = await postCli({
        command: 'status',
        args: [
          '--name=test;echo',
          '--value=$(whoami)',
          '--path=|cat',
          '--cmd=`id`',
          '--flag=foo&&bar',
        ],
      });
      expect([200, 504]).toContain(status);
    }, 15000);

    it('accepts args at the length boundary (4096 chars)', async () => {
      const { status } = await postCli({
        command: 'status',
        args: ['A'.repeat(4096)],
      });
      expect([200, 504]).toContain(status);
    }, 15000);

    it('accepts 100 args (at the count boundary)', async () => {
      const args = Array.from({ length: 100 }, (_, i) => `arg${i}`);
      const { status } = await postCli({ command: 'status', args });
      expect([200, 504]).toContain(status);
    }, 15000);
  });
});
