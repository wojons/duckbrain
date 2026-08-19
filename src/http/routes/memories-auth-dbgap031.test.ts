/**
 * DB-GAP-031 Regression Tests: apikey auth hardening.
 *
 * Covers the full HTTP surface:
 *  - apikey mode rejects token-less requests with 401
 *  - valid tokens (unrestricted) pass through with 200
 *  - per-token namespace grants: scoped token gets 403 outside its grants,
 *    200 inside them (read, write, AND create_namespace)
 *  - authenticated writes stamp the principal identity — a client-supplied
 *    ?author= value is ignored
 *  - /health stays open without a token
 *  - auth=none mode keeps the existing git-config author fallback
 *
 * The MCP tool modules are mocked (real metadata/schema kept) so the tests
 * exercise route + middleware wiring without DuckDB or an embedding
 * provider. Auth config is injected via HttpServerOptions.authConfig so the
 * real ~/.duckbrain/auth.json is never touched.
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
import { rememberTool } from "../../mcp/tools/remember";
import { forgetTool } from "../../mcp/tools/forget";

// Pin the embedding health probe to a fast-fail provider (openai + empty
// key => no network) so the /health test answers instantly.
process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "openai";
process.env.DUCKBRAIN_EMBEDDING_API_KEY = "";

vi.mock("../../mcp/tools/recall", async () => {
  const actual = await vi.importActual<typeof import("../../mcp/tools/recall")>(
    "../../mcp/tools/recall",
  );
  return { ...actual, recallTool: vi.fn() };
});

vi.mock("../../mcp/tools/remember", async () => {
  const actual = await vi.importActual<
    typeof import("../../mcp/tools/remember")
  >("../../mcp/tools/remember");
  return { ...actual, rememberTool: vi.fn() };
});

vi.mock("../../mcp/tools/forget", async () => {
  const actual = await vi.importActual<typeof import("../../mcp/tools/forget")>(
    "../../mcp/tools/forget",
  );
  return { ...actual, forgetTool: vi.fn() };
});

interface HttpResponse {
  status: number;
  body: any;
}

function httpRequest(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
  targetPort: number = port,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const options: any = {
      hostname: "127.0.0.1",
      port: targetPort,
      path,
      method,
      headers: {
        Host: "localhost",
        ...(opts.headers || {}),
      },
    };
    if (opts.body !== undefined) {
      options.headers["Content-Type"] = "application/json";
    }

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
    if (opts.body !== undefined) {
      req.write(JSON.stringify(opts.body));
    }
    req.end();
  });
}

let server: Server;
let port: number;

const AUTH_CONFIG = {
  type: "apikey" as const,
  apiKeys: [
    { key: "unrestricted-key", name: "unrestricted-agent" },
    { key: "scoped-key", name: "scoped-agent", namespaces: ["a"] },
  ],
};

describe("DB-GAP-031: apikey auth + per-token namespace grants", () => {
  beforeAll(async () => {
    const app = createHttpServer({ authConfig: AUTH_CONFIG });
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
    vi.mocked(rememberTool).mockReset();
    vi.mocked(forgetTool).mockReset();
    vi.mocked(recallTool).mockResolvedValue({ memories: [], count: 0 } as any);
    vi.mocked(rememberTool).mockImplementation((input: any) =>
      Promise.resolve({
        success: true,
        id: "m1",
        key: input.key,
        author: input.author ?? "git-fallback",
      } as any),
    );
  });

  it("rejects token-less GET /api/memories with 401", async () => {
    const { status } = await httpRequest(
      "GET",
      "/api/memories?namespace=default",
    );
    expect(status).toBe(401);
    expect(vi.mocked(recallTool)).not.toHaveBeenCalled();
  });

  it("allows /health without a token (still 200)", async () => {
    const { status, body } = await httpRequest("GET", "/health");
    expect(status).toBe(200);
    expect(["healthy", "degraded"]).toContain(body.status);
  });

  it("allows an unrestricted token on any namespace", async () => {
    const { status } = await httpRequest("GET", "/api/memories?namespace=b", {
      headers: { "X-API-Key": "unrestricted-key" },
    });
    expect(status).toBe(200);
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "b" }),
    );
  });

  it("returns 403 for a scoped token outside its namespace grants", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=b",
      { headers: { "X-API-Key": "scoped-key" } },
    );
    expect(status).toBe(403);
    expect(body.error).toContain("'b'");
    expect(vi.mocked(recallTool)).not.toHaveBeenCalled();
  });

  it("allows a scoped token inside its namespace grants", async () => {
    const { status } = await httpRequest("GET", "/api/memories?namespace=a", {
      headers: { "X-API-Key": "scoped-key" },
    });
    expect(status).toBe(200);
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "a" }),
    );
  });

  it("rejects a scoped-token write outside its grants with 403 (no tool call)", async () => {
    const { status } = await httpRequest("POST", "/api/memories?namespace=b", {
      headers: { "X-API-Key": "scoped-key" },
      body: {
        key: "/dbgap031/outside",
        domain: "raw_note",
        content: "should never land",
      },
    });
    expect(status).toBe(403);
    expect(vi.mocked(rememberTool)).not.toHaveBeenCalled();
  });

  it("rejects a scoped token creating an un-granted namespace with 403", async () => {
    const { status } = await httpRequest("POST", "/api/namespaces", {
      headers: { "X-API-Key": "scoped-key" },
      body: { name: "b" },
    });
    expect(status).toBe(403);
  });

  it("stamps the principal author on writes — client ?author= is ignored", async () => {
    const { status, body } = await httpRequest(
      "POST",
      "/api/memories?namespace=a&author=spoof",
      {
        headers: { "X-API-Key": "scoped-key" },
        body: {
          key: "/dbgap031/stamped",
          domain: "raw_note",
          content: "authenticated write",
        },
      },
    );
    expect(status).toBe(201);
    // rememberTool received the token identity (email-mapped), never the
    // spoof value — the memory schema requires an email author.
    expect(vi.mocked(rememberTool)).toHaveBeenCalledWith(
      expect.objectContaining({ author: "scoped-agent@duckbrain.local" }),
    );
    expect(vi.mocked(rememberTool)).not.toHaveBeenCalledWith(
      expect.objectContaining({ author: "spoof" }),
    );
    // the stored record (echoed in the response) carries the principal
    expect(body.author).toBe("scoped-agent@duckbrain.local");
  });
});

describe("DB-GAP-031: auth=none keeps the git-config author fallback", () => {
  let noneServer: Server;
  let nonePort: number;

  beforeAll(async () => {
    const app = createHttpServer(); // default authType none
    noneServer = createServer(app);
    await new Promise<void>((resolve) => {
      noneServer.listen(0, "127.0.0.1", () => {
        const addr = noneServer.address();
        if (addr && typeof addr !== "string") nonePort = addr.port;
        resolve();
      });
    });
  });

  afterAll(() => {
    noneServer.close();
  });

  beforeEach(() => {
    vi.mocked(rememberTool).mockReset();
    vi.mocked(rememberTool).mockImplementation((input: any) =>
      Promise.resolve({
        success: true,
        id: "m2",
        key: input.key,
        author: input.author ?? "git-fallback",
      } as any),
    );
  });

  it("ignores ?author= but keeps the git-config fallback (no principal to stamp)", async () => {
    const { status, body } = await httpRequest(
      "POST",
      "/api/memories?author=spoof",
      {
        body: {
          key: "/dbgap031/fallback",
          domain: "raw_note",
          content: "local single-user write",
        },
      },
      nonePort,
    );
    expect(status).toBe(201);
    // no author key forwarded to the tool → rememberTool falls back to
    // getAuthorEmail() (git config)
    expect(vi.mocked(rememberTool)).not.toHaveBeenCalledWith(
      expect.objectContaining({ author: expect.anything() }),
    );
    expect(body.author).toBe("git-fallback");
  });
});
