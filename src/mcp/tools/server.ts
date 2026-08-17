/**
 * Server control MCP tools
 *
 * Tools for inspecting and triggering the DuckBrain HTTP server so MCP
 * clients can ensure MCP-over-HTTP (and the Unix socket) is reachable:
 *
 * - `server_status` — report whether the HTTP server is listening (TCP port
 *   and/or Unix socket), with PID and endpoint info. The port is resolved
 *   from THIS instance's config (DUCKBRAIN_API_PORT, else the default) and
 *   the pidfile pid is validated for liveness, so the answer describes the
 *   instance that answered rather than whatever happens to sit on :3000.
 * - `server_http_start` — trigger the HTTP server to start as a detached
 *   background process if it is not already running. Accepts the same
 *   options as `duckbrain http` (port, socket, socket-mode, socket-group).
 */

import { z } from "zod";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import {
  httpPidFilePath,
  isPidAlive,
  cleanupStalePidFile,
} from "../../utils/pidfile.js";
import { getConfig } from "../../config/index.js";

/** Default HTTP port — the same default `duckbrain http` / startHttpMode use. */
export const DEFAULT_HTTP_PORT = 3000;

/**
 * Resolve the effective HTTP port for THIS instance.
 *
 * server_status must describe the server this process's config would start,
 * not a hardcoded 3000 (DOGFOOD-015: a scratch-config stdio process reported
 * the live :3000 daemon's pidfile because the default was baked in). The
 * documented env contract (docs/guide/configuration.md, launch.sh) is:
 *
 *   1. `DUCKBRAIN_API_PORT` env var (the `--port` flag equivalent)
 *   2. 3000 (the CLI/config default)
 *
 * An explicit `port` in the tool input overrides this at the call site.
 */
export function resolveHttpPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DUCKBRAIN_API_PORT;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }
  return DEFAULT_HTTP_PORT;
}

/**
 * Resolve the effective port source for the response, so callers can tell
 * whether the port came from an explicit input, the environment, or the
 * default.
 */
function resolvePortSource(
  inputPort: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): "input" | "env" | "default" {
  if (inputPort !== undefined) return "input";
  if (
    env.DUCKBRAIN_API_PORT !== undefined &&
    env.DUCKBRAIN_API_PORT.trim() !== ""
  ) {
    return "env";
  }
  return "default";
}

/**
 * Resolve a short summary of the effective config this instance would use,
 * so callers can tell WHICH DuckBrain instance answered (DOGFOOD-015).
 *
 * Mirrors getConfig()'s own resolution: DUCKBRAIN_CONFIG_PATH redirects the
 * config file, DUCKBRAIN_NAMESPACES_PATH overrides the storage location.
 * Config read failures must not break status reporting — fall back to the
 * schema defaults in that case.
 */
function resolveConfigSummary(): {
  namespacesPath: string;
  configFile: string | null;
} {
  let namespacesPath = "./namespaces";
  let configFile: string | null = null;
  try {
    const config = getConfig();
    namespacesPath = config.namespacesPath;
    configFile = path.resolve(
      process.env.DUCKBRAIN_CONFIG_PATH ??
        path.join(process.cwd(), "duckbrain.config.json"),
    );
  } catch {
    // Keep defaults — status reporting must not depend on config parsing.
  }
  return { namespacesPath, configFile };
}

/**
 * Resolve the PID file location for a given port/socket.
 *
 * Mirrors the naming used by `src/cli/http.ts` via the shared helper in
 * `src/utils/pidfile.ts` so `server_status` reads the correct per-instance
 * pidfile (e.g. `duckbrain-http-<port>.pid`).
 */
function pidFilePath(port: number, socket?: string): string {
  return httpPidFilePath(port, socket);
}

/**
 * Check if a TCP port is listening (127.0.0.1).
 */
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require("net");
    const socket = new net.Socket();
    socket.setTimeout(1500);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

/**
 * Check if a Unix socket file exists (and is a socket).
 */
function socketExists(socketPath: string): boolean {
  try {
    const stat = fs.statSync(socketPath);
    return stat.isSocket();
  } catch {
    return false;
  }
}

const MAX_PROJECT_ROOT_WALK = 8;
const WAIT_FOR_PORT_MS = 5000;
const STDERR_SURFACE_MAX_CHARS = 2000;

/**
 * Resolve the DuckBrain project root — the directory containing the
 * `bin/duckbrain.*` entry point.
 *
 * The root is derived from THIS module's own location (walking up until a
 * `bin/duckbrain.ts` / `bin/duckbrain.js` is found), NOT from
 * `process.cwd()`: the MCP server normally runs from the repo root, where
 * the old `path.resolve(cwd, "..", "..")` resolved to "/" and produced a
 * nonexistent entry path (`/bin/duckbrain.ts`).
 *
 * Precedence:
 *   1. `DUCKBRAIN_HOME_ROOT` env var (explicit override, highest)
 *   2. bounded walk up from the module directory (max 8 levels)
 *   3. `process.cwd()` as a last-resort fallback
 */
