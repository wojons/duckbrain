/**
 * HTTP MCP Server
 *
 * HTTP server with Streamable HTTP transport for remote MCP access.
 * Includes DNS rebinding protection, authentication, rate limiting, and multi-user endpoints.
 *
 * Endpoints:
 * - POST /mcp, GET /mcp - Streamable HTTP transport
 * - GET /health - Health check (unauthenticated)
 * - GET /stats - System statistics
 * - GET /namespaces - List loaded namespaces
 * - GET /users - List unique authors
 * - GET /activity - Recent activity feed
 * - GET /api/tree - Hierarchical memory tree
 * - GET /api/timeline - Chronological feed
 * - GET /api/search - Search with filters
 */

import express, { Express, Request, Response, NextFunction } from "express";
import http from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Mutex } from "async-mutex";
import { server, stopServer, registerTools } from "../mcp/server.js";
import { authMiddleware, AuthConfig } from "../auth/middleware.js";
import { rateLimitMiddleware, RateLimitConfig } from "../auth/ratelimit.js";
import {
  errorHandler,
  notFoundHandler,
} from "../http/middleware/errorHandler.js";
import { listNamespacesTool } from "../mcp/tools/namespace.js";
import { probeKeysStore } from "../mcp/tools/list_keys.js";
import { createMemoryRoutes } from "../http/routes/memories.js";
import { createKeyRoutes } from "../http/routes/keys.js";
import { createNamespaceRoutes } from "../http/routes/namespaces.js";
import { createEventsRoutes } from "../http/routes/events.js";
import { createCompactionRoutes } from "../http/routes/compaction.js";
import { createUsersRoutes } from "../http/routes/users.js";
import { createActivityRoutes } from "../http/routes/activity.js";
import path from "path";
import fs from "fs";
import os from "os";
import { httpPidFilePath, cleanupStalePidFile } from "../utils/pidfile.js";
import {
  getEmbeddingHealth,
  type EmbeddingHealthResult,
} from "../embedding/health.js";

/**
 * HTTP server configuration options
 */
export interface HttpServerOptions {
  /** Port to listen on (default: 3000) */
  port?: number;
  /** Bind to all interfaces (0.0.0.0) instead of localhost only */
  bindAll?: boolean;
  /** Authentication type: none, basic, or apikey */
  authType?: "none" | "basic" | "apikey";
  /** Rate limit: requests per minute per IP (default: 100) */
  rateLimit?: number;
  /** Unix domain socket path to also listen on (in addition to TCP port).
   *  Enables MCP-over-HTTP and CLI access via filesystem socket. */
  socket?: string;
  /** Socket file permissions as octal string (default: "0660").
   *  Applied via chmod after bind. */
  socketMode?: string;
  /** Group name or numeric GID to chown the socket file to.
   *  Allows other users in the group to connect. */
  socketGroup?: string;
  /** Auth configuration override (DB-GAP-031: unit-test injection).
   *  When provided, ~/.duckbrain/auth.json is NOT consulted — the server
   *  runs with exactly this config. Production callers omit it and keep
   *  the file-based behavior. */
  authConfig?: AuthConfig;
}

/**
 * DNS rebinding protection middleware
 * Validates Host header against allowed hosts
 */
function dnsRebindingProtection(allowedHosts: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const host = req.headers.host?.split(":")[0];

    if (!host || !allowedHosts.includes(host)) {
      res.status(403).json({ error: "Forbidden: Invalid host" });
      return;
    }

    next();
  };
}

/**
 * Health check endpoint handler (DOGFOOD-020, DB-GAP-035)
 *
 * Reports embedding provider health alongside process liveness. The top-level
 * status is "degraded" when no embedding provider passed a real embed probe —
 * fleet monitors previously got a false green while every ?q= semantic search
 * 500ed (configured model 400ing on LM Studio with the model file on an
 * offline host; Ollama not having the model in /api/tags).
 *
 * DB-GAP-035: also probes the keys store (same resilient read as list_keys)
 * and surfaces keys_error — null when the store answers, a short error
 * string when the keys read path fails (corrupt JSONL, missing namespace,
 * connection loss). A failed keys probe flips status to degraded: every
 * consumer of keys over HTTP/MCP would fail, so a green /health would be a
 * false green.
 *
 * HTTP status stays 200 in both cases (liveness monitors; the systemd unit
 * has no health check) — the body carries the signal.
 *
 * @param probe injectable for tests (defaults to the 30s-TTL-cached probe)
 * @param keysProbe injectable for tests (defaults to probeKeysStore)
 */
