/**
 * DB-GAP-065 AC-5 — drift guard on GET /api/namespaces.
 *
 * Contract under test:
 *   - below threshold (dead < 25 AND dead <= 2x live): NO driftWarning;
 *   - at/above threshold (dead >= 25 OR dead > 2x live): driftWarning present
 *     with { deadCount, liveCount, hint } and a hint naming
 *     `duckbrain namespaces prune --apply`;
 *   - clean registry: neither `drift` nor `driftWarning`.
 *
 * Everything runs in vitest tmp dirs; the live registry/config is untouched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import { createServer } from "http";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../../mcp/tools/namespace", () => ({
  listNamespacesTool: vi.fn(),
  createNamespaceTool: vi.fn(),
  switchNamespaceTool: vi.fn(),
}));

import { listNamespacesTool } from "../../mcp/tools/namespace";
import { registerNamespace } from "../../config";
import { createNamespaceRoutes } from "./namespaces";

const mockedListNamespaces = vi.mocked(listNamespacesTool);

let tmpRoot: string;
let nsRoot: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dbgap065-drift-"));
  nsRoot = path.join(tmpRoot, "namespaces");
  fs.mkdirSync(nsRoot, { recursive: true });

  savedEnv = {
    DUCKBRAIN_CONFIG_PATH: process.env.DUCKBRAIN_CONFIG_PATH,
    DUCKBRAIN_NAMESPACES_PATH: process.env.DUCKBRAIN_NAMESPACES_PATH,
  };
  process.env.DUCKBRAIN_CONFIG_PATH = path.join(
    tmpRoot,
    "duckbrain.config.json",
  );
  process.env.DUCKBRAIN_NAMESPACES_PATH = nsRoot;
  vi.clearAllMocks();
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
    res.status(status).json({ error: err.message || "Internal server error" });
  });
  return app;
}

function httpGet(app: express.Express, apiPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr !== "string" ? addr.port : 0;
      const http = require("http");
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: apiPath,
          method: "GET",
          headers: { Host: "localhost" },
        },
        (res: any) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          });
        },
      );
      req.on("error", (err: Error) => {
        server.close();
        reject(err);
      });
      req.end();
    });
  });
}

/**
 * Register `liveCount` namespaces WITH directories and `deadCount` namespaces
 * whose directory never existed (the REG-GONE-001 shape), then serve them from
 * the mocked list tool exactly as the real tool would.
 */
async function serveRegistry(liveCount: number, deadCount: number) {
  const rows: { name: string; path: string; isDefault: boolean }[] = [];

  for (let i = 0; i < liveCount; i++) {
    const name = `live-${i}`;
    const nsPath = path.join(nsRoot, name);
    fs.mkdirSync(nsPath, { recursive: true });
    fs.writeFileSync(path.join(nsPath, "manifest.json"), '{"version":"1.0"}\n');
    registerNamespace(".", name, nsPath);
    rows.push({ name, path: nsPath, isDefault: i === 0 });
  }
  for (let i = 0; i < deadCount; i++) {
    const name = `dead-${i}`;
    const nsPath = path.join(nsRoot, name);
    registerNamespace(".", name, nsPath);
    rows.push({ name, path: nsPath, isDefault: false });
  }

  mockedListNamespaces.mockResolvedValue({
    success: true,
    namespaces: rows,
    currentNamespace: liveCount > 0 ? "live-0" : "dead-0",
  });

  return httpGet(createApp(), "/api/namespaces");
}

describe("DB-GAP-065 AC-5: GET /api/namespaces drift warning", () => {
  it("clean registry: no drift and no driftWarning", async () => {
    const { status, body } = await serveRegistry(3, 0);
    expect(status).toBe(200);
    expect(body.drift).toBeUndefined();
    expect(body.driftWarning).toBeUndefined();
    expect(body.namespaces).toHaveLength(3);
  });

  it("below threshold (24 dead, 100 live): counts reported, NO warning", async () => {
    const { status, body } = await serveRegistry(100, 24);
    expect(status).toBe(200);
    expect(body.drift.directoryMissing).toBe(24);
    // 24 < 25 and 24 <= 2*100 → not a backlog.
    expect(body.driftWarning).toBeUndefined();
  });

  it("absolute threshold (25 dead, 100 live): warning present and actionable", async () => {
    const { status, body } = await serveRegistry(100, 25);
    expect(status).toBe(200);
    expect(body.drift.directoryMissing).toBe(25);
    expect(body.driftWarning).toEqual({
      deadCount: 25,
      liveCount: 100,
      hint: "run 'duckbrain namespaces prune --apply'",
    });
  });

  it("ratio threshold (10 dead, 4 live): warning even below 25 dead", async () => {
    const { status, body } = await serveRegistry(4, 10);
    expect(status).toBe(200);
    expect(body.driftWarning).toBeDefined();
    expect(body.driftWarning.deadCount).toBe(10);
    expect(body.driftWarning.liveCount).toBe(4);
    expect(body.driftWarning.hint).toContain("namespaces prune --apply");
  });

  it("ratio boundary (10 dead, 5 live = exactly 2x): NO warning", async () => {
    const { status, body } = await serveRegistry(5, 10);
    expect(status).toBe(200);
    // dead (10) is not > 2 * live (10) and 10 < 25 → still below threshold.
    expect(body.driftWarning).toBeUndefined();
  });
});
