import { execSync, spawn, ChildProcess } from "child_process";

const CONTAINER_PREFIX = "duckbrain-test";

export function uniqueId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function run(cmd: string, opts?: { cwd?: string }): string {
  try {
    const merged = { encoding: "utf-8", ...opts } as any;
    const result = execSync(cmd + " 2>&1", merged);
    return result.trim();
  } catch (e: any) {
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
    if (output) return output.trim();
    throw e;
  }
}

/**
 * How long a daemon spawn may take before waitForUrl gives up.
 *
 * INT-CI-002 raised this 15s -> 30s; the 3rd occurrence (INT-CI-003, run
 * 32071985468) showed the daemon's "HTTP server started" line landing AT the
 * 30s instant on the Node 22 runner under load — a slow cold start (tsx
 * transpile + node-duckdb native load + tool registration), not a hang. 60s
 * matches the docker-build integration file's existing daemon timeout and
 * gives 2x headroom over the slowest observed start. The daemon-ready wait is
 * only as slow as the cold start; pre-warming (see
 * global-setup.integration.ts) keeps the common case fast.
 */
export const DAEMON_READY_TIMEOUT_MS = 60_000;

/** Rolling capture of the last `maxLines` lines of a stderr stream. */
export interface StderrTail {
  push(chunk: string | Buffer): void;
  value(): string;
}

/**
 * Create a rolling line buffer for capturing a child's stderr tail.
 * Chunks may split lines arbitrarily; CRLF and LF endings are normalized.
 * Used by startDuckbrainHttp so waitForUrl timeouts can surface the
 * daemon's last words instead of a bare "Timed out" (INT-CI-002).
 */
export function createStderrTail(maxLines = 50): StderrTail {
  const lines: string[] = [];
  let partial = "";
  return {
    push(chunk) {
      partial += chunk.toString();
      const parts = partial.split(/\r?\n/);
      partial = parts.pop() ?? "";
      for (const line of parts) {
        lines.push(line);
        if (lines.length > maxLines) lines.shift();
      }
    },
    value() {
      if (!partial) return lines.join("\n");
      return lines.length ? `${lines.join("\n")}\n${partial}` : partial;
    },
  };
}

/** A duckbrain daemon child that carries a rolling stderr tail. */
export type DuckbrainChild = ChildProcess & { stderrTail: string };

/** Last captured stderr tail of a child ("" when not captured). */
export function getStderrTail(child: ChildProcess): string {
  return (child as DuckbrainChild).stderrTail ?? "";
}

/**
 * One-line snapshot of a child's process state for timeout diagnostics
 * (INT-CI-003): "alive vs exited" plus stat/etime is the difference between
 * "daemon never came up" and "daemon came up and then died/stopped serving".
 */
export function getChildState(child?: ChildProcess): string {
  if (!child?.pid) return "";
  try {
    const ps = run(`ps -o stat=,etime= -p ${child.pid} 2>/dev/null | tail -1`);
    if (!ps || /not found|no such process/i.test(ps)) {
      return `pid ${child.pid}: (exited)`;
    }
    return `pid ${child.pid}: ${ps.trim()}`;
  } catch {
    return `pid ${child.pid}: (exited)`;
  }
}

export async function waitForUrl(
  url: string,
  timeoutMs = DAEMON_READY_TIMEOUT_MS,
  child?: ChildProcess,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // --max-time 10 bounds each attempt: a health handler that accepts TCP
      // but stalls (e.g. a slow embedding probe) must not pin the poll loop
      // past its timeout cap (INT-CI-003).
      const result = run(
        `curl -sf -o /dev/null -w '%{http_code}' --max-time 10 ${url}`,
      );
      // GAP-030: scratch daemons are deliberately started degraded (openai +
      // empty key) and /health now answers 503 there — accept it as ready.
      if (result === "200" || result === "401" || result === "503") return;
    } catch {}
    await sleep(200);
  }
  const stderrTail = child ? getStderrTail(child) : "";
  const childState = getChildState(child);
  throw new Error(
    `Timed out waiting for ${url} after ${timeoutMs}ms` +
      (childState ? `\n--- child state ---\n${childState}` : "") +
      (stderrTail ? `\n--- child stderr tail ---\n${stderrTail}` : ""),
  );
}

