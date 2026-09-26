/**
 * DF-0924-06 regression tests — HTTP route level.
 *
 * Pins, against the REAL route + REAL MCP tools (no mocks — the census
 * union must run for real):
 *   AC-1: POST /api/namespaces/switch accepts a directory-present,
 *         mapping-absent namespace (registers it), and the subsequent
 *         GET /api/namespaces shows it as a HEALTHY row (no onDiskOnly,
 *         no directoryMissing);
 *   AC-2: with the default namespace never created (no mapping, no
 *         directory), GET /api/namespaces lists NO `default` row and
 *         switch to `default` refuses with an accurate error.
 *
 * Isolation: DUCKBRAIN_CONFIG_PATH + DUCKBRAIN_NAMESPACES_PATH point at
 * this file's own mkdtemp pair (GAP-007/BUG-037 class); env is restored
 * afterEach. The tracked duckbrain.config.json and the repo's namespaces/
 * directory are never touched.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import { createServer } from "http";
import fs from "fs";
import os from "os";
import path from "path";

import { createNamespaceRoutes } from "./namespaces";
import { CONFIG_FILENAME } from "../../config/index";

let tmpRoot: string;
let nsRoot: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "df092406-http-"));
  nsRoot = path.join(tmpRoot, "namespaces");
  fs.mkdirSync(nsRoot, { recursive: true });

  savedEnv = {
    DUCKBRAIN_CONFIG_PATH: process.env.DUCKBRAIN_CONFIG_PATH,
    DUCKBRAIN_NAMESPACES_PATH: process.env.DUCKBRAIN_NAMESPACES_PATH,
  };
  process.env.DUCKBRAIN_CONFIG_PATH = path.join(tmpRoot, CONFIG_FILENAME);
  process.env.DUCKBRAIN_NAMESPACES_PATH = nsRoot;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/namespaces", createNamespaceRoutes);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || "Internal server error",
      code: err.code,
    });
  });
  return app;
}

function httpRequest(
  app: express.Express,
  method: string,
  apiPath: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr !== "string" ? addr.port : 0;
      const http = require("http");
      const options: any = {
        hostname: "127.0.0.1",
        port,
        path: apiPath,
        method,
        headers: { Host: "localhost", "Content-Type": "application/json" },
      };
      // Node's http client sends request bodies chunked; an explicit
      // Content-Length makes express.json() parse the body.
      if (body) {
        options.headers["Content-Length"] = Buffer.byteLength(
          JSON.stringify(body),
        );
      }
      const req = http.request(options, (res: any) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          server.close();
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      req.on("error", (err: Error) => {
        server.close();
        reject(err);
      });
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  });
}

describe("DF-0924-06: POST /api/namespaces/switch accepts directory-present namespaces", () => {
  it("AC-1: switch to a directory-present, mapping-absent namespace succeeds; subsequent GET shows a healthy row", async () => {
    fs.mkdirSync(path.join(nsRoot, "solo"), { recursive: true });
    const app = createApp();

    const switched = await httpRequest(app, "POST", "/api/namespaces/switch", {
      name: "solo",
    });
    expect(switched.status).toBe(200);
    expect(switched.body.success).toBe(true);
    expect(switched.body.current).toBe("solo");

    // The GET right after must show solo as a HEALTHY registry row: the
    // switch registered the mapping, so the census no longer reports it as
    // onDiskOnly drift.
    const listed = await httpRequest(app, "GET", "/api/namespaces");
    expect(listed.status).toBe(200);
    const solo = listed.body.namespaces.find((n: any) => n.name === "solo");
    expect(solo).toBeDefined();
    expect(solo.onDiskOnly).toBeUndefined();
    expect(solo.directoryMissing).toBeUndefined();
  });

  it("AC-1: switch to a namespace that exists NOWHERE still 404s, naming the namespace", async () => {
    const app = createApp();
    const res = await httpRequest(app, "POST", "/api/namespaces/switch", {
      name: "no-such-ns",
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("no-such-ns");
  });
});

describe("DF-0924-06: never-created default is listed NOWHERE", () => {
  it("AC-2: GET /api/namespaces has no phantom default row when default was never created", async () => {
    // Empty scratch: no config file, no directories.
    const app = createApp();
    const { status, body } = await httpRequest(app, "GET", "/api/namespaces");

    expect(status).toBe(200);
    expect(body.namespaces.some((n: any) => n.name === "default")).toBe(false);
    expect(body.currentNamespace).toBe("default");
  });

  it("AC-2: switch to the never-created default refuses with an accurate error", async () => {
    const app = createApp();
    const res = await httpRequest(app, "POST", "/api/namespaces/switch", {
      name: "default",
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("default");
  });
});