export function resolveProjectRoot(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  moduleDir: string = __dirname,
): string {
  const override = env.DUCKBRAIN_HOME_ROOT;
  if (override) return override;

  let dir = moduleDir;
  for (let level = 0; level <= MAX_PROJECT_ROOT_WALK; level++) {
    if (
      fs.existsSync(path.join(dir, "bin", "duckbrain.ts")) ||
      fs.existsSync(path.join(dir, "bin", "duckbrain.js"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return cwd;
}

/**
 * server_status tool
 */
const ServerStatusInputSchema = z.object({
  port: z
    .number()
    .optional()
    .describe("TCP port to check (default: DUCKBRAIN_API_PORT env, else 3000)"),
  socket: z
    .string()
    .optional()
    .describe("Unix socket path to check (e.g. /tmp/duckbrain.sock)"),
});

async function serverStatusTool(input: {
  port?: number;
  socket?: string;
}): Promise<{
  success: boolean;
  port?: number;
  /** Where the reported port came from: explicit input, env, or default. */
  portSource?: "input" | "env" | "default";
  portListening?: boolean;
  socket?: string;
  socketListening?: boolean;
  /** Live pid from the pidfile; null when absent, unparseable, or dead. */
  pid?: number | null;
  /** True when a pidfile exists but yields no LIVE pid (dead/unparseable). */
  pidStale?: boolean;
  /** The dead pid found in a stale pidfile (diagnostic). */
  stalePid?: number | null;
  /** Whether the resolved per-instance pidfile exists on disk. */
  pidFileExists?: boolean;
  pidFile?: string;
  endpoints?: string[];
  /** Resolved config summary so callers can tell which instance answered. */
  config?: {
    namespacesPath: string;
    configFile: string | null;
  };
}> {
  const port = input.port ?? resolveHttpPort();
  const portSource = resolvePortSource(input.port);
  const pidFile = pidFilePath(port, input.socket);
  const pidFileExists = fs.existsSync(pidFile);
  let pid: number | null = null;
  let pidStale = false;
  let stalePid: number | null = null;
  if (pidFileExists) {
    try {
      const parsed = Number.parseInt(
        fs.readFileSync(pidFile, "utf-8").trim(),
        10,
      );
      if (Number.isInteger(parsed) && parsed > 0) {
        if (isPidAlive(parsed)) {
          pid = parsed;
        } else {
          pidStale = true;
          stalePid = parsed;
        }
      } else {
        // Unparseable pidfile content — cannot claim a live process.
        pidStale = true;
      }
    } catch {
      pidStale = true;
    }
  }

  const portListening = await isPortListening(port);
  const endpoints: string[] = [];

  if (portListening) {
    endpoints.push(`http://127.0.0.1:${port}/mcp`);
  }

  let socketListening = false;
  if (input.socket) {
    socketListening = socketExists(input.socket);
    if (socketListening) {
      endpoints.push(`unix:${input.socket} -> POST /mcp`);
    }
  }

  return {
    success: portListening || socketListening,
    port,
    portSource,
    portListening,
    socket: input.socket,
    socketListening,
    pid,
    pidStale,
    stalePid,
    pidFileExists,
    pidFile,
    endpoints,
    config: resolveConfigSummary(),
  };
}

export interface SpawnHttpServerOptions {
  env: NodeJS.ProcessEnv;
  /** Detach the child (default: true — the HTTP server outlives the MCP process). */
  detached?: boolean;
  /** How long to wait for the port to come up (default: 5000ms). */
  waitMs?: number;
}

export interface SpawnHttpServerResult {
  success: boolean;
  pid: number | null;
  message: string;
}

/**
 * Spawn a process and wait up to `waitMs` for the DuckBrain HTTP port to
 * start listening. Child stderr is captured (stdio: ["ignore","ignore","pipe"])
 * and any spawn error (e.g. ENOENT for a missing binary) is recorded — both
 * are surfaced in the failure message instead of the generic "not listening"
 * text. The child 'error' listener also prevents an uncaught 'error' event.
 *
 * Exported for tests: the stderr/spawn-error surfacing can be exercised with
 * a harmless failing command instead of the real duckbrain entry.
 */
export async function spawnHttpServerAndWaitForPort(
  command: string,
  args: string[],
  port: number,
  options: SpawnHttpServerOptions,
): Promise<SpawnHttpServerResult> {
  const child = spawn(command, args, {
    detached: options.detached ?? true,
    stdio: ["ignore", "ignore", "pipe"],
    env: options.env,
  });
  child.unref();

  let stderrText = "";
  let spawnError: string | null = null;

  // MUST attach an 'error' listener: without one, a failed spawn (e.g.
  // ENOENT) emits an uncaught 'error' event that crashes the process.
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", (err: Error) => {
      spawnError = err.message;
      resolve();
    });
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString();
  });

  const waitMs = options.waitMs ?? WAIT_FOR_PORT_MS;
  const deadline = Date.now() + waitMs;
  let nowListening = await isPortListening(port);
  while (!nowListening && Date.now() < deadline) {
    const childGone = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 200);
      }),
    ]);
    if (childGone) break;
    nowListening = await isPortListening(port);
  }
  if (!nowListening) nowListening = await isPortListening(port);

  if (nowListening) {
    return {
      success: true,
      pid: child.pid ?? null,
      message: `HTTP server started on port ${port} (pid ${child.pid})`,
    };
  }

  const detail = [
    spawnError !== null ? `spawn error: ${spawnError}` : null,
    stderrText.trim() !== ""
      ? `stderr: ${stderrText.trim().slice(-STDERR_SURFACE_MAX_CHARS)}`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join("; ");
  return {
    success: false,
    pid: child.pid ?? null,
    message:
      `Spawned HTTP server (pid ${child.pid}) but port ${port} not listening within ${waitMs}ms` +
      (detail !== "" ? ` — ${detail}` : ""),
  };
}

