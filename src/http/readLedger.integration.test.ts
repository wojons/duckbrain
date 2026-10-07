/**
 * OBS-DUCKBRAIN-001 integration tests: read ledger wired into the real
 * createHttpServer() app.
 *
 * Proves the full loop end to end:
 *  1. GET requests through the app produce ledger rows;
 *  2. GET /api/reads over a window INCLUDING those requests reports them —
 *     and over a purely HISTORICAL window (older than process uptime, seeded
 *     directly into the durable ledger) they are counted too, which is the
 *     board row's acceptance criterion;
 *  3. write paths (POST/PUT/DELETE), /health, /stats, unknown routes and the
 *     /api/reads surface itself produce NO rows;
 *  4. auth failures on read paths ARE recorded (status code visible);
 *  5. normalized rows never leak the real key value.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHttpServer } from "../cli/http";
import { createServer, Server } from "http";
import fs from "fs";
import os from "os";
import path from "path";
import {
  READS_DIR,
  READS_FILE,
  flushReadLedgerForTests,
} from "./readLedger";

let server: Server;
let port: number;
let scratchDir: string;
let oldNamespacesPath: string | undefined;

interface HttpResponse {
  status: number;
  body: any;
  text: string;
}

function httpRequest(
  method: string,
  p: string,
  body?: unknown,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const options: any = {
      hostname: "127.0.0.1",
      port,
      path: p,
      method,
      headers: {
        Host: "localhost",
        "Content-Type": "application/json",
      },
    };
    const req = http.request(options, (res: any) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), text: data });
        } catch {
          resolve({ status: res.statusCode, body: data, text: data });
        }
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Await the ledger tail AND one macrotask turn so "finish" handlers ran. */
async function settle(): Promise<void> {
  await flushReadLedgerForTests();
  await new Promise((resolve) => setImmediate(resolve));
}

