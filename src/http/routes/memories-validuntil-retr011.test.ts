/**
 * RETR-011 Regression Tests: fact versioning (valid_from/valid_until) via
 * the HTTP API.
 *
 * - GET /api/memories (default = current view) excludes rows whose
 *   valid_until is in the past (expired) and rows whose valid_from is in
 *   the future (not yet valid); the total matches the returned window
 * - GET /api/memories?historical=true includes ALL rows and echoes the
 *   validity fields
 * - POST /api/memories persists valid_from/valid_until (201 echo + the
 *   stored row obeys the recall views)
 * - POST without validity fields keeps the legacy always-current behavior
 *
 * Follows the httpRequest + seeded-namespace pattern from
 * memories-timerange-retr003.test.ts (route → recallTool → DuckDB, real
 * namespace, no mocks).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHttpServer } from "../../cli/http";
import { createServer, Server } from "http";
import fs from "fs";
import path from "path";

let server: Server;
let port: number;

interface HttpResponse {
  status: number;
  body: any;
}

function httpRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const options: any = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        Host: "localhost",
        "Content-Type": "application/json",
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
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const NS = path.join(NS_ROOT, "default");
const PARTITION = path.join(NS, "event", "2026-08");
const JSONL = path.join(PARTITION, "current.jsonl");
const MANIFEST = path.join(NS, "manifest.json");

const REPO_CONFIG = path.join(process.cwd(), "duckbrain.config.json");

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

function seedMemory(i: number) {
  const validity =
    i === 2
      ? { valid_until: PAST } // expired
      : i === 3
        ? { valid_from: FUTURE } // not yet valid
        : i === 4
          ? { valid_until: FUTURE } // open-ended, currently valid
          : i === 5
            ? { valid_from: PAST, valid_until: FUTURE } // full window
            : {}; // control — no validity fields
  return {
    id: crypto.randomUUID(),
    key: `/validity/${i}`,
    domain: "event",
    timestamp: `2026-08-${String(10 + i).padStart(2, "0")}T12:00:00.000Z`,
    author: "test@example.com",
    action: "add",
    embedding_text: `Validity seed memory ${i}`,
    attributes: {},
    ...validity,
  };
}

const SEEDED = 5;

describe("RETR-011: fact versioning — GET /api/memories", () => {
  let configBefore: string;

  beforeAll(async () => {
    configBefore = fs.readFileSync(REPO_CONFIG, "utf-8");

    fs.mkdirSync(PARTITION, { recursive: true });
    const lines: string[] = [];
    for (let i = 1; i <= SEEDED; i++) {
      lines.push(JSON.stringify(seedMemory(i)));
    }
    fs.writeFileSync(JSONL, lines.join("\n") + "\n");
    fs.writeFileSync(
      MANIFEST,
      JSON.stringify({
        partitions: ["event/2026-08"],
        lastUpdated: new Date().toISOString(),
      }),
    );

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
    expect(fs.readFileSync(REPO_CONFIG, "utf-8")).toBe(configBefore);
    fs.rmSync(PARTITION, { recursive: true, force: true });
    fs.rmSync(MANIFEST, { force: true });
  });

  it("current view excludes expired and not-yet-valid rows, total matches", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=50",
    );

    expect(status).toBe(200);
    // i=1 (control) + i=4 (open) + i=5 (window) — i=2 expired, i=3 future.
    const keys = body.items.map((m: any) => m.key).sort();
    expect(keys).toEqual(["/validity/1", "/validity/4", "/validity/5"]);
    expect(body.total).toBe(3);
    expect(body.hasMore).toBe(false);
    // The response echoes the validity fields on the rows that have them.
    const byKey = new Map<string, any>(body.items.map((m: any) => [m.key, m]));
    expect(byKey.get("/validity/5").valid_from).toBe(PAST);
    expect(byKey.get("/validity/5").valid_until).toBe(FUTURE);
    expect(byKey.get("/validity/1")).not.toHaveProperty("valid_from");
    expect(byKey.get("/validity/1")).not.toHaveProperty("valid_until");
  });

  it("historical=true includes ALL rows, expired facts included", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=50&historical=true",
    );

    expect(status).toBe(200);
    const keys = body.items.map((m: any) => m.key).sort();
    expect(keys).toEqual([
      "/validity/1",
      "/validity/2",
      "/validity/3",
      "/validity/4",
      "/validity/5",
    ]);
    expect(body.total).toBe(5);
    const byKey = new Map<string, any>(body.items.map((m: any) => [m.key, m]));
    expect(byKey.get("/validity/2").valid_until).toBe(PAST);
    expect(byKey.get("/validity/3").valid_from).toBe(FUTURE);
  });

  it("explicit historical=false behaves like the default current view", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=50&historical=false",
    );

    expect(status).toBe(200);
    expect(body.total).toBe(3);
  });
});

describe("RETR-011: fact versioning — POST /api/memories", () => {
  let configBefore: string;

  beforeAll(async () => {
    configBefore = fs.readFileSync(REPO_CONFIG, "utf-8");

    fs.mkdirSync(PARTITION, { recursive: true });
    const lines: string[] = [];
    for (let i = 1; i <= SEEDED; i++) {
      lines.push(JSON.stringify(seedMemory(i)));
    }
    fs.writeFileSync(JSONL, lines.join("\n") + "\n");
    fs.writeFileSync(
      MANIFEST,
      JSON.stringify({
        partitions: ["event/2026-08"],
        lastUpdated: new Date().toISOString(),
      }),
    );

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
    expect(fs.readFileSync(REPO_CONFIG, "utf-8")).toBe(configBefore);
    fs.rmSync(PARTITION, { recursive: true, force: true });
    fs.rmSync(MANIFEST, { force: true });
  });

  it("persists valid_until and the row obeys the recall views", async () => {
    const { status, body } = await httpRequest("POST", "/api/memories", {
      key: "/validity/http-expired",
      domain: "event",
      content: "HTTP write with an expiry",
      valid_until: PAST,
    });

    expect(status).toBe(201);
    expect(body.valid_until).toBe(PAST);

    // Current view: the expired write is excluded.
    const current = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=50",
    );
    const currentKeys = current.body.items.map((m: any) => m.key);
    expect(currentKeys).not.toContain("/validity/http-expired");

    // Historical view: it IS visible, with valid_until intact.
    const historical = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=50&historical=true",
    );
    const hit = historical.body.items.find(
      (m: any) => m.key === "/validity/http-expired",
    );
    expect(hit).toBeDefined();
    expect(hit.valid_until).toBe(PAST);
  });

  it("a write without validity fields stays in the current view (no regression)", async () => {
    const { status, body } = await httpRequest("POST", "/api/memories", {
      key: "/validity/http-plain",
      domain: "event",
      content: "HTTP write without a window",
    });

    expect(status).toBe(201);
    expect(body).not.toHaveProperty("valid_until");
    expect(body).not.toHaveProperty("valid_from");

    const current = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=50",
    );
    const currentKeys = current.body.items.map((m: any) => m.key);
    expect(currentKeys).toContain("/validity/http-plain");
  });

  it("persists valid_from and echoes it in the 201 response", async () => {
    const { status, body } = await httpRequest("POST", "/api/memories", {
      key: "/validity/http-future",
      domain: "event",
      content: "HTTP write starting later",
      valid_from: FUTURE,
    });

    expect(status).toBe(201);
    expect(body.valid_from).toBe(FUTURE);

    // Not yet valid → excluded from the current view, visible historically.
    const current = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=50",
    );
    expect(current.body.items.map((m: any) => m.key)).not.toContain(
      "/validity/http-future",
    );
    const historical = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=50&historical=true",
    );
    const hit = historical.body.items.find(
      (m: any) => m.key === "/validity/http-future",
    );
    expect(hit).toBeDefined();
    expect(hit.valid_from).toBe(FUTURE);
  });
});
