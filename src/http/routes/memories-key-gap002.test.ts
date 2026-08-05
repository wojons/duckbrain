/**
 * GAP-002 Regression Tests: GET /api/memories/key/<key path> returned 500
 *
 * Root cause: Express 5 uses path-to-regexp v8, where a named wildcard
 * (*key) captures an ARRAY of path segments. The handler treated
 * req.params.key as a string (`key.startsWith` → TypeError on the array),
 * which fell through to the generic error handler as 500 INTERNAL_ERROR.
 * ID-based lookup (GET /api/memories/:id) was unaffected.
 *
 * These tests exercise the full in-process HTTP pipeline: POST a memory,
 * then retrieve it by single- and multi-segment key path, plus 404 for a
 * missing key.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHttpServer } from "../../cli/http";
import { createServer, Server } from "http";

let server: Server;
let port: number;

interface HttpResponse {
  status: number;
  body: any;
}

function httpRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const options: any = {
      hostname: "127.0.0.1",
      port,
      path,
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
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe("GAP-002: GET /api/memories/key/:key returns memory or 404", () => {
  const stamp = Date.now();
  const multiKey = `/gap002/multi/segment/${stamp}`;
  const singleKey = `/gap002-single-${stamp}`;

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

  it("Step 1: POST creates memories with multi-segment and single-segment keys", async () => {
    const multi = await httpRequest("POST", "/api/memories", {
      key: multiKey,
      domain: "raw_note",
      content: "GAP-002 multi-segment key memory",
      attributes: { test: "gap002" },
    });
    expect(multi.status).toBe(201);
    expect(multi.body.key).toBe(multiKey);

    const single = await httpRequest("POST", "/api/memories", {
      key: singleKey,
      domain: "raw_note",
      content: "GAP-002 single-segment key memory",
      attributes: { test: "gap002" },
    });
    expect(single.status).toBe(201);
    expect(single.body.key).toBe(singleKey);
  });

  it("Step 2: GET /api/memories/key/<multi/segment/path> returns 200 with memory JSON", async () => {
    // Key path without leading slash — route normalization prepends it.
    const pathWithoutLeadingSlash = multiKey.slice(1);
    const { status, body } = await httpRequest(
      "GET",
      `/api/memories/key/${pathWithoutLeadingSlash}`,
    );

    expect(status).toBe(200);
    expect(body.key).toBe(multiKey);
    expect(body.content).toBe("GAP-002 multi-segment key memory");
    expect(body.domain).toBe("raw_note");
    expect(body.id).toBeDefined();
  });

  it("Step 3: GET /api/memories/key/<single> returns 200", async () => {
    const { status, body } = await httpRequest(
      "GET",
      `/api/memories/key/${singleKey.slice(1)}`,
    );

    expect(status).toBe(200);
    expect(body.key).toBe(singleKey);
    expect(body.content).toBe("GAP-002 single-segment key memory");
  });

  it("Step 4: GET /api/memories/key/<missing> returns 404", async () => {
    const { status, body } = await httpRequest(
      "GET",
      `/api/memories/key/definitely/missing/key/${stamp}`,
    );

    expect(status).toBe(404);
    expect(body.error).toBeDefined();
  });

  it("Step 5: key route does not shadow /:id lookups", async () => {
    // A plain single segment still resolves via the wildcard key route and
    // 404s for unknown keys — while /:id behaviour is covered by BUG-027.
    const { status } = await httpRequest(
      "GET",
      `/api/memories/nonexistent-id-${stamp}`,
    );
    expect(status).toBe(404);
  });
});