describe("OBS-DUCKBRAIN-001: read ledger over the real HTTP app", () => {
  beforeAll(async () => {
    scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-obs-readledger-"),
    );
    oldNamespacesPath = process.env.DUCKBRAIN_NAMESPACES_PATH;
    process.env.DUCKBRAIN_NAMESPACES_PATH = scratchDir;

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

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (oldNamespacesPath === undefined) {
      delete process.env.DUCKBRAIN_NAMESPACES_PATH;
    } else {
      process.env.DUCKBRAIN_NAMESPACES_PATH = oldNamespacesPath;
    }
    if (scratchDir) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("records GET reads and answers a window query that includes them", async () => {
    const before = new Date(Date.now() - 60_000).toISOString();
    await httpRequest("GET", "/api/memories");
    await httpRequest("GET", "/api/keys?prefix=/alpha");
    await httpRequest("GET", "/activity");
    await settle();
    const after = new Date(Date.now() + 60_000).toISOString();

    const { status, body } = await httpRequest(
      "GET",
      `/api/reads?from=${encodeURIComponent(before)}&to=${encodeURIComponent(after)}`,
    );
    expect(status).toBe(200);
    expect(body.total).toBe(3);
    const routes = new Map(body.routes.map((r: any) => [r.route, r.count]));
    expect(routes.get("GET /api/memories")).toBe(1);
    expect(routes.get("GET /api/keys")).toBe(1);
    expect(routes.get("GET /activity")).toBe(1);
    // the query itself must not have been recorded
    expect(routes.has("GET /api/reads")).toBe(false);
  });

  it("acceptance: a query over a window OLDER than process uptime counts seeded history", async () => {
    // Seed the DURABLE ledger directly with rows dated long before this
    // process started (uptime is seconds old; the window is 2026-01).
    const dir = path.join(scratchDir, READS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const historical = [
      {
        ts: "2026-01-15T08:00:00.000Z",
        route: "GET /api/memories/key/:key",
        method: "GET",
        ns: null,
        status: 200,
        dur_ms: 21,
      },
      {
        ts: "2026-01-15T09:00:00.000Z",
        route: "GET /api/memories/key/:key",
        method: "GET",
        ns: "research",
        status: 404,
        dur_ms: 3,
      },
      {
        ts: "2026-02-20T12:00:00.000Z",
        route: "GET /api/namespaces",
        method: "GET",
        ns: null,
        status: 200,
        dur_ms: 1,
      },
    ];
    fs.writeFileSync(
      path.join(dir, READS_FILE),
      historical.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf-8",
    );

    const { status, body } = await httpRequest(
      "GET",
      "/api/reads?from=2026-01-01T00:00:00.000Z&to=2026-01-31T00:00:00.000Z",
    );
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    const route = body.routes.find((r: any) => r.route === "GET /api/memories/key/:key");
    expect(route.count).toBe(2);
    expect(route.statuses).toEqual({ "200": 1, "404": 1 });

    // …and the route filter narrows the same historical window.
    const filtered = await httpRequest(
      "GET",
      `/api/reads?from=2026-01-01T00:00:00.000Z&to=2026-01-31T00:00:00.000Z&route=${encodeURIComponent("GET /api/namespaces")}`,
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.total).toBe(0);
  });

  it("write paths and non-read routes produce NO rows", async () => {
    // POST /api/memories with a deliberately invalid body — the write REFUSES
    // (400) and must still not be recorded as a read. DELETE on a read path
    // is not a registered route (405 from Express 5's method mismatch).
    const post = await httpRequest("POST", "/api/memories", {});
    expect(post.status).toBe(400);
    const del = await httpRequest("DELETE", "/api/memories");
    // Express 5 answers the method mismatch 404 (this router's chain) —
    // either way it is NOT a GET/HEAD and must produce no row.
    expect([404, 405]).toContain(del.status);

    const health = await httpRequest("GET", "/health");
    expect([200, 503]).toContain(health.status);
    const stats = await httpRequest("GET", "/stats");
    expect(stats.status).toBe(200);
    const unknown = await httpRequest("GET", "/api/does-not-exist");
    expect(unknown.status).toBe(404);
    const compaction = await httpRequest("GET", "/api/compaction");
    expect([200, 404]).toContain(compaction.status);
    const readsQuery = await httpRequest("GET", "/api/reads");
    expect(readsQuery.status).toBe(200);

    await settle();

    // Snapshot the ledger BEFORE (already established) and assert the whole
    // non-read exercise added exactly zero rows.
    const before = (await httpRequest("GET", "/api/reads")).body.total;
    const post2 = await httpRequest("POST", "/api/memories", {});
    expect(post2.status).toBe(400);
    await httpRequest("GET", "/health");
    await httpRequest("GET", "/stats");
    await httpRequest("GET", "/api/unknown");
    await httpRequest("GET", "/api/reads");
    await settle();
    const after = (await httpRequest("GET", "/api/reads")).body.total;
    expect(after).toBe(before);
  });

  it("auth failures on a read path are recorded with their 401 status", async () => {
    await httpRequest("GET", "/api/memories");
    await settle();
    const before = (await httpRequest("GET", "/api/reads")).body.total;

    // This app is auth=none, so drive the auth-failure path through an
    // apikey app of our own: a VALID store (one writer token) so the server
    // boots, then a request with a WRONG key → authenticate → 401.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-obs-auth-"));
    const authFile = path.join(dir, "auth.json");
    const { hashApiKey } = await import("../auth/storeSchema.js");
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        apiKeys: [
          {
            keyHash: hashApiKey("9".repeat(32)),
            name: "ledger-test-writer",
            roles: ["writer"],
            namespaces: ["default"],
          },
        ],
      }),
    );
    const { createHttpServer: createAuthedServer } = await import(
      "../cli/http.js"
    );
    const authedApp = createAuthedServer({
      authType: "apikey",
      authFile,
      namespacesPath: scratchDir,
    });
    const authedServer = createServer(authedApp);
    await new Promise<void>((resolve) => authedServer.listen(0, "127.0.0.1", resolve));
    const authedPort = (authedServer.address() as any).port;
    try {
      const origPort = port;
      port = authedPort;
      const denied = await httpRequest("GET", "/api/memories");
      expect(denied.status).toBe(401);
      port = origPort;
    } finally {
      await new Promise<void>((resolve) => authedServer.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }

    await settle();
    const after = (await httpRequest("GET", "/api/reads")).body.total;
    expect(after).toBe(before + 1);
  });

  it("rows never contain the real key value even when the request carries one", async () => {
    const secret = "super-secret-key-OBS-001";
    await httpRequest("GET", `/api/memories/key/${secret}`);
    await settle();

    const raw = fs.readFileSync(
      path.join(scratchDir, READS_DIR, READS_FILE),
      "utf-8",
    );
    expect(raw).toContain("GET /api/memories/key/:key");
    expect(raw).not.toContain(secret);
  });
});
