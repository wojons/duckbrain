/**
 * DB-GAP-032 Regression Tests: REST namespace deletion.
 *
 * DELETE /api/namespaces/:name was missing (returned ROUTE_NOT_FOUND —
 * deletion was MCP-only via delete_namespace with confirm:true). HTTP users
 * could not clean up orphaned namespaces.
 *
 * Regressions guarded:
 *  - DELETE with {"confirm":true} removes the namespace DIRECTORY recursively
 *    (current.jsonl, .git — everything) AND unregisters the config mapping.
 *  - confirm:false or a missing confirm is rejected with 400; nothing is
 *    removed.
 *  - deleting a nonexistent namespace returns 404 NOT_FOUND; deleting twice
 *    is safe (second call 404 — mapping already gone).
 *  - a mapping that resolves OUTSIDE the namespaces root (path traversal /
 *    malicious mapping) is refused with 400 and nothing is removed.
 *
 * Isolation: the suite runs against the REAL server (createHttpServer) under
 * the test-suite temp root — DUCKBRAIN_NAMESPACES_PATH + DUCKBRAIN_CONFIG_PATH
 * are set by src/test-setup.ts (BUG-037 / GAP-022), so no live namespace or
 * the tracked duckbrain.config.json is ever touched. The config snapshot/
 * restore below guards the TEMP config file, never the repo config.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createHttpServer } from "../../cli/http";
import { createServer, Server } from "http";
import { getConfig, updateConfig } from "../../config/index";

// The config file the tools actually use: the GAP-022 env override when the
// suite set it (src/test-setup.ts), else the repo-root file as fallback.
const CONFIG_PATH =
  process.env.DUCKBRAIN_CONFIG_PATH ||
  path.join(process.cwd(), "duckbrain.config.json");
const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;

let server: Server;
let port: number;

interface HttpResponse {
  status: number;
  body: any;
}

function httpRequest(
  method: string,
  pathName: string,
  body?: Record<string, unknown>,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const payload = body ? JSON.stringify(body) : undefined;
    const options: any = {
      hostname: "127.0.0.1",
      port,
      path: pathName,
      method,
      headers: {
        Host: "localhost",
        "Content-Type": "application/json",
        // Node's http client treats DELETE as bodyless and would otherwise
        // omit framing entirely — the body never arrives (Express 5's
        // express.json() then leaves req.body undefined). curl sets
        // Content-Length automatically for -d payloads; the test helper
        // must set it explicitly.
        ...(payload !== undefined
          ? { "Content-Length": Buffer.byteLength(payload) }
          : {}),
      },
    };

    const req = http.request(options, (res: any) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

let configSnapshot: string;

beforeAll(async () => {
  const app = createHttpServer();
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") port = addr.port;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  configSnapshot = fs.existsSync(CONFIG_PATH)
    ? fs.readFileSync(CONFIG_PATH, "utf-8")
    : "";
});

afterEach(() => {
  // Restore the (temp) config file so a test never leaks mappings.
  if (configSnapshot) {
    fs.writeFileSync(CONFIG_PATH, configSnapshot, "utf-8");
  } else if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
  }
});

/** Read the live namespaceMappings straight from disk (bypassing caches). */
function liveMappings(): Record<string, string> {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")).namespaceMappings;
}

/** Seed files that mimic real namespace contents (current.jsonl + .git). */
function seedNamespaceContents(dirPath: string): void {
  fs.writeFileSync(path.join(dirPath, "current.jsonl"), '{"k":"v"}\n');
  fs.writeFileSync(path.join(dirPath, "manifest.json"), "{}\n");
  fs.mkdirSync(path.join(dirPath, ".git", "refs"), { recursive: true });
  fs.writeFileSync(
    path.join(dirPath, ".git", "HEAD"),
    "ref: refs/heads/main\n",
  );
}

