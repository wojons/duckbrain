/**
 * GAP-024 Regression Tests: pagination response correctness.
 *
 * - total is the true COUNT(*) of rows matching the active filters
 *   (prefix/domain/author/namespace), unlimited by limit/offset — not the
 *   fetched page length.
 * - limit=0 is an explicit empty page: items:[], hasMore:false,
 *   nextOffset:null, while still reporting the true total.
 *
 * Seeds a real namespace (JSONL partition + manifest) under the test-setup
 * temp root and exercises the full pipeline: route → recallTool → DuckDB.
 * Follows the httpRequest pattern from memories-bug027.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHttpServer } from "../../cli/http";
import { createServer, Server } from "http";
import fs from "fs";
import path from "path";

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

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const NS = path.join(NS_ROOT, "default");
const PARTITION = path.join(NS, "concept", "2026-08");
const JSONL = path.join(PARTITION, "current.jsonl");
const MANIFEST = path.join(NS, "manifest.json");

// 7 memories from test@example.com + 2 from other@example.com
const SEEDED = 9;
const AUTHOR_TEST = "test@example.com";
const AUTHOR_OTHER = "other@example.com";

const REPO_CONFIG = path.join(process.cwd(), "duckbrain.config.json");

function seedMemory(i: number, author: string) {
  return {
    id: crypto.randomUUID(),
    key: `/pagination/${author === AUTHOR_OTHER ? "other" : "test"}/${i}`,
    domain: "concept",
    timestamp: `2026-08-12T00:00:0${i}.000Z`,
    author,
    action: "add",
    embedding_text: `Pagination seed memory ${i}`,
    attributes: {},
  };
}

describe("GAP-024: pagination response correctness — GET /api/memories", () => {
  let configBefore: string;

  beforeAll(async () => {
    // GAP-022 AC1: the repo config file must be byte-identical after the run
    configBefore = fs.readFileSync(REPO_CONFIG, "utf-8");

    // Seed a real namespace: JSONL partition + manifest (dogfood002 pattern)
    fs.mkdirSync(PARTITION, { recursive: true });
    const lines: string[] = [];
    for (let i = 1; i <= 7; i++) {
      lines.push(JSON.stringify(seedMemory(i, AUTHOR_TEST)));
    }
    for (let i = 8; i <= 9; i++) {
      lines.push(JSON.stringify(seedMemory(i, AUTHOR_OTHER)));
    }
    fs.writeFileSync(JSONL, lines.join("\n") + "\n");
    fs.writeFileSync(
      MANIFEST,
      JSON.stringify({
        partitions: ["concept/2026-08"],
        lastUpdated: new Date().toISOString(),
      }),
    );

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
    // GAP-022 AC1: config file must be byte-identical after the test run
    expect(fs.readFileSync(REPO_CONFIG, "utf-8")).toBe(configBefore);
    fs.rmSync(PARTITION, { recursive: true, force: true });
    fs.rmSync(MANIFEST, { force: true });
  });

  it("returns the true total with limit=5 (items=5, total=9, hasMore=true)", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=5",
    );

    expect(status).toBe(200);
    expect(body.items).toHaveLength(5);
    expect(body.total).toBe(SEEDED);
    expect(body.hasMore).toBe(true);
    expect(body.nextOffset).toBe(5);
  });

  it("limit=0 returns an empty page with hasMore=false and the true total", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=0",
    );

    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(SEEDED);
    expect(body.hasMore).toBe(false);
    expect(body.nextOffset).toBeNull();
  });

  it("limit=2 returns 2 items with the true total and hasMore=true", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=2",
    );

    expect(status).toBe(200);
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(SEEDED);
    expect(body.hasMore).toBe(true);
  });

  it("author filter is reflected in total (total=2 for the other author)", async () => {
    const { status, body } = await httpRequest(
      "GET",
      `/api/memories?namespace=default&limit=5&author=${encodeURIComponent(AUTHOR_OTHER)}`,
    );

    expect(status).toBe(200);
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.hasMore).toBe(false);
    expect(body.nextOffset).toBeNull();
  });
});
