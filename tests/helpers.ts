import { execSync, spawn, ChildProcess } from 'child_process';

const CONTAINER_PREFIX = 'duckbrain-test';

export function uniqueId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function run(cmd: string, opts?: { cwd?: string }): string {
  try {
    const merged = { encoding: 'utf-8', ...opts } as any;
    const result = execSync(cmd + ' 2>&1', merged);
    return result.trim();
  } catch (e: any) {
    const output = [e.stdout, e.stderr].filter(Boolean).join('\n');
    if (output) return output.trim();
    throw e;
  }
}

export async function waitForUrl(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = run(`curl -sf -o /dev/null -w '%{http_code}' ${url}`);
      if (result === '200' || result === '401') return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export async function waitForPort(port: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      run(`nc -z 127.0.0.1 ${port}`);
      return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function getRandomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

export async function startDuckbrainHttp(opts: {
  port: number;
  authType?: string;
  rateLimit?: number;
  bindAll?: boolean;
  cwd?: string;
}): Promise<ChildProcess> {
  const args = [
    'npx', 'tsx', 'bin/duckbrain.ts', 'http',
    `--port=${opts.port}`,
  ];
  if (opts.authType) args.push(`--auth=${opts.authType}`);
  if (opts.rateLimit) args.push(`--rate-limit=${opts.rateLimit}`);
  if (opts.bindAll) args.push('--bind-all');

  const child = spawn(args[0], args.slice(1), {
    cwd: opts.cwd || process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
    detached: false,
  });

  child.stderr?.on('data', () => {});

  return child;
}

export function killProcess(child: ChildProcess): void {
  try {
    child.kill('SIGTERM');
  } catch {}
}

export async function startSshContainer(id: string, sshPort: number): Promise<string> {
  const containerName = `${CONTAINER_PREFIX}-ssh-${id}`;

  run(`docker build -f tests/ssh/Dockerfile.ssh-test -t ${CONTAINER_PREFIX}-ssh .`, { cwd: process.cwd() });

  run(`docker rm -f ${containerName} 2>/dev/null || true`);

  run(`docker run -d --name ${containerName} -p ${sshPort}:22 ${CONTAINER_PREFIX}-ssh`);

  await sleep(1000);

  run(`ssh-keygen -R [127.0.0.1]:${sshPort} 2>/dev/null || true`);
  run(`ssh-keyscan -p ${sshPort} 127.0.0.1 >> ~/.ssh/known_hosts 2>/dev/null || true`);

  return containerName;
}

export function stopSshContainer(containerName: string): void {
  try {
    run(`docker rm -f ${containerName} 2>/dev/null || true`);
  } catch {}
}

export function sshExec(containerName: string, cmd: string): string {
  return run(`docker exec ${containerName} sh -c ${JSON.stringify(cmd)}`);
}

export async function curl(args: string): Promise<{ status: number; body: string; headers: string }> {
  try {
    const output = run(`curl -s -D - ${args}`);
    const headerEnd = output.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      return { status: 0, body: output, headers: output };
    }
    const headers = output.slice(0, headerEnd);
    const body = output.slice(headerEnd + 4);
    const statusMatch = headers.match(/HTTP\/\S+\s+(\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1]) : 0;
    return { status, body, headers };
  } catch (e: any) {
    if (e.stdout) {
      const output = e.stdout as string;
      const headerEnd = output.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const headers = output.slice(0, headerEnd);
        const body = output.slice(headerEnd + 4);
        const statusMatch = headers.match(/HTTP\/\S+\s+(\d+)/);
        return { status: statusMatch ? parseInt(statusMatch[1]) : 0, body, headers };
      }
    }
    throw e;
  }
}
