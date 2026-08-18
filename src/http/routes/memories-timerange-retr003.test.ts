/**
 * RETR-003 Regression Tests: time-scoped recall via GET /api/memories.
 *
 * - ?after= / ?before= / ?between= window the response AND the total
 *   (route → recallTool → DuckDB, real namespace, no mocks)
 * - date-only before= includes the whole end day (until semantics)
 * - invalid ISO-8601 values return a clean 400 VALIDATION_ERROR (not a
 *   crash, not a 500)
 * - between= combined with after/before and empty windows also 400
 *
 * Follows the httpRequest + seeded-namespace pattern from
 * memories-pagination-gap024.test.ts.
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

const REPO_CONFIG = path.join(process.cwd(), "duckbrain.config.json");

// Timestamps spread across 2026-08-10 .. 2026-08-14.
function seedMemory(i: number) {
  return {
    id: crypto.randomUUID(),
    key: `/timerange/${i}`,
    domain: "concept",
    timestamp: `2026-08-${String(10 + (i % 5)).padStart(2, "0")}T12:00:00.000Z`,
    author: "test@example.com",
    action: "add",
    embedding_text: `Timerange seed memory ${i}`,
    attributes: {},
  };
}

// Day mapping: i=1→08-11, 2→08-12, 3→08-13, 4→08-14, 5→08-10,
// 6→08-11, 7→08-12. So: days {11,12} = i∈{1,6,2,7}, days {12,13} =
// i∈{2,7,3}, days {13,14} = i∈{3,4}.
const SEEDED = 7;

describe("RETR-003: time-scoped recall — GET /api/memories", () => {
  let configBefore: string;

  beforeAll(async () => {
    configBefore = fs.readFileSync(REPO_CONFIG, "utf-8");

    fs.mkdirSync(PARTITION, { recursive: true });
    const lines: string[] = [];
    for (let i = 1; i <= SEEDED; i++) {
      lines.push(JSON.stringify(seedMemory(i)));
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
    expect(fs.readFileSync(REPO_CONFIG, "utf-8")).toBe(configBefore);
    fs.rmSync(PARTITION, { recursive: true, force: true });
    fs.rmSync(MANIFEST, { force: true });
  });

  it("after+before returns only in-range rows and the count matches", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=50&after=2026-08-11&before=2026-08-12",
    );

    expect(status).toBe(200);
    // i∈{1,6,2,7} → 08-11 and 08-12; date-only before= includes the whole end day.
    expect(body.items).toHaveLength(4);
    expect(body.total).toBe(4);
    expect(body.hasMore).toBe(false);
    for (const item of body.items) {
      const day = item.timestamp.slice(8, 10);
      expect(["11", "12"]).toContain(day);
    }
  });

  it("between=START,END is equivalent to after+before", async () => {
    const { status, body } = await httpRequest(
      "GET",
      `/api/memories?namespace=default&limit=50&between=${encodeURIComponent("2026-08-12,2026-08-13")}`,
    );

    expect(status).toBe(200);
    // i∈{2,7,3} → 08-12 and 08-13.
    expect(body.items).toHaveLength(3);
    expect(body.total).toBe(3);
    for (const item of body.items) {
      const day = item.timestamp.slice(8, 10);
      expect(["12", "13"]).toContain(day);
    }
  });

  it("after= alone keeps the total consistent with the returned window", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=50&after=2026-08-13",
    );

    expect(status).toBe(200);
    expect(body.items).toHaveLength(2); // i=6..7 → 08-13
    expect(body.total).toBe(2);
  });

  it("invalid after= returns a clean 400 (not a crash)", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&after=not-a-date",
    );

    expect(status).toBe(400);
    expect(body.error).toMatch(/Invalid ISO-8601 datetime for after/);
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("calendar-impossible dates return a clean 400", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&after=2026-02-30",
    );

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("invalid between= returns a clean 400", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&between=2026-08-12",
    );

    expect(status).toBe(400);
    expect(body.error).toMatch(/two comma-separated ISO-8601 values/);
  });

  it("between= combined with after= returns a clean 400", async () => {
    const { status, body } = await httpRequest(
      "GET",
      `/api/memories?namespace=default&after=2026-08-10&between=${encodeURIComponent("2026-08-11,2026-08-12")}`,
    );

    expect(status).toBe(400);
    expect(body.error).toMatch(/either 'between' or 'after'\/'before'/);
  });

  it("an empty window (after > before) returns a clean 400", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&after=2026-08-12&before=2026-08-10",
    );

    expect(status).toBe(400);
    expect(body.error).toMatch(/must not be later than before/);
  });

  it("valid bounds with no matches return an empty page, not an error", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=50&after=2025-01-01&before=2025-01-02",
    );

    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });
});