export function createHealthHandler(
  probe: () => Promise<EmbeddingHealthResult> = getEmbeddingHealth,
  keysProbe: () => Promise<string | null> = probeKeysStore,
): (req: Request, res: Response) => Promise<void> {
  return async (_req: Request, res: Response) => {
    let embedding: EmbeddingHealthResult;
    try {
      embedding = await probe();
    } catch (e) {
      // The probe must never take /health down (liveness) — report degraded.
      embedding = {
        provider: "",
        model: "",
        healthy: false,
        providers: [
          {
            id: "probe",
            healthy: false,
            note: `probe error: ${e instanceof Error ? e.message : String(e)}`,
          },
        ],
      };
    }

    // DB-GAP-035: keys-store probe. Must never take /health down either —
    // report keys_error and let the status field carry the signal.
    let keysError: string | null = null;
    try {
      keysError = await keysProbe();
    } catch (e) {
      keysError = `probe error: ${e instanceof Error ? e.message : String(e)}`.slice(
        0,
        200,
      );
    }

    res.json({
      status:
        embedding.healthy && keysError === null ? "healthy" : "degraded",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      embedding,
      keys_error: keysError,
    });
  };
}

/**
 * Stats endpoint handler
 */
function statsHandler(_req: Request, res: Response) {
  res.json({
    memory: process.memoryUsage(),
    uptime: process.uptime(),
    nodeVersion: process.version,
  });
}

/**
 * MCP tools are registered on the module-level singleton `server`, whose
 * registerTools() throws on a second call. Guard at module scope so multiple
 * createHttpServer() calls in one process (in-process tests, embedders) register
 * exactly once instead of failing the second construction.
 */
let mcpToolsRegistered = false;

/**
 * Create Express app with MCP transport, auth, and rate limiting
 *
 * Middleware order (critical):
 * 1. DNS rebinding protection (block bad hosts immediately)
 * 2. Rate limiting (catch abuse before auth processing)
 * 3. Authentication (verify credentials)
 * 4. JSON body parser (after rate limit/auth to avoid parsing overhead on rejected requests)
 * 5. Routes
 *
 * @param options - Server configuration options
 */
