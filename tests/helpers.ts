import { execSync, spawn, ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  assertDaemonIsOurs,
  createSentinelNamespace,
} from "../src/testing/race-safe-daemon";

const CONTAINER_PREFIX = "duckbrain-test";

/**
 * DB-GAP-059: track spawned daemons so a process-level reaper can kill them
 * on exit. Without this, a hard-killed test run (SIGKILL, OOM, CI timeout)
 * leaves detached daemons reparented to systemd --user, burning CPU/RSS/FDs
 * forever (the exact failure mode this task addresses).
 */
const spawnedDaemons = new Set<ChildProcess>();

/**
 * DB-GAP-059: process-level reaper. On exit/beforeExit, kill any tracked
 * daemons that are still alive. This catches the case where afterAll
 * teardown never runs (hard-kill, uncaught exception, CI timeout).
 */
process.on("beforeExit", () => {
  for (const child of spawnedDaemons) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  }
});

process.on("exit", () => {
  for (const child of spawnedDaemons) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }
});

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
export type DuckbrainChild = ChildProcess & {
  stderrTail: string;
  /**
   * INT-CI-018: the port the daemon actually listens on (differs from the
   * caller's pick when the spawn helper remapped a busy port).
   */
  port?: number;
  /**
   * Effective DUCKBRAIN_DATA_DIR the daemon runs with (QA-DUCKBRAIN-002):
   * a helper-created temp dir unless the caller supplied one via opts.env
   * or the ambient process env.
   */
  dataDir?: string;
  /** Effective DUCKBRAIN_NAMESPACES_PATH the daemon runs with. */
  namespacesPath?: string;
  /**
   * INT-CI-018 (judge rework): identity witness for this spawn — the sentinel
   * namespace created under the daemon's namespace root and where it lives.
   * Callers should pass this to cleanupSentinel during teardown.
   */
  sentinel?: { nsPath: string; sentinel: string };
};

/**
 * Helper-created temp roots, so cleanupDaemonDirs removes ONLY dirs this
 * module made — never a caller-supplied or ambient data dir.
 */
const helperTempRoots = new WeakMap<DuckbrainChild, string>();

/**
 * Remove the temp data dir a startDuckbrainHttp call created for this
 * child (if any). Tolerant of an already-cleaned dir and of children whose
 * dirs were caller-supplied (a no-op for those).
 */
export function cleanupDaemonDirs(child: ChildProcess): void {
  const root = helperTempRoots.get(child as DuckbrainChild);
  if (!root) return;
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Best-effort teardown — an already-removed dir is not a failure.
  }
  helperTempRoots.delete(child as DuckbrainChild);
}

/**
 * INT-CI-018 (judge rework): best-effort removal of a daemon's sentinel
 * namespace dir after a SUCCESSFUL spawn (teardown). The daemon may still
 * be flushing git state inside the tree, so retry briefly, then leave the
 * orphan (harmless — same policy as removeTempDirSafely).
 */
export async function cleanupSentinel(w: {
  nsPath: string;
  sentinel: string;
}): Promise<void> {
  const target = path.join(w.nsPath, w.sentinel);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      await sleep(100 * (attempt + 1));
    }
  }
}

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
  // INT-CI-018: if the spawn helper remapped a busy port, translate any
  // URL still using the caller's original pick to the effective port.
  const portMatch = /:(\d+)\//.exec(url);
  if (portMatch) {
    const remap = portRemaps.get(Number(portMatch[1]));
    if (remap !== undefined) url = url.replace(`:${portMatch[1]}/`, `:${remap}/`);
  }
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

/**
 * INT-CI-018: test ports MUST stay OUTSIDE the kernel ephemeral range
 * (net.ipv4.ip_local_port_range, 32768+ on Linux). The old 30000-49999
 * range overlapped it, so a sibling vitest worker or CI service could hold
 * the randomly picked port; the spawned daemon then died with EADDRINUSE
 * and /health never answered (60s timeout, CI run 37147924119). Ports are
 * drawn from a private 21000-29999 window (same approach as the
 * DB-GAP-063 / nsauto001 fix) and additionally probe-bound before use —
 * do NOT "simplify" this back to a bare random pick.
 */