export async function waitForPort(
  port: number,
  timeoutMs = 20000,
): Promise<void> {
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
  return new Promise((r) => setTimeout(r, ms));
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
}): Promise<DuckbrainChild> {
  const args = [
    "node",
    "--import",
    "tsx",
    "bin/duckbrain.ts",
    "http",
    `--port=${opts.port}`,
  ];
  if (opts.authType) args.push(`--auth=${opts.authType}`);
  if (opts.rateLimit) args.push(`--rate-limit=${opts.rateLimit}`);
  if (opts.bindAll) args.push("--bind-all");

  // Spawn via `node --import tsx` (tsx's documented loader integration)
  // rather than `npx tsx`: npx adds per-spawn resolution overhead and an
  // extra process hop, which under CI runner load compounds the cold-start
  // delay (INT-CI-003). The daemon itself is unchanged.
  const tail = createStderrTail(50);
  const child = spawn(args[0], args.slice(1), {
    cwd: opts.cwd || process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // INT-CI-003: scratch daemons must be hermetic — pin the embedding
      // health probe to a fast-fail provider (openai + empty key => isHealthy
      // is Boolean(apiKey) = false, no network). On hosts with live LM
      // Studio/Ollama the first /health request otherwise pays the full
      // sequential probe chain (1.5s + 3s + 1.5s timeouts per provider) and,
      // under load when timers fire late, that single request can outlast
      // the daemon-ready budget — misread as a spawn timeout (INT-CI-003 run
      // 11: daemon printed "HTTP server started" + "ready", yet /health never
      // answered within 60s). Tests already accept the "degraded" status.
      DUCKBRAIN_EMBEDDING_PROVIDER: "openai",
      DUCKBRAIN_EMBEDDING_API_KEY: "",
    },
    // Own process group so killProcess can SIGTERM the whole tree —
    // without this, killing the npx wrapper orphans the node daemon
    // grandchild (recurring stray-daemon leak, ticks #219/#220/#222).
    detached: true,
  }) as DuckbrainChild;

  // Keep the last ~50 lines of stderr so a waitForUrl timeout can report
  // WHY the daemon never came up (tsx compile error, EADDRINUSE from a
  // stray daemon, duckdb native load failure — INT-CI-002 diagnostics).
  child.stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    tail.push(chunk);
    child.stderrTail = tail.value();
  });

  return child;
}

export function killProcess(child: ChildProcess): void {
  try {
    // Negative pid targets the process group (requires detached: true
    // at spawn) — kills npx wrapper + tsx + the node daemon itself.
    if (child.pid !== undefined) {
      process.kill(-child.pid, "SIGTERM");
      return;
    }
    child.kill("SIGTERM");
  } catch {
    // Fallback: direct kill if group kill failed (already dead, etc.)
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}

export async function startSshContainer(
  id: string,
  sshPort: number,
): Promise<string> {
  const containerName = `${CONTAINER_PREFIX}-ssh-${id}`;

  run(
    `docker build -f tests/ssh/Dockerfile.ssh-test -t ${CONTAINER_PREFIX}-ssh .`,
    { cwd: process.cwd() },
  );

  run(`docker rm -f ${containerName} 2>/dev/null || true`);

  run(
    `docker run -d --name ${containerName} -p ${sshPort}:22 ${CONTAINER_PREFIX}-ssh`,
  );

  await sleep(1000);

  run(`ssh-keygen -R [127.0.0.1]:${sshPort} 2>/dev/null || true`);
  run(
    `ssh-keyscan -p ${sshPort} 127.0.0.1 >> ~/.ssh/known_hosts 2>/dev/null || true`,
  );

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

export async function curl(
  args: string,
): Promise<{ status: number; body: string; headers: string }> {
  try {
    const output = run(`curl -s -D - ${args}`);
    const headerEnd = output.indexOf("\r\n\r\n");
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
      const headerEnd = output.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        const headers = output.slice(0, headerEnd);
        const body = output.slice(headerEnd + 4);
        const statusMatch = headers.match(/HTTP\/\S+\s+(\d+)/);
        return {
          status: statusMatch ? parseInt(statusMatch[1]) : 0,
          body,
          headers,
        };
      }
    }
    throw e;
  }
}
