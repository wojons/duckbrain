/**
 * DF-2026-5 / DF-2026-6 regression tests: malformed CLIENT input on the
 * memory routes must be classified as 4xx, never as a 5xx.
 *
 * DF-2026-5 — DELETE /api/memories/:id with a non-UUID id used to answer
 * HTTP 500 `{"error":"Invalid input: Invalid UUID"}` with NO `code` field,
 * because the id reached forgetTool (whose zod schema is `z.string().uuid()`),
 * the parse failure came back as `{success:false, error:"Invalid input: ..."}`
 * with no `code`, and src/http/routes/memories.ts's throwWriteError() falls
 * through to 500 when `result.code` is absent. GET and PUT on the SAME
 * malformed id answer 404 NOT_FOUND, so the three sibling arms disagreed
 * about the same client mistake.
 *
 * DF-2026-6 — POST /api/memories with an empty body and no Content-Type used
 * to answer HTTP 500 INTERNAL_ERROR: express.json() only parses the
 * `application/json` content type, so with no Content-Type `req.body` stays
 * undefined (Express 5) and the route's first field read threw a TypeError
 * that the error handler reported as an internal fault. The sibling body
 * shapes (empty JSON `{}` and malformed JSON) already answered 400.
 *
 * Both fixes are wire-contract fixes, so the tests assert the WIRE: status
 * class, the documented `{error, code}` envelope, and that the control arms
 * (unknown-but-well-formed id, real id, `{}`, malformed JSON) keep their
 * statuses. Real HTTP against a real server (createHttpServer + the
 * per-worker scratch namespace root from src/test-setup.ts) — no mocks.
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

interface RequestShape {
  /** Send this value as a JSON body (sets Content-Type + Content-Length). */
  json?: unknown;
  /** Send this raw string body (Content-Type defaults to application/json). */
  raw?: string;
  /**
   * Explicit body Content-Type. `null` means "send the header-less request
   * a client that forgot the body would send" — no Content-Type, no
   * Content-Length, no body. That is the DF-2026-6 repro arm.
   */
  contentType?: string | null;
}

function httpRequest(
  method: string,
  path: string,
  shape: RequestShape = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const headers: Record<string, string | number> = { Host: "localhost" };
    let payload: string | undefined;

    if (shape.json !== undefined) {
      payload = JSON.stringify(shape.json);
      headers["Content-Type"] = shape.contentType ?? "application/json";
    } else if (shape.raw !== undefined) {
      payload = shape.raw;
      headers["Content-Type"] = shape.contentType ?? "application/json";
    }
    if (payload !== undefined) {
      headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res: any) => {
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
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** The test-setup.ts scratch root created for this worker process. */
const NS = "default";
const qs = `?namespace=${NS}`;
const MALFORMED_ID = "not-a-uuid";

/** A well-formed UUID that was never stored. */
const UNKNOWN_ID = "3f1f2a6e-7c4b-4a2d-9c8e-6b5d4f3a2b10";

function assertClientErrorEnvelope(res: HttpResponse): void {
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
  expect(typeof res.body.error).toBe("string");
  expect(res.body.error.length).toBeGreaterThan(0);
  // docs/api/http-api.md "Error Handling": every error carries a `code`.
  expect(typeof res.body.code).toBe("string");
  expect(res.body.code.length).toBeGreaterThan(0);
}

describe("DF-2026-5: malformed id classification on the by-id memory routes", () => {
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

    // Seed one memory so this namespace has a partition, matching the live
    // dogfood conditions the row was filed under. It matters for the
    // unknown-id control arm: on a namespace with NO partition at all,
    // forgetTool answers "No partitions found in namespace" (codeless, so
    // 500) before it ever looks the id up — a separate classification that
    // DF-2026-5 does not cover, and one this suite must not accidentally
    // grade as if it were the by-id answer.
    const seed = await httpRequest("POST", `/api/memories${qs}`, {
      json: {
        key: `/df-2026-5/seed-${Date.now()}`,
        domain: "raw_note",
        content: "DF-2026-5 partition seed — makes the by-id arms realistic",
      },
    });
    expect(seed.status).toBe(201);
  });

  afterAll(() => {
    server.close();
  });

  it("three-arm probe: DELETE/GET/PUT on the same malformed id all answer 4xx with a code", async () => {
    const del = await httpRequest(
      "DELETE",
      `/api/memories/${MALFORMED_ID}${qs}`,
    );
    const get = await httpRequest("GET", `/api/memories/${MALFORMED_ID}${qs}`);
    const put = await httpRequest("PUT", `/api/memories/${MALFORMED_ID}${qs}`, {
      json: { content: "x" },
    });

    // The reported defect: the DELETE arm answered 500 with no code while its
    // two siblings answered 404 NOT_FOUND for the identical id.
    assertClientErrorEnvelope(del);
    assertClientErrorEnvelope(get);
    assertClientErrorEnvelope(put);

    // Sibling parity is the contract: the same malformed id must be
    // classified the same way by all three arms.
    expect(del.status).toBe(404);
    expect(del.body.code).toBe("NOT_FOUND");
    expect(del.status).toBe(get.status);
    expect(del.status).toBe(put.status);
  });

  it("DELETE on a well-formed but unknown UUID is still 404 NOT_FOUND", async () => {
    const res = await httpRequest("DELETE", `/api/memories/${UNKNOWN_ID}${qs}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    expect(res.body.error).toContain("not found");
  });

  it("DELETE on a real id is still 204 (and the memory is then gone)", async () => {
    const created = await httpRequest("POST", `/api/memories${qs}`, {
      json: {
        key: `/df-2026-5/${Date.now()}`,
        domain: "raw_note",
        content: "DF-2026-5 delete control — must still tombstone for real",
      },
    });
    expect(created.status).toBe(201);
    expect(typeof created.body.id).toBe("string");

    const deleted = await httpRequest(
      "DELETE",
      `/api/memories/${created.body.id}${qs}`,
    );
    expect(deleted.status).toBe(204);

    const after = await httpRequest(
      "GET",
      `/api/memories/${created.body.id}${qs}`,
    );
    expect(after.status).toBe(404);
  });
});

describe("DF-2026-6: POST /api/memories body-shape battery", () => {
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

  it("(a) no body and no Content-Type answers 4xx, not 500", async () => {
    // The reported defect: express.json() skips a request with no
    // Content-Type, so req.body stayed undefined and the route threw a
    // TypeError that surfaced as 500 INTERNAL_ERROR.
    const res = await httpRequest("POST", `/api/memories${qs}`, {
      contentType: null,
    });

    assertClientErrorEnvelope(res);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_JSON");
  });

  it("(b) empty JSON object keeps its 400 VALIDATION_ERROR", async () => {
    const res = await httpRequest("POST", `/api/memories${qs}`, { json: {} });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.error).toContain("Missing required fields");
  });

  it("(c) malformed JSON keeps its 400 INVALID_JSON", async () => {
    const res = await httpRequest("POST", `/api/memories${qs}`, {
      raw: "{not json",
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_JSON");
  });

  it("(d) a complete body still creates the memory (201)", async () => {
    const res = await httpRequest("POST", `/api/memories${qs}`, {
      json: {
        key: `/df-2026-6/${Date.now()}`,
        domain: "raw_note",
        content: "DF-2026-6 positive control — the body path still works",
      },
    });

    expect(res.status).toBe(201);
    expect(typeof res.body.id).toBe("string");
  });
});
