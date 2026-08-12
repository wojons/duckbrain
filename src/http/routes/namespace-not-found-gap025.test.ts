/**
 * GAP-025 Regression Tests: a nonexistent namespace must surface as HTTP 404
 * NOT_FOUND, not HTTP 500 — callers and monitoring must be able to tell
 * "namespace not found" apart from a real server crash.
 *
 * Root cause: src/mcp/tools/recall.ts and list_keys.ts report a missing
 * namespace as the plain error string "Namespace '<ns>' does not exist",
 * which the routes wrap in ApiError(500). The errorHandler middleware now
 * remaps exactly that error to 404 NOT_FOUND; every other 500 is unchanged.
 *
 * Exercises all five route call sites against a real HTTP server:
 *   GET /api/memories            (memories.ts)
 *   GET /api/memories/key/:key   (memories.ts)
 *   GET /api/memories/:id        (memories.ts)
 *   GET /api/keys                (keys.ts)
 *   GET /api/keys/flat           (keys.ts)
 * plus the holds: valid-namespace 200 and limit-validation 400.
 *
 * Isolation: DUCKBRAIN_NAMESPACES_PATH points at this file's own temp root
 * (src/test-setup.ts, BUG-037) which contains only the empty "default" and
 * "test-ns" namespaces — "no-such-ns-xyz" never exists. No seed data needed.
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

const MISSING_NS = "no-such-ns-xyz";
const EXPECTED_MESSAGE = `Namespace '${MISSING_NS}' does not exist`;

describe("GAP-025: nonexistent namespace returns 404, not 500", () => {
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

  it("GET /api/memories?namespace=<missing>&limit=1 -> 404 NOT_FOUND with the namespace message", async () => {
    const { status, body } = await httpRequest(
      "GET",
      `/api/memories?namespace=${MISSING_NS}&limit=1`,
    );

    expect(status).toBe(404);
    expect(body.error).toBe(EXPECTED_MESSAGE);
    expect(body.code).toBe("NOT_FOUND");
  });

  it("GET /api/memories/key/:key?namespace=<missing> -> 404 NOT_FOUND", async () => {
    const { status, body } = await httpRequest(
      "GET",
      `/api/memories/key/some/key?namespace=${MISSING_NS}`,
    );

    expect(status).toBe(404);
    expect(body.error).toBe(EXPECTED_MESSAGE);
    expect(body.code).toBe("NOT_FOUND");
  });

  it("GET /api/memories/:id?namespace=<missing> -> 404 NOT_FOUND", async () => {
    const { status, body } = await httpRequest(
      "GET",
      `/api/memories/00000000-0000-0000-0000-000000000000?namespace=${MISSING_NS}`,
    );

    expect(status).toBe(404);
    expect(body.error).toBe(EXPECTED_MESSAGE);
    expect(body.code).toBe("NOT_FOUND");
  });

  it("GET /api/keys?namespace=<missing> -> 404 NOT_FOUND", async () => {
    const { status, body } = await httpRequest(
      "GET",
      `/api/keys?namespace=${MISSING_NS}`,
    );

    expect(status).toBe(404);
    expect(body.error).toBe(EXPECTED_MESSAGE);
    expect(body.code).toBe("NOT_FOUND");
  });

  it("GET /api/keys/flat?namespace=<missing> -> 404 NOT_FOUND", async () => {
    const { status, body } = await httpRequest(
      "GET",
      `/api/keys/flat?namespace=${MISSING_NS}`,
    );

    expect(status).toBe(404);
    expect(body.error).toBe(EXPECTED_MESSAGE);
    expect(body.code).toBe("NOT_FOUND");
  });

  it("valid namespace still returns 200 on GET /api/memories", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=1",
    );

    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.limit).toBe(1);
  });

  it("valid namespace still returns 200 on GET /api/keys", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/keys?namespace=default",
    );

    expect(status).toBe(200);
    expect(body.tree).toBeDefined();
  });

  it("limit validation still returns 400 VALIDATION_ERROR (GAP-023 holds)", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=-1",
    );

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
  });
});
