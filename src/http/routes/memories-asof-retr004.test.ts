/**
 * RETR-004 Regression Tests: memory-as-of via GET /api/memories.
 *
 * - ?as_of=<commit> returns exactly the rows present at that ref (200)
 * - ?as_of=<date> resolves to the nearest commit at-or-before it
 * - invalid as_of values return a clean 400 VALIDATION_ERROR
 * - as_of combined with q= is rejected (recallTool error → 500)
 *
 * Follows the httpRequest + seeded-namespace pattern from
 * memories-timerange-retr003.test.ts; the namespace is a REAL git repo
 * (per-namespace layout) so the as-of path reads actual history.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHttpServer } from "../../cli/http";
import { createServer, Server } from "http";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

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
const PARTITION = path.join(NS, "concept", "2026-07");
const JSONL = path.join(PARTITION, "current.jsonl");
const MANIFEST = path.join(NS, "manifest.json");

const D1 = "2026-07-01T10:00:00Z";
const D2 = "2026-08-01T10:00:00Z";

function git(dir: string, args: string, env?: Record<string, string>): string {
  return execSync(`git ${args}`, {
    cwd: dir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  })
    .toString()
    .trim();
}

function commitAll(msg: string, date: string): string {
  git(NS, "add -A");
  git(NS, `commit -qm "${msg}"`, {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return git(NS, "rev-parse HEAD");
}

function mem(id: string, key: string, timestamp: string, text: string): string {
  return JSON.stringify({
    id,
    key,
    domain: "concept",
    timestamp,
    author: "test@example.com",
    action: "add",
    embedding_text: text,
    attributes: {},
  });
}

let sha1: string;
let sha2: string;

describe("RETR-004: memory-as-of — GET /api/memories", () => {
  beforeAll(async () => {
    // Seed a REAL git-backed namespace: two commits, one memory each.
    fs.mkdirSync(PARTITION, { recursive: true });
    git(NS, "init -q");
    git(NS, 'config user.email "test@example.com"');
    git(NS, 'config user.name "Test"');

    fs.writeFileSync(
      JSONL,
      mem(
        "http-asof-1",
        "/httpasof/one",
        "2026-07-01T08:00:00.000Z",
        "http first memory",
      ) + "\n",
    );
    fs.writeFileSync(
      MANIFEST,
      JSON.stringify({
        partitions: ["concept/2026-07"],
        lastUpdated: new Date().toISOString(),
      }),
    );
    sha1 = commitAll("http first memory", D1);

    fs.writeFileSync(
      JSONL,
      mem(
        "http-asof-1",
        "/httpasof/one",
        "2026-07-01T08:00:00.000Z",
        "http first memory",
      ) +
        "\n" +
        mem(
          "http-asof-2",
          "/httpasof/two",
          "2026-07-20T08:00:00.000Z",
          "http second memory",
        ) +
        "\n",
    );
    sha2 = commitAll("http second memory", D2);

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
    fs.rmSync(NS, { recursive: true, force: true });
  });

  it("?as_of=<first commit> returns exactly the rows at that ref", async () => {
    const res = await httpRequest(
      "GET",
      `/api/memories?as_of=${sha1}&namespace=default&limit=50`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe("http-asof-1");
    expect(res.body.items[0].content).toBe("http first memory");
    expect(res.body.total).toBe(1);
  });

  it("?as_of=<second commit> returns both rows (current state)", async () => {
    const res = await httpRequest(
      "GET",
      `/api/memories?as_of=${sha2}&namespace=default&limit=50`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(2);
  });

  it("?as_of=<date> resolves to the nearest commit at-or-before it", async () => {
    const res = await httpRequest(
      "GET",
      "/api/memories?as_of=2026-07-15&namespace=default&limit=50",
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe("http-asof-1");
  });

  it("invalid ?as_of= returns a clean 400 VALIDATION_ERROR", async () => {
    const res = await httpRequest(
      "GET",
      "/api/memories?as_of=not-a-ref&namespace=default",
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.error).toMatch(/Invalid --as-of value/);
  });

  it("?as_of= combined with ?q= is rejected", async () => {
    const res = await httpRequest(
      "GET",
      `/api/memories?as_of=${sha1}&q=first&namespace=default`,
    );
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/as_of cannot be combined/);
  });

  it("current-state recall (no as_of) is unchanged and returns both rows", async () => {
    const res = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=50",
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });
});
