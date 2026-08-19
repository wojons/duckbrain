/**
 * RETR-006 Regression Tests: GET /api/memories?attr.<name>=<value> forwards
 * attribute filters to recall.
 *
 * Root cause class (DOGFOOD-001): query params parsed into params but
 * never passed to recallTool were silently dropped. Every ?attr.*= param
 * (prefix-stripped) must reach recallTool's `attr` field as one name→value
 * pair, and the route must NOT fabricate an attr filter when none is given.
 *
 * The recall tool module is mocked (real metadata/schema kept) — same
 * pattern as memories-contains-retr001.test.ts.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { createHttpServer } from "../../cli/http";
import { createServer, Server } from "http";
import { recallTool } from "../../mcp/tools/recall";

vi.mock("../../mcp/tools/recall", async () => {
  const actual = await vi.importActual<typeof import("../../mcp/tools/recall")>(
    "../../mcp/tools/recall",
  );
  return {
    ...actual,
    recallTool: vi.fn(),
  };
});

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

describe("RETR-006: GET /api/memories?attr.<name>=<value> forwards attribute filters to recall", () => {
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
    vi.mocked(recallTool).mockReset();
    vi.mocked(recallTool).mockResolvedValue({
      memories: [],
      count: 0,
      total: 0,
    });
  });

  it('forwards ?attr.domain=config as attr: {domain: "config"}', async () => {
    const { status } = await httpRequest(
      "GET",
      "/api/memories?attr.domain=config",
    );

    expect(status).toBe(200);
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({ attr: { domain: "config" } }),
    );
  });

  it("forwards multiple attr.* params as separate name→value pairs", async () => {
    const { status } = await httpRequest(
      "GET",
      "/api/memories?attr.domain=config&attr.tick=403",
    );

    expect(status).toBe(200);
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({ attr: { domain: "config", tick: "403" } }),
    );
  });

  it("forwards attr.* together with existing filters (prefix, namespace, limit)", async () => {
    const { status } = await httpRequest(
      "GET",
      "/api/memories?prefix=/cfg/&attr.domain=config&namespace=retr006&limit=5",
    );

    expect(status).toBe(200);
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({
        keyPrefix: "/cfg/",
        attr: { domain: "config" },
        namespace: "retr006",
        limit: 6,
      }),
    );
  });

  it("does not forward non-attr params into attr", async () => {
    const { status } = await httpRequest(
      "GET",
      "/api/memories?prefix=/cfg/&domain=config&attr.domain=config",
    );

    expect(status).toBe(200);
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({ attr: { domain: "config" } }),
    );
    const args = vi.mocked(recallTool).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(args.attr as Record<string, unknown>).sort()).toEqual([
      "domain",
    ]);
  });

  it("keeps current behavior without attr.* params (no attr key forwarded)", async () => {
    const { status } = await httpRequest("GET", "/api/memories?prefix=/cfg/");

    expect(status).toBe(200);
    const args = vi.mocked(recallTool).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(args).not.toHaveProperty("attr");
  });
});
