/**
 * REG-GONE-001 regression tests
 *
 * Contract under test: registry rows whose namespace directory was removed
 * out-of-band (`rm -rf`) must be
 *   AC-1: flagged with directoryMissing: true on GET /api/namespaces,
 *         while healthy rows in the same response carry NO such flag;
 *   AC-2: removable via DELETE /api/namespaces/:name (the DOGFOOD-004
 *         idempotent path — mapping present, directory already gone →
 *         success, mapping removed, never a silent leftover row).
 *
 * Everything runs inside vitest tmp dirs (mkdtemp) — the repo's real
 * namespaces/ directory and ~/.duckbrain are never touched. The config file
 * location is redirected via DUCKBRAIN_CONFIG_PATH (GAP-022) and the
 * namespaces root via DUCKBRAIN_NAMESPACES_PATH (BUG-037); both env vars are
 * saved/restored around each test.
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reggone-001-"));
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
      // Node's http client sends request bodies chunked; express.json() then
      // leaves req.body undefined on DELETE. An explicit Content-Length makes
      // the body parse — required for the confirm:true payload.
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

/**
 * Register a real namespace row (mapping written to the redirected config
 * file) with an optional directory on disk.
 */
function makeNamespaceRow(name: string, withDirectory: boolean): string {
  const nsPath = path.join(nsRoot, name);
  if (withDirectory) {
    fs.mkdirSync(nsPath, { recursive: true });
    fs.writeFileSync(
      path.join(nsPath, "manifest.json"),
      JSON.stringify({ version: "1.0", createdAt: "2026-01-01" }) + "\n",
    );
  }
  registerNamespace(".", name, nsPath);
  return nsPath;
}

describe("REG-GONE-001 GET /api/namespaces directoryMissing flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AC-1a: healthy row lists with NO directoryMissing flag", async () => {
    const healthyPath = makeNamespaceRow("healthy", true);
    mockedListNamespaces.mockResolvedValue({
      success: true,
      namespaces: [{ name: "healthy", path: healthyPath, isDefault: false }],
      currentNamespace: "healthy",
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, "GET", "/api/namespaces");

    expect(status).toBe(200);
    expect(body.namespaces).toHaveLength(1);
    const row = body.namespaces[0];
    expect(row.name).toBe("healthy");
    expect(row).not.toHaveProperty("directoryMissing");
    expect(fs.existsSync(healthyPath)).toBe(true);
  });

  it("AC-1b: gone-directory row is flagged; healthy rows in the same response stay unflagged", async () => {
    const gonePath = makeNamespaceRow("gone", true);
    const healthyPath = makeNamespaceRow("healthy", true);

    // Out-of-band removal — the REG-GONE-001 defect trigger.
    fs.rmSync(gonePath, { recursive: true, force: true });

    mockedListNamespaces.mockResolvedValue({
      success: true,
      namespaces: [
        { name: "gone", path: gonePath, isDefault: false },
        { name: "healthy", path: healthyPath, isDefault: true },
      ],
      currentNamespace: "healthy",
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, "GET", "/api/namespaces");

    expect(status).toBe(200);
    expect(body.namespaces).toHaveLength(2);

    const goneRow = body.namespaces.find((r: any) => r.name === "gone");
    const healthyRow = body.namespaces.find((r: any) => r.name === "healthy");

    expect(goneRow).toBeDefined();
    expect(goneRow.directoryMissing).toBe(true);

    expect(healthyRow).toBeDefined();
    expect(healthyRow).not.toHaveProperty("directoryMissing");
  });
});

describe("REG-GONE-001 DELETE /api/namespaces/:name on gone directory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AC-2: DELETE with confirm:true succeeds, follow-up GET drops the row, mapping removed", async () => {
    const gonePath = makeNamespaceRow("stale-gone", true);

    // Out-of-band removal.
    fs.rmSync(gonePath, { recursive: true, force: true });
    expect(fs.existsSync(gonePath)).toBe(false);

    // Confirm the config mapping is present before the delete.
    const configBefore = JSON.parse(
      fs.readFileSync(process.env.DUCKBRAIN_CONFIG_PATH!, "utf-8"),
    );
    expect(configBefore.namespaceMappings["stale-gone"]).toBe(gonePath);

    const app = createApp();
    const del = await httpRequest(app, "DELETE", "/api/namespaces/stale-gone", {
      confirm: true,
    });

    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);
    expect(del.body.path).toBe(gonePath);

    // Config mapping is gone.
    const configAfter = JSON.parse(
      fs.readFileSync(process.env.DUCKBRAIN_CONFIG_PATH!, "utf-8"),
    );
    expect(configAfter.namespaceMappings["stale-gone"]).toBeUndefined();

    // A fresh list (real listNamespacesTool reads the updated config) no
    // longer advertises the namespace.
    const listed = await listNamespacesTool({});
    expect(listed.success).toBe(true);
    expect(
      (listed.namespaces ?? []).find((n: any) => n.name === "stale-gone"),
    ).toBeUndefined();
  });

  it("AC-2 guard: DELETE without confirm:true is refused (400), row survives", async () => {
    const gonePath = makeNamespaceRow("no-confirm", true);
    fs.rmSync(gonePath, { recursive: true, force: true });

    const app = createApp();
    const del = await httpRequest(app, "DELETE", "/api/namespaces/no-confirm");

    expect(del.status).toBe(400);
    expect(del.body.error).toContain("confirm=true");

    const config = JSON.parse(
      fs.readFileSync(process.env.DUCKBRAIN_CONFIG_PATH!, "utf-8"),
    );
    expect(config.namespaceMappings["no-confirm"]).toBe(gonePath);
  });
});
