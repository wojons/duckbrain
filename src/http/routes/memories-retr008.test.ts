/**
 * RETR-008 Regression Tests: GET /api/memories?contains= carries the
 * highlighted snippet through the response transform.
 *
 * Keyword hits now carry TWO snippet forms: the raw `snippet` (unchanged
 * API contract) and `highlightedSnippet` — the CLI-printable display form
 * with matched terms wrapped in <mark>…</mark>. The route must pass the
 * highlight through alongside the raw form, and must NOT fabricate one
 * when the underlying hit has none.
 *
 * The recall tool module is mocked (real metadata/schema kept) so these
 * tests exercise the route's transform wiring only — the sidecar and the
 * highlight projection itself are covered by search-retr008.test.ts.
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

function keywordMemory(
  id: string,
  key: string,
  text: string,
  snippet: string,
  highlightedSnippet?: string,
) {
  return {
    id,
    key,
    domain: "message",
    timestamp: "2026-08-07T09:26:26.867Z",
    author: "totalwindupflightsystems@gmail.com",
    action: "add",
    embedding_text: text,
    attributes: {},
    score: 0.2461,
    snippet,
    ...(highlightedSnippet !== undefined ? { highlightedSnippet } : {}),
    namespace: "chat-archive",
  };
}

describe("RETR-008: GET /api/memories?contains= highlight passthrough", () => {
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

  it("returns highlightedSnippet alongside the raw snippet on keyword hits", async () => {
    const keywordResults = [
      keywordMemory(
        "c1",
        "/chats/karahermes-set/2026-06-26",
        "GAP-020 harness",
        "…for the GAP-020 harness…",
        "…for the <mark>GAP-020</mark> harness…",
      ),
    ];
    vi.mocked(recallTool).mockResolvedValue({
      memories: keywordResults,
      count: 1,
      total: 1,
    });

    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?contains=GAP-020&namespace=chat-archive",
    );

    expect(status).toBe(200);
    expect(body.items).toHaveLength(1);
    // Raw snippet contract unchanged…
    expect(body.items[0].snippet).toContain("GAP-020");
    expect(body.items[0].snippet).not.toContain("<mark>");
    // …and the highlighted display form rides through the transform.
    expect(body.items[0].highlightedSnippet).toBe(
      "…for the <mark>GAP-020</mark> harness…",
    );
  });

  it("does not fabricate a highlight when the hit has none", async () => {
    vi.mocked(recallTool).mockResolvedValue({
      memories: [
        keywordMemory(
          "c2",
          "/chats/karahermes-set/2026-06-27",
          "milk and eggs",
          "…milk and eggs…",
        ),
      ],
      count: 1,
      total: 1,
    });

    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?contains=milk&namespace=chat-archive",
    );

    expect(status).toBe(200);
    expect(body.items[0].snippet).toBe("…milk and eggs…");
    expect(body.items[0].highlightedSnippet).toBeUndefined();
  });
});
