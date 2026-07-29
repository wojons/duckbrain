/**
 * Unit tests for Activity API routes (activity.ts)
 *
 * Tests GET /activity endpoint with mocked DuckDB and filesystem.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import { createServer } from "http";
import fs from "fs";

// Mock fs BEFORE importing the route
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
      readdirSync: vi.fn(),
      existsSync: vi.fn(),
      statSync: vi.fn(),
    },
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    existsSync: vi.fn(),
    statSync: vi.fn(),
  };
});

// Mock DuckDB connection
const mockDbAll = vi.fn();
vi.mock("../../duckdb/connection", () => ({
  getDuckDBConnection: vi.fn(() => ({
    all: mockDbAll,
  })),
}));

import { createActivityRoutes } from "./activity";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/activity", createActivityRoutes);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || "Internal server error",
      code: err.code,
    });
  });
  return app;
}

function httpRequest(
  app: express.Express,
  path: string,
  method: string = "GET",
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr !== "string" ? addr.port : 0;
      const http = require("http");
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: { Host: "localhost" },
        },
        (res: any) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on("end", () => {
            server.close();
            try {
              resolve({ status: res.statusCode, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode, body: data });
            }
          });
        },
      );
      req.on("error", (err: Error) => {
        server.close();
        reject(err);
      });
      req.end();
    });
  });
}

function setupMockFs(namespaceDirs: string[]) {
  vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
    const s = p.toString();
    if (s === "duckbrain.config.json") return true;
    if (s.includes("namespaces")) return true;
    if (s.includes("manifest.json")) return true;
    return false;
  });
  vi.mocked(fs.readdirSync).mockImplementation((p: any) => {
    const s = p.toString();
    if (
      s === "./namespaces" ||
      (s.includes("namespaces") && s.split("/").length <= 2)
    ) {
      return namespaceDirs as any;
    }
    return ["chunk_000.jsonl", "chunk_001.jsonl"] as any;
  });
  vi.mocked(fs.statSync).mockImplementation(() => {
    return { isDirectory: () => true, isFile: () => false } as any;
  });
  vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
    const s = p.toString();
    if (s === "duckbrain.config.json") {
      return JSON.stringify({ namespacesPath: "./namespaces" });
    }
    if (s.includes("manifest.json")) {
      return JSON.stringify({ partitions: ["2024-01"] });
    }
    return "";
  });
}

describe("GET /activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return 200 with empty activities when no namespaces", async () => {
    setupMockFs([]);

    const app = createApp();
    const { status, body } = await httpRequest(app, "/activity");

    expect(status).toBe(200);
    expect(body.activities).toBeDefined();
    expect(Array.isArray(body.activities)).toBe(true);
    expect(body.activities).toHaveLength(0);
    expect(body.count).toBe(0);
    expect(body.limit).toBe(50);
  });

  it("should return 200 with activities from DuckDB results", async () => {
    setupMockFs(["default"]);

    mockDbAll.mockImplementation((_sql: string, callback: Function) => {
      callback(null, [
        {
          id: "mem-1",
          key: "/projects/test",
          domain: "concept",
          timestamp: "2024-01-15T10:30:00Z",
          author: "test@example.com",
          action: "add",
          embedding_text: "Test memory content",
          attributes: "{key1=value1, key2=42}",
        },
        {
          id: "mem-2",
          key: "/notes/idea",
          domain: "raw_note",
          timestamp: "2024-01-15T11:00:00Z",
          author: "user@example.com",
          action: "edit",
          embedding_text: "Another memory",
          attributes: "{}",
        },
      ]);
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, "/activity");

    expect(status).toBe(200);
    expect(body.activities).toHaveLength(2);
    expect(body.count).toBe(2);
    expect(body.limit).toBe(50);
  });

  it("should respect limit query parameter", async () => {
    setupMockFs(["default"]);

    mockDbAll.mockImplementation((_sql: string, callback: Function) => {
      callback(null, [
        {
          id: "1",
          key: "/a",
          domain: "concept",
          timestamp: "2024-01-01T00:00:00Z",
          author: "a",
          action: "add",
          embedding_text: "a",
          attributes: "{}",
        },
      ]);
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, "/activity?limit=5");

    expect(status).toBe(200);
    expect(body.limit).toBe(5);
  });

  it("should cap limit at 200", async () => {
    setupMockFs(["default"]);

    mockDbAll.mockImplementation((_sql: string, callback: Function) => {
      callback(null, []);
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, "/activity?limit=999");

    expect(status).toBe(200);
    expect(body.limit).toBeLessThanOrEqual(200);
  });

  it("should default to limit=50 when parameter is invalid", async () => {
    setupMockFs(["default"]);

    mockDbAll.mockImplementation((_sql: string, callback: Function) => {
      callback(null, []);
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, "/activity?limit=invalid");

    expect(status).toBe(200);
    expect(body.limit).toBe(50);
  });

  it("should have activities with expected shape", async () => {
    setupMockFs(["default"]);

    mockDbAll.mockImplementation((_sql: string, callback: Function) => {
      callback(null, [
        {
          id: "mem-1",
          key: "/test",
          domain: "concept",
          timestamp: "2024-01-01T00:00:00Z",
          author: "author",
          action: "add",
          embedding_text: "content",
          attributes: "{key1=value1}",
        },
      ]);
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, "/activity");

    expect(status).toBe(200);
    const activity = body.activities[0];
    expect(activity.id).toBeDefined();
    expect(activity.key).toBeDefined();
    expect(activity.timestamp).toBeDefined();
    expect(activity.action).toBeDefined();
    expect(activity.content).toBeDefined();
    expect(activity.attributes).toBeDefined();
  });

  it("should handle DuckDB errors gracefully", async () => {
    setupMockFs(["default"]);

    mockDbAll.mockImplementation((_sql: string, callback: Function) => {
      callback(new Error("DuckDB error"), null);
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, "/activity");

    expect(status).toBe(200);
    expect(body.activities).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("should handle null result from DuckDB", async () => {
    setupMockFs(["default"]);

    mockDbAll.mockImplementation((_sql: string, callback: Function) => {
      callback(null, null);
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, "/activity");

    expect(status).toBe(200);
    expect(body.activities).toEqual([]);
  });

  it("should handle non-array result from DuckDB", async () => {
    setupMockFs(["default"]);

    mockDbAll.mockImplementation((_sql: string, callback: Function) => {
      callback(null, { not: "an array" });
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, "/activity");

    expect(status).toBe(200);
    expect(body.activities).toEqual([]);
  });

  it("should filter tombstone actions in SQL query", async () => {
    setupMockFs(["default"]);

    mockDbAll.mockImplementation((sql: string, callback: Function) => {
      // Verify SQL includes tombstone filter
      expect(sql).toContain("action != 'tombstone'");
      callback(null, [
        {
          id: "mem-1",
          key: "/a",
          domain: "concept",
          timestamp: "2024-01-01T00:00:00Z",
          author: "a",
          action: "add",
          embedding_text: "a",
          attributes: "{}",
        },
      ]);
    });

    const app = createApp();
    const { status, body } = await httpRequest(app, "/activity");

    expect(status).toBe(200);
    expect(body.activities).toHaveLength(1);
  });
});