export function getRandomPort(): number {
  return 21000 + Math.floor(Math.random() * 9000);
}

/**
 * Transient bind probe: verify the OS will actually hand out this port
 * before spawning a daemon on it. Closes immediately — a small race window
 * remains, which the bounded EADDRINUSE retry in startDuckbrainHttp covers.
 */
async function assertPortFree(port: number): Promise<void> {
  const net = await import("net");
  await new Promise<void>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve()));
  });
}

/** EADDRINUSE-shaped failure (from a child's stderr or a bind probe). */
function isAddrInUse(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /EADDRINUSE|address already in use/i.test(msg);
}

/** INT-CI-018: max spawn attempts on an EADDRINUSE-shaped child death. */
const MAX_SPAWN_ATTEMPTS = 3;

/**
 * INT-CI-018: the most recently spawned child in the retry loop, so an
 * identity-check failure can kill it before retrying on a fresh port.
 */
let lastChild: DuckbrainChild | undefined;

/**
 * INT-CI-018 (judge rework): identity-verification failures are thrown by
 * assertDaemonIsOurs (or its probe chain) — distinguishable from a plain
 * /health timeout by the "foreign listener owns the port" phrasing and the
 * always-present port number. Only these are retried; a genuine timeout is
 * still fatal.
 */
function isIdentityFailure(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return (
    /foreign (listener|process)[^.]*owns the port|not serving this rig|is not ours/i.test(
      msg,
    ) && /port \d+/.test(msg)
  );
}

/**
 * Spawn a daemon and WAIT for it to answer /health before returning —
 * INT-CI-018 fail-fast: if the child exits before /health responds, throw
 * immediately with its stderr tail instead of leaving the caller stuck in
 * a 60s waitForUrl. An EADDRINUSE-shaped death is retried on a fresh port
 * by the public startDuckbrainHttp wrapper (MAX_SPAWN_ATTEMPTS).
 */
