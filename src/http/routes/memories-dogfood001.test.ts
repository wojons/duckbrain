/**
 * DOGFOOD-001 Regression Tests: GET /api/memories?q= forwards the query to
 * semantic recall.
 *
 * Root cause: the route parsed req.query.q into params.query but never passed
 * it to recallTool — q=SQLite and q=zzzznothing both returned the full
 * unfiltered list. The recall MCP tool fully supports `query` (semantic search
 * via the VSS path); it was just never wired through from the REST layer.
 *
 * The recall tool module is mocked (real metadata/schema kept so
 * registerTools() works; handler stubbed) so these tests exercise the route's
 * wiring — query forwarding, non-silent error surfacing, and no-q regression —
 * without needing a live embedding provider or DuckDB.
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

// Mock the recall tool module: keep the real metadata/schema (the MCP SDK's
// registerTools() requires a real Zod inputSchema) but stub the handler.
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

function semanticMemory(id: string, key: string, text: string) {
  return {
    id,
    key,
    domain: "raw_note",
    timestamp: "2026-08-07T00:00:00.000Z",
    author: "test@example.com",
    action: "add",
    embedding_text: text,
    attributes: {},
  };
}

describe("DOGFOOD-001: GET /api/memories?q= forwards query to semantic recall", () => {
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

  it("forwards ?q=<term> as query=<term> to recallTool and returns semantic results", async () => {
    const semanticResults = [
      semanticMemory("m1", "/notes/sqlite", "SQLite storage notes"),
      semanticMemory("m2", "/notes/duckdb", "DuckDB query layer"),
    ];
    vi.mocked(recallTool).mockResolvedValue({
      memories: semanticResults,
      count: 2,
    });

    const { status, body } = await httpRequest("GET", "/api/memories?q=SQLite");

    expect(status).toBe(200);
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({ query: "SQLite" }),
    );
    expect(body.items).toHaveLength(2);
    expect(body.items[0].id).toBe("m1");
    expect(body.items[0].content).toBe("SQLite storage notes");
  });

  it("returns 500 with the recall error when q= is set and semantic search fails (no silent full list)", async () => {
    const recallError =
      "Semantic search requires an embedding provider - start LM Studio/Ollama or set DUCKBRAIN_EMBEDDING_PROVIDER, then run 'duckbrain embeddings rebuild'";
    vi.mocked(recallTool).mockResolvedValue({
      memories: [],
      count: 0,
      error: recallError,
    });

    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?q=zzzznothing",
    );

    expect(status).toBe(500);
    expect(body.error).toBe(recallError);
    expect(body.items).toBeUndefined();
  });

  it("keeps current behavior without q= (prefix/domain filters, pagination, no query arg)", async () => {
    const memories = [
      semanticMemory("p1", "/projects/alpha", "Alpha project"),
      semanticMemory("p2", "/projects/beta", "Beta project"),
      semanticMemory("p3", "/projects/gamma", "Gamma project"),
    ];
    vi.mocked(recallTool).mockResolvedValue({
      memories,
      count: 3,
    });

    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?prefix=/projects/&domain=raw_note&limit=2",
    );

    expect(status).toBe(200);
    // limit+1 fetched to detect hasMore; filters forwarded; NO query key
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith({
      keyPrefix: "/projects/",
      limit: 3,
      domain: "raw_note",
      namespace: "default",
    });
    expect(body.items).toHaveLength(2);
    expect(body.items[0].id).toBe("p1");
    expect(body.items[1].id).toBe("p2");
    expect(body.hasMore).toBe(true);
    expect(body.total).toBe(2);
    expect(body.nextOffset).toBe(2);
  });
});
