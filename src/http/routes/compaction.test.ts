/**
 * Unit tests for Compaction API routes (compaction.ts)
 *
 * Tests GET /api/compaction/stats and POST /api/compaction/squash
 * with mocked squashTool / getCompactionStatsTool.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import { createServer } from "http";

// Mock MCP tools before importing the route
vi.mock("../../mcp/tools/squash", () => ({
  squashTool: vi.fn(),
  getCompactionStatsTool: vi.fn(),
}));

import { squashTool, getCompactionStatsTool } from "../../mcp/tools/squash";
import { createCompactionRoutes } from "./compaction";

const mockedSquashTool = vi.mocked(squashTool);
const mockedGetCompactionStatsTool = vi.mocked(getCompactionStatsTool);

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/compaction", createCompactionRoutes);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || "Internal server error",
      code: err.code,
    });
  });
  return app;
}

function request(
  app: express.Express,
  method: string,
  path: string,
  body?: any,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr !== "string" ? addr.port : 0;
      const http = require("http");
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: {
            Host: "localhost",
            ...(payload
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(payload),
                }
              : {}),
          },
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
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const sampleStats = {
  totalSize: 1024,
  totalPartitions: 5,
  parquetPartitions: 2,
  jsonlPartitions: 3,
  totalRecords: 100,
  tombstoneRecords: 10,
  tombstonePercent: 10,
  parquetRatio: 0.4,
  oldPartitions: ["2024-01"],
  largePartitions: [{ path: "2024-01", size: 512, records: 50 }],
};

describe("GET /api/compaction/stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return 200 with stats when tool succeeds", async () => {
    mockedGetCompactionStatsTool.mockResolvedValue({
      success: true,
      stats: sampleStats,
    });

    const app = createApp();
    const { status, body } = await request(app, "GET", "/api/compaction/stats");

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.stats).toEqual(sampleStats);
    expect(mockedGetCompactionStatsTool).toHaveBeenCalledWith({});
  });

  it("should return 500 when tool fails", async () => {
    mockedGetCompactionStatsTool.mockResolvedValue({
      success: false,
      error: "Not a git repository",
    });

    const app = createApp();
    const { status, body } = await request(app, "GET", "/api/compaction/stats");

    expect(status).toBe(500);
    expect(body.error).toContain("Not a git repository");
  });
});

describe("POST /api/compaction/squash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return 200 with message/stats on success", async () => {
    mockedSquashTool.mockResolvedValue({
      success: true,
      message: "Compacted 2 partitions: kept 90 records, removed 10 tombstones",
      stats: {
        partitionsCompacted: 2,
        totalRecordsKept: 90,
        totalRecordsRemoved: 10,
        tombstonesRemoved: 10,
      },
      errors: [],
    });

    const app = createApp();
    const { status, body } = await request(
      app,
      "POST",
      "/api/compaction/squash",
      {},
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.message).toContain("Compacted 2 partitions");
    expect(body.stats.partitionsCompacted).toBe(2);
    expect(mockedSquashTool).toHaveBeenCalledWith({
      partition: undefined,
      dryRun: false,
      aggressive: false,
    });
  });

  it("should pass partition, dryRun, and aggressive through to squashTool", async () => {
    mockedSquashTool.mockResolvedValue({
      success: true,
      message: "Preview: Would compact 90 records, removing 10 tombstones",
      stats: {
        totalRecordsKept: 90,
        totalRecordsRemoved: 10,
        tombstonesRemoved: 10,
      },
    });

    const app = createApp();
    const { status, body } = await request(
      app,
      "POST",
      "/api/compaction/squash",
      { partition: "2024-01", dryRun: true, aggressive: true },
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockedSquashTool).toHaveBeenCalledWith({
      partition: "2024-01",
      dryRun: true,
      aggressive: true,
    });
  });

  it("should return 400 for invalid body types", async () => {
    const app = createApp();
    const { status, body } = await request(
      app,
      "POST",
      "/api/compaction/squash",
      { partition: 123 },
    );

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
    expect(mockedSquashTool).not.toHaveBeenCalled();
  });

  it("should return 400 for non-boolean dryRun", async () => {
    const app = createApp();
    const { status } = await request(app, "POST", "/api/compaction/squash", {
      dryRun: "yes",
    });

    expect(status).toBe(400);
    expect(mockedSquashTool).not.toHaveBeenCalled();
  });

  it("should return 500 when squash fails", async () => {
    mockedSquashTool.mockResolvedValue({
      success: false,
      message: "Compaction failed: disk full",
      errors: ["disk full"],
    });

    const app = createApp();
    const { status, body } = await request(
      app,
      "POST",
      "/api/compaction/squash",
      {},
    );

    expect(status).toBe(500);
    expect(body.error).toContain("disk full");
  });
});