async function spawnDuckbrainHttp(opts: {
  port: number;
  authType?: string;
  authFile?: string;
  rateLimit?: number;
  bindAll?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
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
  if (opts.authFile) args.push(`--auth-file=${opts.authFile}`);
  if (opts.rateLimit) args.push(`--rate-limit=${opts.rateLimit}`);
  if (opts.bindAll) args.push("--bind-all");

  // QA-DUCKBRAIN-002: scratch daemons are hermetic BY DEFAULT. Without
  // these pins every spawned daemon shared the fixed /tmp pidfile path
  // (colliding across uids and with stale leftovers) AND the cwd-relative
  // production namespace root. A value the caller supplied — via opts.env
  // OR already present in the ambient process env (several suites pin
  // process.env.DUCKBRAIN_NAMESPACES_PATH around their describe block) —
  // always wins; we only fill the gaps.
  //
  // DUCKBRAIN_CONFIG_PATH is pinned to a (nonexistent) file inside the temp
  // root for the same reason: without it the daemon's cwd-relative config
  // discovery finds the repo's duckbrain.config.json, which on a real host
  // carries the PRODUCTION namespace registry — a scratch daemon then
  // iterates production namespaces (e.g. GET /users opens one DuckDB
  // connection per registry entry). A missing file parses to schema
  // defaults (empty registry), so nothing needs to be written.
  const callerEnv = opts.env ?? {};
  const scratchEnv: Record<string, string> = {};
  let dataDir: string | undefined;
  let namespacesPath: string | undefined;
  let tempRoot: string | undefined;
  const needsDataDir =
    !callerEnv.DUCKBRAIN_DATA_DIR && !process.env.DUCKBRAIN_DATA_DIR;
  const needsNsPath =
    !callerEnv.DUCKBRAIN_NAMESPACES_PATH &&
    !process.env.DUCKBRAIN_NAMESPACES_PATH;
  const needsConfigPath =
    !callerEnv.DUCKBRAIN_CONFIG_PATH && !process.env.DUCKBRAIN_CONFIG_PATH;
  if (needsDataDir || needsNsPath || needsConfigPath) {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-int-"));
    if (needsDataDir) {
      dataDir = tempRoot;
      scratchEnv.DUCKBRAIN_DATA_DIR = dataDir;
    }
    if (needsNsPath) {
      namespacesPath = path.join(tempRoot, "namespaces");
      fs.mkdirSync(path.join(namespacesPath, "default"), { recursive: true });
      scratchEnv.DUCKBRAIN_NAMESPACES_PATH = namespacesPath;
    }
    if (needsConfigPath) {
      scratchEnv.DUCKBRAIN_CONFIG_PATH = path.join(
        tempRoot,
        "duckbrain.config.json",
      );
    }
  }

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
      ...scratchEnv,
      ...opts.env,
    },
    // Own process group so killProcess can SIGTERM the whole tree —
    // without this, killing the npx wrapper orphans the node daemon
    // grandchild (recurring stray-daemon leak, ticks #219/#220/#222).
    detached: true,
  }) as DuckbrainChild;
  lastChild = child;
  
  // DB-GAP-059: track this daemon so the process-level reaper can kill it
  // on exit if teardown never runs (hard-kill, uncaught exception, CI timeout).
  spawnedDaemons.add(child);
  child.once("exit", () => spawnedDaemons.delete(child));

  // Keep the last ~50 lines of stderr so a waitForUrl timeout can report
  // WHY the daemon never came up (tsx compile error, EADDRINUSE from a
  // stray daemon, duckdb native load failure — INT-CI-002 diagnostics).
  child.stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    tail.push(chunk);
    child.stderrTail = tail.value();
  });

  // QA-DUCKBRAIN-002: expose the effective dirs so suites can assert
  // isolation and teardown can remove the helper-created temp root via
  // cleanupDaemonDirs (only dirs THIS helper created are ever removed).
  child.dataDir =
    dataDir ?? callerEnv.DUCKBRAIN_DATA_DIR ?? process.env.DUCKBRAIN_DATA_DIR;
  child.namespacesPath =
    namespacesPath ??
    callerEnv.DUCKBRAIN_NAMESPACES_PATH ??
    process.env.DUCKBRAIN_NAMESPACES_PATH;
  if (tempRoot) helperTempRoots.set(child, tempRoot);

  // INT-CI-018 fail-fast: if the child dies BEFORE /health answers, surface
  // its stderr immediately (no 60s waitForUrl hang) and — for an
  // EADDRINUSE-shaped death — retry the spawn on a fresh port (bounded),
  // recording the original->effective remap so waitForUrl(url-with-orig)
  // still reaches the live daemon.
  const tailWaitMs = 60_000;
  const healthStart = Date.now();
  while (true) {
    let healthy = false;
    try {
      const code = run(
        `curl -sf -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:${opts.port}/health`,
      );
      if (code === "200" || code === "401" || code === "503") healthy = true;
    } catch {}
    if (healthy) break;
    if (child.exitCode !== null || child.signalCode !== null) {
      const stderrTail = getStderrTail(child);
      const err = new Error(
        `[duckbrain] child exited (code=${child.exitCode} signal=${child.signalCode}) before answering /health on port ${opts.port}\n--- child stderr tail ---\n${stderrTail}`,
      );
      if (isAddrInUse(stderrTail)) {
        (err as Error & { addrInUse?: boolean }).addrInUse = true;
      }
      throw err;
    }
    if (Date.now() - healthStart > tailWaitMs) break; // let waitForUrl report
    await sleep(200);
  }

  // INT-CI-018 (judge rework): /health answering is NOT identity — a stray
  // daemon squatting the port would be accepted as "healthy". Verify the
  // responder is OUR child via the DB-GAP-063 sentinel: a namespace dir
  // pre-created under this daemon's own namespace root that only
  // GET /api/namespaces against our daemon can list. A foreign listener
  // (or a child that died and someone else took the port) fails here and
  // the wrapper treats it like EADDRINUSE: kill + retry on a fresh port.
  // The data dir the pidfile fallback reads is the daemon's EFFECTIVE
  // DUCKBRAIN_DATA_DIR (caller-supplied wins over the helper's temp dir).
  const effectiveDataDir =
    child.dataDir ?? path.join(os.tmpdir(), `duckbrain-int-pid-${child.pid}`);
  const nsRoot =
    child.namespacesPath ??
    (needsNsPath
      ? namespacesPath!
      : path.join(effectiveDataDir, "namespaces"));
  fs.mkdirSync(path.join(nsRoot, "default"), { recursive: true });
  const sentinel = createSentinelNamespace(nsRoot);
  child.sentinel = { nsPath: nsRoot, sentinel };
  await assertDaemonIsOurs({
    port: opts.port,
    child,
    nsPath: nsRoot,
    dataDir: effectiveDataDir,
    sentinel,
  });

  return child;
}

