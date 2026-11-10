/**
 * QA-DUCKBRAIN-023 regression tests: GET /api/keys folder `memoryCount` must
 * be the number of DISTINCT memory keys beneath a folder — not a sum of
 * nesting depths.
 *
 * Defect (pre-fix `src/utils/keyTree.ts`): the ancestor-count loop ran inside
 * the per-segment loop, so a key at depth N incremented every ancestor N
 * times. With /a/b/c, /a/b/d and /x/y the response reported /a=6, /a/b=4,
 * /x=2 instead of /a=2, /a/b=2, /x=1.
 *
 * Covers:
 *   AC1 — exact per-folder counts for a 3-level tree, independent of depth
 *         (a 5-level key is seeded alongside to prove depth does not scale
 *         the count).
 *   AC2 — this file IS the regression test: it fails at the pre-fix HEAD.
 *   AC3 — sum of root folder counts agrees with GET /api/memories `total`.
 *   AC4 — tree shape / ordering / schema untouched (leaves keep 1, folder
 *         remains a folder); the CLI text renderer prints no counts at all.
 *
 * Seeds a real namespace (JSONL partition + manifest) under the test-setup
 * temp root and exercises the full pipeline: route → listKeysTool → DuckDB.
 * Follows the httpRequest pattern from memories-pagination-gap024.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHttpServer } from "../../cli/http";
import { createServer, Server } from "http";
import fs from "fs";
import path from "path";
import { buildKeyTree } from "../../utils/keyTree";
import { renderKeyTreeText } from "../../utils/keyTree";

let server: Server;
let port: number;

interface HttpResponse {
  status: number;
  body: any;
}

function httpRequest(method: string, requestPath: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const options: any = {
      hostname: "127.0.0.1",
      port,
      path: requestPath,
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

// A namespace of our own: the shared test root is used by sibling suites that
// seed into "default", and exact-count assertions must not see their keys.
const NS_NAME = "qa023-depth";
const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const NS = path.join(NS_ROOT, NS_NAME);
const PARTITION = path.join(NS, "event", "2026-11");
const JSONL = path.join(PARTITION, "current.jsonl");
const MANIFEST = path.join(NS, "manifest.json");

// AC1 fixture: three levels. Plus one depth-5 key so "counts must not depend
// on nesting depth" is exercised in the same response.
const KEYS = ["/a/b/c", "/a/b/d", "/x/y", "/deep/1/2/3/4"];

function seedMemory(key: string, i: number) {
  return {
    id: crypto.randomUUID(),
    key,
    domain: "event",
    timestamp: `2026-11-10T00:00:0${i}.000Z`,
    author: "test@example.com",
    action: "add",
    content: `QA-023 seed ${key}`,
    embedding_text: `QA-023 seed ${key}`,
    attributes: {},
  };
}

/** Index the flattened tree by node path so assertions read on the wire data. */
function flatten(nodes: any[], into: Map<string, any> = new Map()): Map<string, any> {
  for (const node of nodes) {
    into.set(node.path, node);
    flatten(node.children ?? [], into);
  }
  return into;
}

