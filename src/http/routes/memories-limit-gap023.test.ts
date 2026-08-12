/**
 * GAP-023 Regression Tests: negative/non-numeric ?limit= is rejected with
 * HTTP 400 VALIDATION_ERROR; positive limits are capped.
 *
 * Root cause: the route parsed req.query.limit with parseInt() without
 * validating, so limit=-1 flowed into recallTool as 0, and because a falsy
 * 0 produced NO LIMIT clause in src/duckdb/queries.ts, the SQL returned
 * every row — a DoS vector (198,727 memories in a single ~108MB response).
 *
 * These tests exercise the route's query parser against a real HTTP server;
 * validation happens before recallTool is reached, so no seed data is
 * needed.
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

function httpRequest(method: string, path: string): Promise<HttpResponse> {
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
    req.end();
  });
}

describe("GAP-023: limit validation — GET /api/memories", () => {
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

  it("rejects limit=-1 with 400 VALIDATION_ERROR (DoS vector)", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=-1",
    );

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("rejects limit=-5 with 400 VALIDATION_ERROR", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=-5",
    );

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("rejects non-numeric limit (limit=abc) with 400 VALIDATION_ERROR", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=abc",
    );

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("caps oversized positive limits at MAX_LIMIT (1000)", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=100000",
    );

    expect(status).toBe(200);
    expect(body.limit).toBe(1000);
  });

  it("keeps the default limit of 50 when the parameter is absent", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default",
    );

    expect(status).toBe(200);
    expect(body.limit).toBe(50);
  });
});