/**
 * INT-CI-018: ports remapped by the bounded spawn retry
 * (original pick -> effective port of the live daemon). waitForUrl
 * consults this so callers that captured the original port still reach
 * the daemon after a remap.
 */
const portRemaps = new Map<number, number>();

export async function startDuckbrainHttp(opts: {
  port: number;
  authType?: string;
  authFile?: string;
  rateLimit?: number;
  bindAll?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DuckbrainChild> {
  // Probe-bind the requested port before spawning: catch the common
  // EADDRINUSE case up front and retry on a fresh pick (bounded), instead
  // of burning a daemon spawn on a port we already know is taken.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_SPAWN_ATTEMPTS; attempt++) {
    try {
      await assertPortFree(opts.port);
      const child = await spawnDuckbrainHttp(opts);
      // Expose the effective port; on a retry this differs from the caller's
      // original pick (waitForUrl consults portRemaps for that).
      child.port = opts.port;
      return child;
    } catch (err) {
      lastErr = err;
      // INT-CI-018 (judge rework): an identity-check failure is the same
      // race the EADDRINUSE path covers — kill our child if it is still
      // alive (so it never fights the squatter), then retry on a fresh
      // port from the same bounded budget.
      const identityFailed = isIdentityFailure(err);
      if (identityFailed) {
        const child = lastChild;
        if (child && child.exitCode === null && child.signalCode === null) {
          try {
            await stopProcess(child);
          } catch {}
        }
        if (child?.sentinel) cleanupSentinel(child.sentinel);
      }
      if (identityFailed || (err as Error & { addrInUse?: boolean })?.addrInUse) {
        const fresh = getRandomPort();
        portRemaps.set(opts.port, fresh);
        opts = { ...opts, port: fresh };
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
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

/**
 * Stop a detached test process and wait for its child/descendants to finish.
 * Teardown must join the process before deleting its data directory: a
 * fire-and-forget SIGTERM can leave git/DuckDB writers racing recursive rm.
 */
export async function stopProcess(
  child: ChildProcess,
  timeoutMs = 15_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  let settled = false;
  let resolveClose: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const onClose = () => {
    settled = true;
    resolveClose?.();
  };
  child.once("close", onClose);
  killProcess(child);

  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), timeoutMs),
  );
  const result = await Promise.race([
    closed.then(() => "closed" as const),
    timeout,
  ]);
  if (result === "timeout" && !settled) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {}
    const killTimeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 5_000),
    );
    const killed = await Promise.race([
      closed.then(() => "closed" as const),
      killTimeout,
    ]);
    if (killed === "timeout") {
      child.removeListener("close", onClose);
      throw new Error(
        `stopProcess: child ${child.pid ?? "unknown"} still alive after SIGTERM+SIGKILL`,
      );
    }
  }
  child.removeListener("close", onClose);
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
    // DB-GAP-059: bound test probes with --max-time so a stalled daemon fails
    // the test instead of hanging the suite forever (mirror INT-CI-003
    // waitForUrl pattern). Without this, a daemon that accepts TCP but never
    // answers pins the curl process and its parent vitest worker indefinitely.
    const output = run(`curl -s -D - --max-time 10 ${args}`);
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
