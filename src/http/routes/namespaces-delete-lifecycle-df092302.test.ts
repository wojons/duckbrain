/**
 * DF-0923-02 Regression Tests: lifecycle audit logging on REST/MCP deletion.
 *
 * The shared deletion core (src/namespaces/delete.ts) writes NOTHING to
 * lifecycle.log — the audit trail only existed for deleteNamespaceFromDisk /
 * clearNamespaceFromS3 / `s3 ghosts --sweep`. REST DELETE /api/namespaces/:name
 * and the MCP delete_namespace tool are the surfaces agents use most, and both
 * were silent destructive paths.
 *
 * Regressions guarded:
 *  - a REST DELETE with confirm:true appends a JSONL line to
 *    <namespacesRoot>/.s3state/lifecycle.log with surface=rest and the ns name.
 *  - MCP delete_namespace does the same with surface=mcp.
 *  - a delete WITH reason/requestedBy includes both in the line (REST + MCP).
 *  - a failed delete (404, no mapping) STILL logs — no silent refusal paths.
 *
 * Isolation: same shape as namespaces-delete-dbgap032.test.ts — the suite runs
 * against the REAL server / real tools under the test-suite temp root
 * (DUCKBRAIN_NAMESPACES_PATH + DUCKBRAIN_CONFIG_PATH set by src/test-setup.ts).
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
import { createServer, Server } from "http";
import path from "path";
import { createHttpServer } from "../../cli/http";
import { deleteNamespaceTool } from "../../mcp/tools/namespace";
import { createNamespaceTool } from "../../mcp/tools/namespace";
import { lifecycleLogPath } from "../../namespaces/lifecycle";

const CONFIG_PATH =
  process.env.DUCKBRAIN_CONFIG_PATH ||
  path.join(process.cwd(), "duckbrain.config.json");
const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;

function readLifecycleLines(): Record<string, unknown>[] {
  const p = lifecycleLogPath(NS_ROOT);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function linesFor(name: string): Record<string, unknown>[] {
  return readLifecycleLines().filter((l) => l.ns === name);
}

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
        // Node treats DELETE as bodyless — explicit Content-Length is needed
        // so express.json() sees the body (same as the DB-GAP-032 helper).
        ...(payload !== undefined
          ? { "Content-Length": Buffer.byteLength(payload) }
          : {}),
      },
    };
    const req = http.request(options, (res: any) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk.toString()));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

let configSnapshot: string;

beforeAll(async () => {
  const app = createHttpServer({ authType: "none" });
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
  if (configSnapshot) {
    fs.writeFileSync(CONFIG_PATH, configSnapshot, "utf-8");
  } else if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
  }
});

describe("DF-0923-02: REST DELETE writes a lifecycle audit line", () => {
  it("appends surface=rest + ns name to lifecycle.log on success", async () => {
    const name = "df092302-rest";
    await httpRequest("POST", "/api/namespaces", { name, setDefault: false });
    expect(fs.existsSync(path.join(NS_ROOT, name))).toBe(true);

    const { status } = await httpRequest("DELETE", `/api/namespaces/${name}`, {
      confirm: true,
    });
    expect(status).toBe(200);

    const lines = linesFor(name);
    expect(lines.length).toBe(1);
    expect(lines[0].surface).toBe("rest");
    expect(lines[0].op).toBe("delete-from-disk");
    expect(lines[0].success).toBe(true);
    // Operator-default line when the caller omits who/why.
    expect(lines[0].requestedBy).toBe("operator");
  });

  it("includes reason + requestedBy from the request body", async () => {
    const name = "df092302-restwho";
    await httpRequest("POST", "/api/namespaces", { name, setDefault: false });

    const { status } = await httpRequest("DELETE", `/api/namespaces/${name}`, {
      confirm: true,
      requestedBy: "ticket-88",
      reason: "orphaned namespace cleanup",
    });
    expect(status).toBe(200);

    const lines = linesFor(name);
    expect(lines.length).toBe(1);
    expect(lines[0].requestedBy).toBe("ticket-88");
    expect(lines[0].reason).toBe("orphaned namespace cleanup");
  });

  it("logs even when the delete fails (404, no mapping)", async () => {
    const name = "df092302-rest404";
    const { status } = await httpRequest("DELETE", `/api/namespaces/${name}`, {
      confirm: true,
    });
    expect(status).toBe(404);

    const lines = linesFor(name);
    expect(lines.length).toBe(1);
    expect(lines[0].surface).toBe("rest");
    expect(lines[0].success).toBe(false);
  });
});

describe("DF-0923-02: MCP delete_namespace writes a lifecycle audit line", () => {
  it("appends surface=mcp + ns name to lifecycle.log on success", async () => {
    const name = "df092302-mcp";
    const created = await createNamespaceTool({ name, setDefault: false });
    expect(created.success).toBe(true);

    const result = await deleteNamespaceTool({ name, confirm: true });
    expect(result.success).toBe(true);

    const lines = linesFor(name);
    expect(lines.length).toBe(1);
    expect(lines[0].surface).toBe("mcp");
    expect(lines[0].op).toBe("delete-from-disk");
    expect(lines[0].success).toBe(true);
    expect(lines[0].requestedBy).toBe("operator");
  });

  it("includes reason + requestedBy from the tool input", async () => {
    const name = "df092302-mcpwho";
    await createNamespaceTool({ name, setDefault: false });

    const result = await deleteNamespaceTool({
      name,
      confirm: true,
      requestedBy: "agent-session-42",
      reason: "expired tenant namespace",
    });
    expect(result.success).toBe(true);

    const lines = linesFor(name);
    expect(lines.length).toBe(1);
    expect(lines[0].requestedBy).toBe("agent-session-42");
    expect(lines[0].reason).toBe("expired tenant namespace");
  });

  it("logs refusals too (not-found delete)", async () => {
    const result = await deleteNamespaceTool({
      name: "df092302-mcp404",
      confirm: true,
    });
    expect(result.success).toBe(false);

    const lines = linesFor("df092302-mcp404");
    expect(lines.length).toBe(1);
    expect(lines[0].surface).toBe("mcp");
    expect(lines[0].success).toBe(false);
  });
});