/**
 * server_http_start tool
 *
 * Spawns `duckbrain http` as a detached background process if the server is
 * not already listening on the requested port. Mirrors the CLI options.
 */
const ServerHttpStartInputSchema = z.object({
  port: z.number().optional().describe("TCP port (default: 3000)"),
  bindAll: z
    .boolean()
    .optional()
    .describe("Bind to 0.0.0.0 instead of 127.0.0.1 (default: false)"),
  authType: z
    .enum(["none", "basic", "apikey"])
    .optional()
    .describe("Authentication type (default: none)"),
  rateLimit: z
    .number()
    .optional()
    .describe("Requests per minute per IP (default: 100)"),
  socket: z
    .string()
    .optional()
    .describe("Also listen on a Unix domain socket at this path"),
  socketMode: z
    .string()
    .optional()
    .describe("Socket file permissions as octal string (default: 0660)"),
  socketGroup: z
    .string()
    .optional()
    .describe("Group name or numeric GID to chown the socket to"),
  force: z
    .boolean()
    .optional()
    .describe("Start even if the port is already listening (default: false)"),
});

async function serverHttpStartTool(input: {
  port?: number;
  bindAll?: boolean;
  authType?: "none" | "basic" | "apikey";
  rateLimit?: number;
  socket?: string;
  socketMode?: string;
  socketGroup?: string;
  force?: boolean;
}): Promise<{
  success: boolean;
  alreadyRunning?: boolean;
  pid?: number | null;
  spawned?: boolean;
  message: string;
}> {
  const port = input.port ?? 3000;
  const alreadyRunning = await isPortListening(port);

  if (alreadyRunning && !input.force) {
    return {
      success: true,
      alreadyRunning: true,
      message: `HTTP server already listening on port ${port}`,
    };
  }

  // The port is not listening, so any existing pidfile for it cannot
  // describe a live server — remove it before spawning so a dead pid never
  // shadows the new instance (DOGFOOD-016). A pidfile whose PID is alive
  // is left untouched (cleanupStalePidFile's contract).
  cleanupStalePidFile(pidFilePath(port, input.socket));

  // Resolve the duckbrain entry point from the project root, which is
  // derived from this module's own location — NOT from process.cwd() (the
  // MCP server usually runs from the repo root, where the old
  // `path.resolve(cwd, "..", "..")` yielded "/" and a nonexistent entry).
  const projectRoot = resolveProjectRoot();
  const binJs = path.join(projectRoot, "bin", "duckbrain.js");
  const binTs = path.join(projectRoot, "bin", "duckbrain.ts");

  const args = ["http", `--port=${port}`];
  if (input.bindAll) args.push("--bind-all");
  if (input.authType) args.push(`--auth=${input.authType}`);
  if (input.rateLimit) args.push(`--rate-limit=${input.rateLimit}`);
  if (input.socket) args.push(`--unix-socket=${input.socket}`);
  if (input.socketMode) args.push(`--unix-socket-mode=${input.socketMode}`);
  if (input.socketGroup) {
    args.push(`--unix-socket-group=${input.socketGroup}`);
  }

  try {
    // Prefer the compiled JS entry if present, else fall back to npx tsx
    // for the TS source.
    const useJs = fs.existsSync(binJs);
    const command = useJs ? process.execPath : "npx";
    const spawnArgs = useJs ? [binJs, ...args] : ["tsx", binTs, ...args];
    const env = useJs
      ? { ...process.env, NODE_ENV: "production" }
      : { ...process.env };

    return await spawnHttpServerAndWaitForPort(command, spawnArgs, port, {
      env,
      detached: true,
      waitMs: WAIT_FOR_PORT_MS,
    });
  } catch (error) {
    return {
      success: false,
      message: `Failed to start HTTP server: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export {
  serverStatusTool,
  ServerStatusInputSchema,
  serverHttpStartTool,
  ServerHttpStartInputSchema,
};
