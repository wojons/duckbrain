/**
 * RETR-001 Regression Tests: GET /api/memories?contains= forwards the
 * keyword filter to recall.
 *
 * Root cause class (DOGFOOD-001): query params parsed into params but
 * never passed to recallTool were silently dropped. ?contains= must reach
 * recallTool's `contains` field and keyword results (with snippet) must
 * round-trip through the response transform.
 *
 * The recall tool module is mocked (real metadata/schema kept) so these
 * tests exercise the route's wiring without needing a rebuilt FTS
 * sidecar — the sidecar itself is covered by search-retr001.test.ts.
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

function keywordMemory(id: string, key: string, text: string, snippet: string) {
  return {
    id,
    key,
    domain: "raw_note",
    timestamp: "2026-08-07T00:00:00.000Z",
    author: "test@example.com",
    action: "add",
    embedding_text: text,
    attributes: {},
    score: 0.2461,
    snippet,
  };
}

describe("RETR-001: GET /api/memories?contains= forwards keyword filter to recall", () => {
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
  });

  it("forwards ?contains=<token> as contains= to recallTool and returns keyword results", async () => {
    const keywordResults = [
      keywordMemory(
        "m1",
        "/proj/gap-020",
        "GAP-020 memory about the fix",
        "…GAP-020 memory about the fix…",
      ),
    ];
    vi.mocked(recallTool).mockResolvedValue({
      memories: keywordResults,
      count: 1,
      total: 1,
    });

    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?contains=GAP-020",
    );

    expect(status).toBe(200);
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({ contains: "GAP-020" }),
    );
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("m1");
    expect(body.items[0].content).toBe("GAP-020 memory about the fix");
    // Keyword results carry the snippet through the response transform.
    expect(body.items[0].snippet).toContain("GAP-020");
    expect(body.items[0].score).toBe(0.2461);
  });

  it("forwards ?contains= together with namespace and limit", async () => {
    vi.mocked(recallTool).mockResolvedValue({
      memories: [],
      count: 0,
      total: 0,
    });

    const { status } = await httpRequest(
      "GET",
      "/api/memories?contains=GAP&namespace=search-retr001&limit=5",
    );

    expect(status).toBe(200);
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({
        contains: "GAP",
        namespace: "search-retr001",
        limit: 6,
      }),
    );
  });

  it("surfaces recall errors (missing index) as 500, never a silent full list", async () => {
    const recallError =
      "Keyword search failed: No keyword search index for namespace 'default' at …/.search — run 'duckbrain search-index rebuild' first";
    vi.mocked(recallTool).mockResolvedValue({
      memories: [],
      count: 0,
      error: recallError,
    });

    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?contains=zzzznothing",
    );

    expect(status).toBe(500);
    expect(body.error).toBe(recallError);
    expect(body.items).toBeUndefined();
  });

  it("keeps current behavior without contains= (no contains key forwarded)", async () => {
    // Plain list results carry no snippet — the route must not fabricate one.
    const memories = [
      {
        id: "p1",
        key: "/projects/alpha",
        domain: "raw_note",
        timestamp: "2026-08-07T00:00:00.000Z",
        author: "test@example.com",
        action: "add",
        embedding_text: "Alpha project",
        attributes: {},
      },
    ];
    vi.mocked(recallTool).mockResolvedValue({
      memories,
      count: 1,
    });

    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?prefix=/projects/",
    );

    expect(status).toBe(200);
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({
        keyPrefix: "/projects/",
        // No ?limit= in the URL → default 50, route fetches 50+1 for hasMore.
        limit: 51,
        namespace: "default",
      }),
    );
    // No snippet on the plain list path.
    expect(body.items[0].snippet).toBeUndefined();
  });
});
