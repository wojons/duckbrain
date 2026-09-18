import fs from "fs";
import http, { type Server } from "http";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberTool } from "../mcp/tools/remember";
import {
  SERVER_AUDIT_MAX_BYTES,
  createDenialAuditor,
  flushDenialAuditsForTests,
  readAuditRows,
  readServerDenials,
} from "../serialization/audit";
import { streamWithSqlRowCap } from "../auth/roles";
import { hashApiKey } from "../auth/storeSchema";
import { drainAsyncCommits } from "../git/autocommit";
import { createHttpServer } from "./http";

vi.mock("../mcp/tools/remember", async () => {
  const actual = await vi.importActual<typeof import("../mcp/tools/remember")>(
    "../mcp/tools/remember",
  );
  return {
    ...actual,
    rememberTool: vi.fn(async (input: { key: string; namespace: string }) => ({
      success: true,
      id: "00000000-0000-4000-8000-000000000004",
      key: input.key,
      author: "test@duckbrain.local",
      namespace: input.namespace,
    })),
  };
});

interface Reply {
  status: number;
  body: any;
}

async function start(options: Parameters<typeof createHttpServer>[0]) {
  const app = createHttpServer(options);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("no TCP address");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function request(
  base: string,
  method: string,
  urlPath: string,
  key?: string,
  body?: unknown,
): Promise<Reply> {
  const response = await fetch(base + urlPath, {
    method,
    headers: {
      Host: "localhost",
      ...(key ? { "X-API-Key": key } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw last;
}

describe("SUPA-4 HTTP auth integration", () => {
  let dir: string;
  let namespacesPath: string;
  let authFile: string;
  const analystKey = "f".repeat(32);
  const writerKey = "1".repeat(32);
  const scopedSearchKey = "2".repeat(32);
  const servers: Server[] = [];

  beforeEach(() => {
    vi.mocked(rememberTool).mockClear();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-supa4-http-"));
    namespacesPath = path.join(dir, "namespaces");
    authFile = path.join(dir, "auth.json");
    fs.mkdirSync(path.join(namespacesPath, "alpha"), { recursive: true });
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        apiKeys: [
          {
            keyHash: hashApiKey(analystKey),
            name: "analyst",
            roles: ["analyst"],
            namespaces: ["alpha"],
          },
          {
            keyHash: hashApiKey(writerKey),
            name: "writer",
            roles: ["writer"],
            namespaces: ["alpha"],
          },
          {
            keyHash: hashApiKey(scopedSearchKey),
            name: "scoped-search",
            roles: ["writer"],
            namespaces: ["default"],
          },
        ],
      }),
    );
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
    await flushDenialAuditsForTests();
    // OPS-006: commits run off the event loop, so a namespace may still have a
    // git child working inside it. Let that settle before deleting the tree —
    // removing a namespace mid-commit leaves .git/ non-empty (ENOTEMPTY).
    await drainAsyncCommits();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("role-denied write returns 403 and appends namespace denial audit", async () => {
    const { server, base } = await start({
      authType: "apikey",
      authFile,
      namespacesPath,
    });
    servers.push(server);
    const reply = await request(
      base,
      "POST",
      "/api/memories?namespace=alpha",
      analystKey,
      { key: "/denied", domain: "raw_note", content: "no" },
    );
    expect(reply.status).toBe(403);
    expect(vi.mocked(rememberTool)).not.toHaveBeenCalled();
    await eventually(() =>
      expect(readAuditRows(namespacesPath, "alpha")).toContainEqual(
        expect.objectContaining({
          outcome: "denied",
          reason: "role",
          principal: "analyst",
          table: "memories",
        }),
      ),
    );
  });

  it("writer role reaches the existing memory write path", async () => {
    const { server, base } = await start({
      authType: "apikey",
      authFile,
      namespacesPath,
    });
    servers.push(server);
    const reply = await request(
      base,
      "POST",
      "/api/memories?namespace=alpha",
      writerKey,
      { key: "/allowed", domain: "raw_note", content: "yes" },
    );
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ key: "/allowed" });
  });

  it("SQL_ROW_CAP yields maxRows then audits sql_cap in the target namespace", async () => {
    const audit = createDenialAuditor(namespacesPath);
    const streamed: number[] = [];
    await expect(async () => {
      for await (const row of streamWithSqlRowCap(
        Array.from({ length: 100 }, (_, index) => index),
        10,
        () =>
          audit({
            ts: new Date().toISOString(),
            ns: "alpha",
            table: "query",
            op: "sql.read",
            principal: "analyst",
            outcome: "denied",
            reason: "sql_cap",
          }),
      )) {
        streamed.push(row);
      }
    }).rejects.toMatchObject({ code: "SQL_ROW_CAP" });
    expect(streamed).toHaveLength(10);
    await eventually(() =>
      expect(readAuditRows(namespacesPath, "alpha")).toContainEqual(
        expect.objectContaining({ reason: "sql_cap", op: "sql.read" }),
      ),
    );
  });

  it("bad credentials land in bounded server-level denial log", async () => {
    const { server, base } = await start({
      authType: "apikey",
      authFile,
      namespacesPath,
    });
    servers.push(server);
    expect((await request(base, "GET", "/stats", "wrong-key")).status).toBe(
      401,
    );
    await eventually(() => {
      const rows = readServerDenials(namespacesPath);
      expect(rows).toContainEqual(
        expect.objectContaining({
          op: "authenticate",
          outcome: "denied",
          reason: "role",
        }),
      );
    });
  });

  it("cross-namespace search denial is audited before any namespace is resolved", async () => {
    const { server, base } = await start({
      authType: "apikey",
      authFile,
      namespacesPath,
    });
    servers.push(server);
    const reply = await request(
      base,
      "GET",
      "/api/memories?allNamespaces=true",
      scopedSearchKey,
    );
    expect(reply.status).toBe(403);
    await eventually(() =>
      expect(readServerDenials(namespacesPath)).toContainEqual(
        expect.objectContaining({
          outcome: "denied",
          reason: "namespace_scope",
          principal: "scoped-search",
        }),
      ),
    );
  });

  it("server denial log rotates before an append would exceed 10 MiB", async () => {
    const auditDir = path.join(namespacesPath, ".duckbrain-audit");
    const denialFile = path.join(auditDir, "denials.jsonl");
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(denialFile, Buffer.alloc(SERVER_AUDIT_MAX_BYTES - 1, 32));
    const audit = createDenialAuditor(namespacesPath);
    await audit({
      ts: new Date().toISOString(),
      op: "authenticate",
      principal: null,
      outcome: "denied",
      reason: "role",
    });
    expect(fs.statSync(`${denialFile}.1`).size).toBe(
      SERVER_AUDIT_MAX_BYTES - 1,
    );
    expect(fs.statSync(denialFile).size).toBeLessThanOrEqual(
      SERVER_AUDIT_MAX_BYTES,
    );
    expect(readServerDenials(namespacesPath)).toHaveLength(1);
  });

  it("rate limiting still runs before credential authentication", async () => {
    const { server, base } = await start({
      authType: "apikey",
      authFile,
      namespacesPath,
      rateLimit: 1,
    });
    servers.push(server);
    expect((await request(base, "GET", "/stats", "wrong-1")).status).toBe(401);
    expect((await request(base, "GET", "/stats", "wrong-2")).status).toBe(429);
  });
});
