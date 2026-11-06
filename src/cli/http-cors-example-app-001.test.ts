/**
 * EXAMPLE-APP-001 — a browser app on another origin must be able to USE the
 * generic table→REST surface.
 *
 * The evidence that started this row (probe 2026-11-05, real scratch daemon):
 * `OPTIONS /api/ns/taskboard/tables/cards` with an Origin and
 * `Access-Control-Request-Headers: x-api-key,content-type` answered
 * **401 Unauthorized with no Access-Control-* headers**. The CORS middleware
 * existed but was mounted AFTER authMiddleware, so the preflight — which never
 * carries credentials — was refused before it could be answered, and every
 * follow-up request died in the browser. Two more blockers sat in the header
 * set itself: Allow-Methods omitted PATCH (the table layer's update verb) and
 * Allow-Headers omitted X-API-Key (the only credential an apikey daemon takes).
 *
 * These tests pin the fixed contract against a REAL listening server (the
 * behaviour under test is mount order, which a hand-built app cannot prove):
 *   1. an uncredentialed preflight is answered (204) and authorises X-API-Key
 *      and PATCH,
 *   2. the preflight did not authenticate anything — the same request without
 *      a key still gets 401/403,
 *   3. refusals (401) carry the CORS headers a browser needs to READ them,
 *   4. liveness reads carry them too, and
 *   5. the write-accounting headers are exposed, not merely sent.
 */
import fs from "fs";
import http, { type Server } from "http";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpServer } from "./http";

const ORIGIN = "http://127.0.0.1:8787";
const ADMIN_KEY = "cors-test-admin-key";
const NS = "taskboard";

let server: Server;
let base: string;
let namespacesPath: string;
const savedNsPath = process.env.DUCKBRAIN_NAMESPACES_PATH;

async function send(
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; body: string }> {
  const response = await fetch(base + urlPath, { method, headers });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  };
}

function preflight(urlPath: string, requestHeaders: string, method: string) {
  return send("OPTIONS", urlPath, {
    Origin: ORIGIN,
    "Access-Control-Request-Method": method,
    "Access-Control-Request-Headers": requestHeaders,
    Host: "localhost",
  });
}

beforeAll(async () => {
  namespacesPath = fs.mkdtempSync(path.join(os.tmpdir(), "cors-example-app-"));
  process.env.DUCKBRAIN_NAMESPACES_PATH = namespacesPath;
  const nsDir = path.join(namespacesPath, NS);
  fs.mkdirSync(nsDir, { recursive: true });
  // One declared table so the cross-origin round trip is a real CRUD call and
  // not just a grant check.
  fs.writeFileSync(
    path.join(nsDir, "schema.json"),
    JSON.stringify({
      schemaVersion: 1,
      tables: {
        cards: {
          schemaVersion: 1,
          storage: { path: "tables/cards/current.jsonl" },
          rowShape: "object",
          keyColumns: ["id"],
          columns: [
            { name: "id", type: "string", nullable: false },
            { name: "title", type: "string", nullable: true },
          ],
        },
      },
      views: {},
    }),
  );
  const app = createHttpServer({
    authConfig: {
      type: "apikey",
      apiKeys: [
        {
          key: ADMIN_KEY,
          name: "taskboard-admin",
          roles: ["admin"],
          namespaces: [NS],
        },
      ],
    },
    namespacesPath,
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP addr");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (savedNsPath === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  else process.env.DUCKBRAIN_NAMESPACES_PATH = savedNsPath;
  fs.rmSync(namespacesPath, { recursive: true, force: true });
});

describe("EXAMPLE-APP-001 CORS: a cross-origin app can drive the table API", () => {
  it("answers the uncredentialed preflight for a PATCH with the API-key header", async () => {
    const reply = await preflight(
      `/api/ns/${NS}/tables/cards?pk=eq.k1`,
      "x-api-key,content-type",
      "PATCH",
    );

    // The falsifier: before the fix this was 401 (auth answered the preflight).
    expect(reply.status).not.toBe(401);
    expect(reply.status).toBe(204);
    expect(reply.headers.get("access-control-allow-origin")).toBe("*");

    const methods = (reply.headers.get("access-control-allow-methods") ?? "")
      .toLowerCase();
    for (const verb of ["get", "post", "patch", "delete", "options"]) {
      expect(methods).toContain(verb);
    }

    const allowed = (reply.headers.get("access-control-allow-headers") ?? "")
      .toLowerCase();
    expect(allowed).toContain("x-api-key");
    expect(allowed).toContain("content-type");
  });

  it("does not authenticate anything: the same write without a key is still refused", async () => {
    const reply = await send("POST", `/api/ns/${NS}/tables/cards`, {
      Origin: ORIGIN,
      "Content-Type": "application/json",
      Host: "localhost",
    });
    expect([401, 403]).toContain(reply.status);
    expect(reply.status).toBe(401);
  });

  it("carries CORS on a 401 so the browser can read the refusal", async () => {
    const reply = await send("GET", `/api/ns/${NS}/tables/cards`, {
      Origin: ORIGIN,
      Host: "localhost",
    });
    expect(reply.status).toBe(401);
    expect(reply.headers.get("access-control-allow-origin")).toBe("*");
    expect(JSON.parse(reply.body).error).toMatch(/Unauthorized/);
  });

  it("carries CORS on a liveness read (the app's health badge)", async () => {
    const reply = await send("GET", "/health", {
      Origin: ORIGIN,
      Host: "localhost",
    });
    // GAP-030: /health is 200 while healthy and 503 while degraded, and a host
    // with no reachable embedding provider is a LEGITIMATE degraded host (a CI
    // runner reaches neither LM Studio nor Ollama). This test owns CORS on the
    // liveness read, not host health: accept both statuses and prove the header
    // on whichever path the host actually took — the degraded path is the one
    // that used to go unproven, and it is the path a real runner walks.
    expect([200, 503]).toContain(reply.status);
    expect(reply.headers.get("access-control-allow-origin")).toBe("*");
    expect(reply.headers.get("content-type") ?? "").toContain("application/json");
    if (reply.status === 503) {
      // A browser must be able to READ the degradation, not just the OK.
      expect(JSON.parse(reply.body).status).toBe("degraded");
    }
  });

  it("exposes the accounting headers the app displays", async () => {
    const reply = await preflight(`/api/ns/${NS}/tables/cards`, "x-api-key", "GET");
    const exposed = (
      reply.headers.get("access-control-expose-headers") ?? ""
    ).toLowerCase();
    expect(exposed).toContain("x-durability");
    expect(exposed).toContain("x-total-count");
  });

  it("still serves an authenticated write+read from the cross-origin caller", async () => {
    const write = await fetch(`${base}/api/ns/${NS}/tables/cards`, {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "X-API-Key": ADMIN_KEY,
        "Content-Type": "application/json",
        Host: "localhost",
      },
      body: JSON.stringify({ id: "k1", title: "cross-origin card" }),
    });
    expect(write.status).toBe(201);
    expect(write.headers.get("access-control-allow-origin")).toBe("*");
    expect(write.headers.get("x-durability")).toBeTruthy();

    const reply = await send("GET", `/api/ns/${NS}/tables/cards?order=id.asc`, {
      Origin: ORIGIN,
      "X-API-Key": ADMIN_KEY,
      Host: "localhost",
    });
    expect(reply.status).toBe(200);
    expect(reply.headers.get("access-control-allow-origin")).toBe("*");
    expect(JSON.parse(reply.body)).toEqual([
      expect.objectContaining({ id: "k1", title: "cross-origin card" }),
    ]);
  });
});