export function createHttpServer(options: HttpServerOptions = {}): Express {
  const app = express();

  // 1. DNS rebinding protection
  const allowedHosts = ["localhost", "127.0.0.1"];
  if (options.bindAll) {
    // When binding to all interfaces, allow any hostname
    // User explicitly chose to expose the server
    app.use((_req: Request, _res: Response, next: NextFunction) => {
      next(); // Skip DNS rebinding check when bindAll
    });
  } else {
    app.use(dnsRebindingProtection(allowedHosts));
  }

  // 2. Rate limiting (before auth to prevent credential stuffing/brute force)
  const rateLimitConfig: RateLimitConfig = {
    requestsPerMinute: options.rateLimit ?? 100,
  };
  app.use(rateLimitMiddleware(rateLimitConfig));

  // 3. Authentication — read credentials from ~/.duckbrain/auth.json if
  // available (unless an explicit authConfig override was injected).
  const authConfig: AuthConfig = options.authConfig ?? {
    type: options.authType ?? "none",
  };
  if (!options.authConfig) {
    const authFilePath = path.join(os.homedir(), ".duckbrain", "auth.json");
    if (fs.existsSync(authFilePath)) {
      try {
        const authFile = JSON.parse(fs.readFileSync(authFilePath, "utf-8"));
        if (authFile.users) authConfig.users = authFile.users;
        if (authFile.apiKeys) authConfig.apiKeys = authFile.apiKeys;
      } catch {
        console.error("[duckbrain] Warning: Could not parse auth.json");
      }
    }
  }
  app.use(authMiddleware(authConfig));

  // 4. CORS middleware for UI development
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      res.status(200).end();
      return;
    }

    next();
  });

  // 5. JSON body parser (after rate limit and auth)
  app.use(express.json());

  // Health check (bypasses auth via middleware, must be registered here)
  app.get("/health", createHealthHandler());

  // Stats
  app.get("/stats", statsHandler);

  // API Routes (new REST API)
  app.use("/api/memories", createMemoryRoutes);
  app.use("/api/keys", createKeyRoutes);
  app.use("/api/namespaces", createNamespaceRoutes);
  app.use("/api/events", createEventsRoutes);
  app.use("/api/compaction", createCompactionRoutes);

  // Legacy namespaces — delegate to real MCP tool
  app.get("/namespaces", async (_req: Request, res: Response) => {
    const result = await listNamespacesTool({});
    if (!result.success) {
      res
        .status(500)
        .json({ error: result.error || "Failed to list namespaces" });
      return;
    }
    const namespaces = result.namespaces.map((ns: any) => ns.name);
    res.json({ namespaces, currentNamespace: result.currentNamespace });
  });

  // Users list — extracts unique authors from namespace commit history
  app.use("/users", createUsersRoutes);

  // Activity feed — returns recent memory activity across all namespaces
  app.use("/activity", createActivityRoutes);

  // Legacy API stubs (redirect to new endpoints)
  app.get("/api/tree", (req: Request, res: Response) => {
    res.redirect(301, "/api/keys?prefix=" + (req.query.prefix || "/"));
  });

  app.get("/api/timeline", (req: Request, res: Response) => {
    res.redirect(301, "/api/memories?limit=" + (req.query.limit || "50"));
  });

  app.get("/api/search", (req: Request, res: Response) => {
    res.redirect(301, "/api/memories?q=" + (req.query.q || ""));
  });

  // Error handling (must be after all routes)

  // CLI remote execution endpoint (for --socket usage)
  // Whitelist: only safe/non-destructive CLI commands allowed via remote socket.
  // Blocked: stdio (launches MCP server), http (launches HTTP server),
  //          service (systemd management — stop/restart could take down the daemon).
  const CLI_COMMAND_WHITELIST = new Set([
    "remember",
    "recall",
    "list-keys",
    "forget",
    "config",
    "namespaces",
    "namespace",
    "pull",
    "push",
    "remote",
    "status",
    "token",
    "squash",
    "ssh-test",
    "ssh-connect",
    "servers",
  ]);

  // Security limits for CLI arguments (prevents DoS via memory/time exhaustion)
  const CLI_MAX_ARGS = 100;
  const CLI_MAX_ARG_LENGTH = 4096;

  /**
   * Validate CLI arguments for security.
   * Rejects path traversal, null bytes, newlines, and excessive sizes.
   *
   * @returns { valid: true } or { valid: false; error: string }
   */
  function validateCliArgs(
    args: unknown,
  ): { valid: true } | { valid: false; error: string } {
    // Args must be an array of strings (or absent)
    if (args === undefined || args === null) {
      return { valid: true };
    }

    if (!Array.isArray(args)) {
      return { valid: false, error: "args must be an array of strings" };
    }

    // Reject too many args (DoS prevention)
    if (args.length > CLI_MAX_ARGS) {
      return { valid: false, error: `args exceeds maximum of ${CLI_MAX_ARGS}` };
    }

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      // Each arg must be a string
      if (typeof arg !== "string") {
        return { valid: false, error: "args must be an array of strings" };
      }

      // Reject excessively long args (DoS prevention)
      if (arg.length > CLI_MAX_ARG_LENGTH) {
        return {
          valid: false,
          error: `arg[${i}] exceeds maximum length of ${CLI_MAX_ARG_LENGTH} characters`,
        };
      }

      // Reject null byte injection — can cause C-level string truncation in
      // child processes and libraries, bypassing downstream validation.
      if (arg.includes("\x00")) {
        return { valid: false, error: `arg[${i}] contains null byte` };
      }

      // Reject newline injection — prevents log injection, command splitting in
      // downstream CLI parsers, and HTTP header injection through stderr/stdout.
      if (arg.includes("\n") || arg.includes("\r")) {
        return { valid: false, error: `arg[${i}] contains newline character` };
      }

      // Reject path traversal — blocks attempts to read/write files outside
      // the intended directories via subcommands that process file paths.
      if (
        arg.includes("..") &&
        (arg.startsWith("..") ||
          arg.includes("/..") ||
          arg.includes("\\..") ||
          arg === "..")
      ) {
        return {
          valid: false,
          error: `arg[${i}] contains path traversal sequence`,
        };
      }
    }

    return { valid: true };
  }

  app.post("/cli", async (req: Request, res: Response) => {
    try {
      const { command, args: cmdArgs } = req.body;

      // Input validation: command must be a non-empty string
      if (!command || typeof command !== "string") {
        res.status(400).json({ error: "Missing or invalid command" });
        return;
      }

      // Command whitelist: reject disallowed commands
      if (!CLI_COMMAND_WHITELIST.has(command)) {
        res.status(403).json({ error: `Command not allowed: ${command}` });
        return;
      }

      // Args security validation
      const argsValidation = validateCliArgs(cmdArgs);
      if (!argsValidation.valid) {
        res.status(400).json({ error: argsValidation.error });
        return;
      }

      const { execFile } = await import("child_process");
      const binPath = path.resolve(process.cwd(), "bin/duckbrain.ts");
      const fullArgs = [binPath, command, ...(cmdArgs || [])];

      execFile(
        "npx",
        ["tsx", ...fullArgs],
        {
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          cwd: process.cwd(),
          env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        },
        (err: any, stdout: string, stderr: string) => {
          if (err) {
            const output = [stderr, stdout].filter(Boolean).join("\n").trim();
            res.json({ error: output || err.message, exitCode: err.code || 1 });
            return;
          }
          const output = stdout.trim();
          const errOutput = stderr.trim();
          res.json({ output, error: errOutput || undefined, exitCode: 0 });
        },
      );
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Internal error",
      });
    }
  });

  // Streamable HTTP transport for MCP.
  //
  // Tools are registered on the singleton server exactly once (registerTools()
  // throws "Tool <name> is already registered" if called twice; the module-scope
  // mcpToolsRegistered flag guards against repeat createHttpServer() calls). In
  // stateless
  // mode (sessionIdGenerator: undefined) the SDK requires a *fresh* transport per
  // request — reusing one throws "Stateless transport cannot be reused across
  // requests". So each request gets a new transport that is connected, used, and
  // then closed, which releases the singleton server to connect again next time.
  //
  // Requests are serialized with a mutex because the singleton server accepts only
  // one transport at a time — a second overlapping server.connect() throws
  // "Already connected to a transport".
  if (!mcpToolsRegistered) {
    registerTools();
    mcpToolsRegistered = true;
  }
  const mcpMutex = new Mutex();

  const handleMcpRequest = (
    req: Request,
    res: Response,
    parsedBody?: unknown,
  ): Promise<void> =>
    mcpMutex.runExclusive(async () => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // Return a single JSON response per request instead of an open SSE
        // stream, so each stateless request completes and releases promptly.
        enableJsonResponse: true,
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
      } finally {
        await transport.close().catch(() => {});
      }
    });

  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      // express.json() has already consumed the request stream, so pass the
      // parsed body to the transport explicitly.
      await handleMcpRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  // GET opens the optional server-to-client SSE stream. DuckBrain is
  // request/response only (no server-initiated messages) and the singleton server
  // cannot hold a long-lived GET stream while also answering POSTs, so this
  // endpoint does not offer it. Per the MCP spec, return 405; the Streamable HTTP
  // client treats 405 as "no SSE stream here" and continues with POST only.
  app.get("/mcp", (_req: Request, res: Response) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            "Method Not Allowed: this endpoint does not offer a GET SSE stream",
        },
        id: null,
      });
  });

  app.use(errorHandler);
  app.use(notFoundHandler);

  return app;
}

