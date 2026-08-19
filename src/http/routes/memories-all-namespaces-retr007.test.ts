/**
 * RETR-007 Regression Tests: GET /api/memories?allNamespaces=true.
 *
 * Guards the HTTP wiring of cross-namespace keyword search:
 *   - ?allNamespaces=true is forwarded to recallTool as { allNamespaces:
 *     true } and the scoped namespace param is OMITTED (recallTool rejects
 *     the pair)
 *   - each hit's namespace facet round-trips through the response
 *     transform
 *   - without the flag, namespace defaults as before (unchanged)
 *   - a scoped (per-namespace-grant) token is rejected with 403 — the
 *     union spans every namespace, which a scoped grant cannot cover
 *
 * recallTool is mocked (real metadata/schema kept) so these tests
 * exercise the route's wiring without needing a rebuilt FTS sidecar —
 * the sidecar itself is covered by search-retr007.test.ts.
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

function httpRequest(
  method: string,
  path: string,
  headers: Record<string, string> = {},
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
        ...headers,
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

describe("RETR-007: GET /api/memories?allNamespaces=true (auth none)", () => {
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

  it("forwards ?allNamespaces=true as allNamespaces and omits namespace", async () => {
    vi.mocked(recallTool).mockResolvedValue({
      memories: [],
      count: 0,
      total: 0,
    });

    const { status } = await httpRequest(
      "GET",
      "/api/memories?contains=S3&allNamespaces=true",
    );

    expect(status).toBe(200);
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({
        contains: "S3",
        allNamespaces: true,
      }),
    );
    const call = vi.mocked(recallTool).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    // The scoped namespace must NOT ride along with the union flag.
    expect(call.namespace).toBeUndefined();
  });

  it("round-trips each hit's namespace facet through the response", async () => {
    vi.mocked(recallTool).mockResolvedValue({
      memories: [
        {
          ...keywordMemory("m1", "/proj/s3-config", "S3 config", "…S3…"),
          namespace: "search-retr007-a",
        },
        {
          ...keywordMemory("m2", "/proj/s3-archive", "S3 archive", "…S3…"),
          namespace: "search-retr007-b",
        },
      ],
      count: 2,
      total: 2,
      namespace: "all",
    });

    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?contains=S3&allNamespaces=true",
    );

    expect(status).toBe(200);
    expect(body.items).toHaveLength(2);
    expect(body.items[0].namespace).toBe("search-retr007-a");
    expect(body.items[1].namespace).toBe("search-retr007-b");
  });

  it("without the flag, namespace defaults as before and no allNamespaces key is forwarded", async () => {
    vi.mocked(recallTool).mockResolvedValue({
      memories: [],
      count: 0,
      total: 0,
    });

    const { status } = await httpRequest("GET", "/api/memories?contains=S3");

    expect(status).toBe(200);
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({ contains: "S3", namespace: "default" }),
    );
    const call = vi.mocked(recallTool).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(call.allNamespaces).toBeUndefined();
  });
});

describe("RETR-007: allNamespaces grant guard", () => {
  beforeAll(async () => {
    const app = createHttpServer({
      authConfig: {
        type: "apikey",
        apiKeys: [
          // Unrestricted token (no namespaces list = full access).
          { key: "unrestricted-key", name: "admin" },
          // Scoped token: grant only for the "default" namespace — the
          // union spans every namespace, which this cannot cover.
          { key: "scoped-key", name: "agent-alpha", namespaces: ["default"] },
        ],
      },
    });
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

  it("rejects ?allNamespaces=true with 403 for a scoped token", async () => {
    vi.mocked(recallTool).mockResolvedValue({
      memories: [],
      count: 0,
      total: 0,
    });

    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?contains=S3&allNamespaces=true",
      { "x-api-key": "scoped-key" },
    );

    expect(status).toBe(403);
    expect(body.error).toContain("cross-namespace search");
    // The union must never reach recallTool for a scoped token.
    expect(vi.mocked(recallTool)).not.toHaveBeenCalled();
  });

  it("allows ?allNamespaces=true for an unrestricted token", async () => {
    vi.mocked(recallTool).mockResolvedValue({
      memories: [],
      count: 0,
      total: 0,
    });

    const { status } = await httpRequest(
      "GET",
      "/api/memories?contains=S3&allNamespaces=true",
      { "x-api-key": "unrestricted-key" },
    );

    expect(status).toBe(200);
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({ allNamespaces: true }),
    );
  });
});