describe("DB-GAP-032: DELETE /api/namespaces/:name", () => {
  it("removes the namespace dir + its git repo + unregisters the mapping (200)", async () => {
    const name = "dbgap032-recdel";
    // Create via the real REST create path (goes through createNamespaceTool).
    const created = await httpRequest("POST", "/api/namespaces", {
      name,
      setDefault: false,
    });
    expect(created.status).toBe(201);

    const dirPath = path.join(NS_ROOT, name);
    expect(fs.existsSync(dirPath)).toBe(true);
    seedNamespaceContents(dirPath);
    expect(liveMappings()[name]).toBeDefined();

    const { status, body } = await httpRequest(
      "DELETE",
      `/api/namespaces/${name}`,
      {
        confirm: true,
      },
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.path).toBe(path.resolve(dirPath));
    expect(fs.existsSync(dirPath)).toBe(false);
    expect(fs.existsSync(path.join(dirPath, ".git"))).toBe(false);
    expect(liveMappings()[name]).toBeUndefined();
  });

  it("rejects confirm:false with 400 and removes nothing", async () => {
    const name = "dbgap032-noconfirm";
    await httpRequest("POST", "/api/namespaces", { name, setDefault: false });
    const dirPath = path.join(NS_ROOT, name);
    seedNamespaceContents(dirPath);

    const { status, body } = await httpRequest(
      "DELETE",
      `/api/namespaces/${name}`,
      {
        confirm: false,
      },
    );

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.error).toContain("Confirmation required");
    expect(fs.existsSync(dirPath)).toBe(true);
    expect(liveMappings()[name]).toBeDefined();
  });

  it("rejects a missing confirm body with 400 and removes nothing", async () => {
    const name = "dbgap032-nobody";
    await httpRequest("POST", "/api/namespaces", { name, setDefault: false });
    const dirPath = path.join(NS_ROOT, name);

    const { status, body } = await httpRequest(
      "DELETE",
      `/api/namespaces/${name}`,
    );

    expect(status).toBe(400);
    expect(body.error).toContain("Confirmation required");
    expect(fs.existsSync(dirPath)).toBe(true);
    expect(liveMappings()[name]).toBeDefined();
  });

  it("returns 404 for a nonexistent namespace (idempotent — nothing to remove)", async () => {
    const { status, body } = await httpRequest(
      "DELETE",
      "/api/namespaces/dbgap032-never-existed",
      { confirm: true },
    );

    expect(status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
    expect(body.error).toContain("not found");
  });

  it("deleting twice: first 200, second 404 (mapping already gone)", async () => {
    const name = "dbgap032-twice";
    await httpRequest("POST", "/api/namespaces", { name, setDefault: false });
    const dirPath = path.join(NS_ROOT, name);
    expect(fs.existsSync(dirPath)).toBe(true);

    const first = await httpRequest("DELETE", `/api/namespaces/${name}`, {
      confirm: true,
    });
    expect(first.status).toBe(200);

    const second = await httpRequest("DELETE", `/api/namespaces/${name}`, {
      confirm: true,
    });
    expect(second.status).toBe(404);
    expect(second.body.error).toContain("not found");
  });

  it("rejects invalid namespace name characters with 400", async () => {
    const { status, body } = await httpRequest(
      "DELETE",
      "/api/namespaces/Bad%20Name!",
      { confirm: true },
    );

    expect(status).toBe(400);
    expect(body.error).toContain("lowercase alphanumeric");
  });

  it("refuses a mapping that resolves OUTSIDE the namespaces root (path traversal)", async () => {
    // Create a target directory OUTSIDE the ns root (still in a temp area).
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-dbgap032-trav-"),
    );
    const name = "dbgap032-trav";
    // Register a malicious mapping pointing outside the root.
    updateConfig(".", {
      namespaceMappings: {
        ...getConfig(".").namespaceMappings,
        [name]: outsideDir,
      },
    });

    const { status, body } = await httpRequest(
      "DELETE",
      `/api/namespaces/${name}`,
      {
        confirm: true,
      },
    );

    expect(status).toBe(400);
    expect(body.error).toContain(
      "Refusing to delete path outside namespaces root",
    );
    // The outside dir must be untouched.
    expect(fs.existsSync(outsideDir)).toBe(true);
    // The mapping must remain (no half-remove).
    expect(liveMappings()[name]).toBeDefined();

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});
