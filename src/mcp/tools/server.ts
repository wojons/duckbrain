/**
 * Server control MCP tools
 *
 * Tools for inspecting and triggering the DuckBrain HTTP server so MCP
 * clients can ensure MCP-over-HTTP (and the Unix socket) is reachable:
 *
 * - `server_status` — report whether the HTTP server is listening (TCP port
 *   and/or Unix socket), with PID and endpoint info.
 * - `server_http_start` — trigger the HTTP server to start as a detached
 *   background process if it is not already running. Accepts the same
 *   options as `duckbrain http` (port, socket, socket-mode, socket-group).
 */

import { z } from "zod";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { httpPidFilePath } from "../../utils/pidfile.js";

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

/**
 * server_status tool
 */
const ServerStatusInputSchema = z.object({
  port: z.number().optional().describe("TCP port to check (default: 3000)"),
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
  portListening?: boolean;
  socket?: string;
  socketListening?: boolean;
  pid?: number | null;
  pidFile?: string;
  endpoints?: string[];
}> {
  const port = input.port ?? 3000;
  const pidFile = pidFilePath(port, input.socket);
  let pid: number | null = null;
  try {
    if (fs.existsSync(pidFile)) {
      pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      if (!pid || Number.isNaN(pid)) pid = null;
    }
  } catch {
    pid = null;
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
    portListening,
    socket: input.socket,
    socketListening,
    pid,
    pidFile,
    endpoints,
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

  // Resolve the duckbrain entry point. Prefer the compiled JS if present,
  // else fall back to npx tsx for the TS source.
  const projectRoot =
    process.env.DUCKBRAIN_HOME_ROOT ||
    path.resolve(process.cwd(), "..", "..") ||
    process.cwd();
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
    const child = fs.existsSync(binJs)
      ? spawn(process.execPath, [binJs, ...args], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, NODE_ENV: "production" },
        })
      : spawn("npx", ["tsx", binTs, ...args], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env },
        });

    child.unref();

    // Wait briefly for the port to come up.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await isPortListening(port)) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const nowListening = await isPortListening(port);
    return {
      success: nowListening,
      spawned: true,
      pid: child.pid ?? null,
      message: nowListening
        ? `HTTP server started on port ${port} (pid ${child.pid})`
        : `Spawned HTTP server (pid ${child.pid}) but port ${port} not listening within 5s`,
    };
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