describe("QA-DUCKBRAIN-023: /api/keys memoryCount counts distinct memories", () => {
  let flat: Map<string, any>;
  let keysBody: any;
  let memoriesTotal: number;

  beforeAll(async () => {
    // Seed a real namespace: JSONL partition + manifest (dogfood002 pattern).
    fs.mkdirSync(PARTITION, { recursive: true });
    const lines = KEYS.map((key, i) => JSON.stringify(seedMemory(key, i + 1)));
    fs.writeFileSync(JSONL, lines.join("\n") + "\n");
    fs.writeFileSync(
      MANIFEST,
      JSON.stringify({
        partitions: ["event/2026-11"],
        lastUpdated: new Date().toISOString(),
      }),
    );

    const app = createHttpServer({ authType: "none" });
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") port = addr.port;
        resolve();
      });
    });

    const keysRes = await httpRequest(
      "GET",
      `/api/keys?namespace=${NS_NAME}&limit=100`,
    );
    expect(keysRes.status).toBe(200);
    keysBody = keysRes.body;
    flat = flatten(keysBody.tree);

    const memRes = await httpRequest(
      "GET",
      `/api/memories?namespace=${NS_NAME}&limit=100`,
    );
    expect(memRes.status).toBe(200);
    memoriesTotal = memRes.body.total;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("AC1: reports distinct memories per folder, independent of depth", () => {
    // 3-level tree — the exact fixture from the defect report.
    expect(flat.get("/a")?.memoryCount).toBe(2);
    expect(flat.get("/a/b")?.memoryCount).toBe(2);
    expect(flat.get("/a/b/c")?.memoryCount).toBe(1);
    expect(flat.get("/a/b/d")?.memoryCount).toBe(1);
    expect(flat.get("/x")?.memoryCount).toBe(1);
    expect(flat.get("/x/y")?.memoryCount).toBe(1);
  });

  it("AC1: a 5-level key still counts once at every ancestor", () => {
    expect(flat.get("/deep")?.memoryCount).toBe(1);
    expect(flat.get("/deep/1")?.memoryCount).toBe(1);
    expect(flat.get("/deep/1/2")?.memoryCount).toBe(1);
    expect(flat.get("/deep/1/2/3")?.memoryCount).toBe(1);
    expect(flat.get("/deep/1/2/3/4")?.memoryCount).toBe(1);
  });

  it("AC3: root counts sum to GET /api/memories total", () => {
    expect(memoriesTotal).toBe(KEYS.length);
    const rootSum = keysBody.tree.reduce(
      (acc: number, node: any) => acc + (node.memoryCount ?? 0),
      0,
    );
    expect(rootSum).toBe(memoriesTotal);
  });

  it("AC4: tree shape and ordering are unchanged", () => {
    // Roots stay alphabetically ordered and typed: folders for prefixes,
    // memory for leaves — no schema or shape change.
    expect(keysBody.tree.map((n: any) => n.path)).toEqual([
      "/a",
      "/deep",
      "/x",
    ]);
    expect(keysBody.tree.map((n: any) => n.type)).toEqual([
      "folder",
      "folder",
      "folder",
    ]);
    expect(flat.get("/a/b/c")?.type).toBe("memory");
    expect(flat.get("/a")?.children.map((c: any) => c.path)).toEqual(["/a/b"]);

    // AC4: the human CLI renderer prints paths only — no counts anywhere.
    const text = renderKeyTreeText(keysBody.tree);
    expect(text).toContain("/a/");
    expect(text).not.toMatch(/memoryCount|\(2\)|: 2/);
  });
});

describe("QA-DUCKBRAIN-023: buildKeyTree counts distinct keys once each", () => {
  it("does not double count a key repeated in the flat list", () => {
    // listKeysTool already GROUPs BY key, but the builder is also used
    // directly (CLI + MCP surfaces) — the count is documented as DISTINCT
    // memory keys, so a repeated key must not inflate its ancestors.
    const tree = buildKeyTree(["/a/b/c", "/a/b/c", "/a/b/d"]);
    const flat = flatten(tree);
    expect(flat.get("/a")?.memoryCount).toBe(2);
    expect(flat.get("/a/b")?.memoryCount).toBe(2);
    expect(flat.get("/a/b/c")?.memoryCount).toBe(1);
  });

  it("counts a key that is also a folder prefix", () => {
    const tree = buildKeyTree(["/a/b", "/a/b/c"]);
    const flat = flatten(tree);
    expect(flat.get("/a")?.memoryCount).toBe(2);
    expect(flat.get("/a/b")?.memoryCount).toBe(2);
    expect(flat.get("/a/b/c")?.memoryCount).toBe(1);
  });

  it("empty folders keep 0 and an empty tree stays empty", () => {
    expect(buildKeyTree([])).toEqual([]);
    const flat = flatten(buildKeyTree(["/a/b/c"]));
    expect(flat.get("/a")?.memoryCount).toBe(1);
    expect(flat.get("/a/b")?.memoryCount).toBe(1);
  });
});