/**
 * Listen on a Unix domain socket with correct filesystem permissions.
 *
 * Removes a stale socket file, binds, then applies chmod (default 0660) and
 * optional chown to a group. Shared by startHttpMode and tests/embedders.
 *
 * @param app Express app to serve
 * @param socketPath Unix socket path
 * @param opts Permissions: socketMode (octal string), socketGroup (name or GID)
 * @returns the listening http.Server
 */
export function listenOnSocket(
  app: Express,
  socketPath: string,
  opts: { socketMode?: string; socketGroup?: string } = {},
): Promise<http.Server> {
  const socketMode = opts.socketMode ?? "0660";

  return new Promise((resolve, reject) => {
    // Remove stale socket file if present (previous crash may have left it)
    try {
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
        console.error(`[duckbrain] Removed stale socket file: ${socketPath}`);
      }
    } catch (e) {
      console.error(
        `[duckbrain] Warning: could not remove stale socket ${socketPath}:`,
        e,
      );
    }

    const server = app.listen(socketPath, () => {
      // Apply filesystem permissions after bind
      try {
        const mode = parseInt(socketMode, 8);
        if (!Number.isNaN(mode)) {
          fs.chmodSync(socketPath, mode);
        }
        if (opts.socketGroup) {
          // Resolve group name to GID (or accept numeric GID directly)
          let gid: number;
          const numeric = parseInt(opts.socketGroup, 10);
          if (!Number.isNaN(numeric)) {
            gid = numeric;
          } else {
            const { execSync } = require("child_process");
            gid = parseInt(
              execSync(`getent group ${opts.socketGroup} | cut -d: -f3`)
                .toString()
                .trim(),
              10,
            );
          }
          fs.chownSync(socketPath, -1, gid);
        }
        console.error(
          `[duckbrain] HTTP server listening on Unix socket ${socketPath} (mode ${socketMode})`,
        );
      } catch (e) {
        console.error(
          `[duckbrain] Warning: could not set socket permissions:`,
          e,
        );
      }
      resolve(server);
    });

    server.on("error", reject);
  });
}

/**
 * Start HTTP server
 *
 * Listens on TCP (port) and, if `options.socket` is set, on a Unix domain
 * socket. Socket permissions are applied via chmod/chown after bind so the
 * file is created with the requested mode (default 0660) and optional group.
 *
 * @param options Server options
 */
export async function startHttpMode(
  options: HttpServerOptions = {},
): Promise<void> {
  const { port = 3000, bindAll = false, socket, socketMode = "0660" } = options;
  const host = bindAll ? "0.0.0.0" : "127.0.0.1";
  const pidFile = httpPidFilePath(port, socket);

  try {
    const app = createHttpServer(options);
    const servers: http.Server[] = [];

    // Start TCP listener (always, unless socket-only mode is requested via port 0)
    await new Promise<void>((resolve, reject) => {
      const httpServer = app.listen(port, host, () => {
        console.error(
          `[duckbrain] HTTP server started at http://${host}:${port}`,
        );
        resolve();
      });

      httpServer.on("error", reject);
      servers.push(httpServer);

      // Graceful shutdown
      const shutdown = () => {
        // Remove PID file on shutdown
        try {
          if (fs.existsSync(pidFile)) {
            fs.unlinkSync(pidFile);
          }
        } catch (e) {
          // Ignore cleanup errors
        }

        // Remove socket file if present
        if (socket) {
          try {
            if (fs.existsSync(socket)) {
              fs.unlinkSync(socket);
            }
          } catch (e) {
            // Ignore cleanup errors
          }
        }

        Promise.all(
          servers.map(
            (s) =>
              new Promise<void>((r) => {
                s.close(() => r());
              }),
          ),
        ).then(async () => {
          await stopServer();
          process.exit(0);
        });
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });

    // Write PID to local file for easy management. If a previous instance
    // crashed and left a pidfile whose PID is no longer alive, remove it
    // first so a dead pid never shadows the live server (DOGFOOD-016).
    cleanupStalePidFile(pidFile);
    fs.writeFileSync(pidFile, process.pid.toString());
    console.error(`[duckbrain] PID written to: ${pidFile}`);

    // Start Unix socket listener if requested
    if (socket) {
      const socketServer = await listenOnSocket(app, socket, {
        socketMode,
        socketGroup: options.socketGroup,
      });
      servers.push(socketServer);
    }

    // Keep process alive — servers array holds listeners; also prevent
    // premature exit when only socket listening.
    console.error("[duckbrain] HTTP server ready");
  } catch (error) {
    console.error("[duckbrain] Failed to start HTTP server:", error);
    process.exit(1);
  }
}

// Auto-start if run directly
if (
  process.argv[1]?.endsWith("http.ts") ||
  process.argv[1]?.endsWith("http.js")
) {
  startHttpMode().catch((error: unknown) => {
    console.error("[duckbrain] Unhandled error:", error);
    process.exit(1);
  });
}
