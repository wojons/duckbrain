/**
 * DOGFOOD-018 P0 Regression Tests: /activity over namespaces whose JSONL
 * contains duplicate keys inside `attributes` must NEVER abort the process.
 *
 * Root cause: activity.ts ran
 *   SELECT ... FROM read_json([...], format='newline_delimited')
 * with schema auto-inference — the LAST remaining auto-infer `attributes`
 * projection after DOGFOOD-010 fixed the ?q= semantic path (commit 471f3de).
 * Heterogeneous `attributes` objects get typed MAP(...); a record whose JSON
 * object contains duplicate keys then fails MAP conversion with
 * `duckdb::InvalidInputException: Map keys must be unique.` thrown from
 * native code. node-duckdb's RunPreparedTask::DoWork() (the db.all() path)
 * has no try/catch around Execute(), so the C++ throw escapes the libuv
 * worker thread → std::terminate → SIGABRT → the whole process dies. A JS
 * try/catch cannot intercept it.
 *
 * Fix (mirrors DOGFOOD-010 exactly): read_json with an explicit all-VARCHAR
 * column schema (attributes arrives as raw JSON text, never MAP) +
 * ignore_errors=true. The route's namespaces root is also resolved through
 * getConfig() so the test-suite DUCKBRAIN_NAMESPACES_PATH isolation (BUG-037)
 * applies here too — these tests build the poisoned namespace in a temp dir
 * and never touch the live namespaces/ tree.
 *
 * No embedding provider mock is needed: /activity never embeds — the crash
 * happens in the read_json scan itself.
 *
 * On the unfixed code the first /activity request SIGABRTs the whole vitest
 * worker — the suite dies mid-file, which IS the failing assertion.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHttpServer } from "../../cli/http";
import { createServer, Server } from "http";
import fs from "fs";
import os from "os";
import path from "path";

let server: Server;
let port: number;
let scratchDir: string;
let oldNamespacesPath: string | undefined;

interface HttpResponse {
  status: number;
  body: any;
}

function httpRequest(method: string, p: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const options: any = {
      hostname: "127.0.0.1",
      port,
      path: p,
      method,
      headers: { Host: "localhost", "Content-Type": "application/json" },
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

/**
 * Build a namespace whose JSONL would crash the unfixed reader (same data
 * shape as memories-dogfood010.test.ts):
 *  - attributes objects with 200+ DISTINCT keys across the file (DuckDB's
 *    map_inference_threshold default) — this forces read_json to type the
 *    column MAP(VARCHAR, VARCHAR) instead of a nullable STRUCT
 *  - one row whose `attributes` object contains DUPLICATE keys — written raw
 *    to the file, because JSON.stringify of a JS object can't express them
 *    (that is exactly how real-world external writers produced them)
 *  - a tombstone + same-id update pair to exercise the tombstone filter
 *
 * With MAP inference, the dup-key row makes DuckDB throw
 * `InvalidInputException: Map keys must be unique.` from MapVector verify —
 * a raw C++ exception on the data pass that node-duckdb does not catch
 * (SIGABRT).
 */
function buildPoisonedNamespace(nsDir: string): void {
  const partitions = [
    "concept/2026-06/",
    "event/2026-06/",
    "raw_note/2026-06/",
  ];
  fs.mkdirSync(path.join(nsDir, "concept", "2026-06"), { recursive: true });
  fs.mkdirSync(path.join(nsDir, "event", "2026-06"), { recursive: true });
  fs.mkdirSync(path.join(nsDir, "raw_note", "2026-06"), { recursive: true });
  fs.writeFileSync(
    path.join(nsDir, "manifest.json"),
    JSON.stringify({
      version: "1.0",
      createdAt: "2026-08-16T00:00:00.000Z",
      partitions,
      lastUpdated: "2026-08-16T00:00:00.000Z",
    }),
    "utf-8",
  );

  // 220 distinct attribute keys (>= map_inference_threshold 200) with
  // string values, so detection infers MAP(VARCHAR, VARCHAR).
  const KEYS = Array.from({ length: 220 }, (_, i) => `key_${i}`);
  const attrsFor = (i: number): string => {
    const start = (i * 7) % 200;
    const picked = KEYS.slice(start, start + 10);
    return `{${picked.map((k, j) => `"${k}":"v${(i + j) % 97}"`).join(",")}}`;
  };
  // The trigger: duplicate "key_0" inside one attributes object.
  const DUP_ATTRS = '{"key_0":"confirmed","key_1":"high","key_0":"dup-key"}';

  const row = (
    idx: number,
    id: string,
    key: string,
    domain: string,
    action: string,
    text: string,
    attrs: string,
  ) =>
    JSON.stringify({
      id,
      key,
      domain,
      timestamp: `2026-08-${String((idx % 9) + 1).padStart(2, "0")}T12:00:00.000Z`,
      author: "dogfood@test.local",
      action,
      embedding_text: text,
    }).slice(0, -1) + `,"attributes":${attrs}}\n`;

  let out = "";
  for (let i = 0; i < 300; i++) {
    const topic = i % 2 === 0 ? "alpha" : "beta";
    out += row(
      i,
      `d${i}`,
      `/${topic}/mem/${i}`,
      i % 3 === 0 ? "concept" : i % 3 === 1 ? "event" : "raw_note",
      "add",
      `${topic} memory number ${i}`,
      attrsFor(i),
    );
  }
  // Dup-key row (MAP already inferred across the file) + a normal sentinel
  // row — both pinned to the NEWEST timestamps so they survive the route's
  // ORDER BY timestamp DESC LIMIT window (the bulk rows use 2026-08-0x).
  const pinnedRow = (
    id: string,
    key: string,
    domain: string,
    text: string,
    attrs: string,
    ts: string,
  ) =>
    JSON.stringify({
      id,
      key,
      domain,
      timestamp: ts,
      author: "dogfood@test.local",
      action: "add",
      embedding_text: text,
    }).slice(0, -1) + `,"attributes":${attrs}}\n`;
  out += pinnedRow(
    "dup1",
    "/alpha/dup",
    "raw_note",
    "alpha dup row",
    DUP_ATTRS,
    "2026-08-16T12:00:00.000Z",
  );
  out += pinnedRow(
    "sentinel1",
    "/alpha/sentinel",
    "concept",
    "alpha sentinel row",
    attrsFor(42),
    "2026-08-16T11:00:00.000Z",
  );
  // Tombstone pair to exercise the `action != 'tombstone'` filter.
  out += row(
    302,
    "t1",
    "/beta/tomb",
    "event",
    "add",
    "beta tombstone target",
    attrsFor(301),
  );
  out += row(
    303,
    "t1",
    "/beta/tomb",
    "event",
    "tombstone",
    "beta tombstone target",
    '{"tombstone_reason":"test"}',
  );
  for (let i = 302; i < 320; i++) {
    out += row(
      i,
      `d${i}`,
      `/beta/mem/${i}`,
      "raw_note",
      "add",
      `beta memory number ${i}`,
      attrsFor(i),
    );
  }
  fs.writeFileSync(
    path.join(nsDir, "concept", "2026-06", "current.jsonl"),
    out,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(nsDir, "event", "2026-06", "current.jsonl"),
    out,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(nsDir, "raw_note", "2026-06", "current.jsonl"),
    out,
    "utf-8",
  );
}

describe("DOGFOOD-018: /activity survives duplicate-key attributes (no abort)", () => {
  beforeAll(async () => {
    scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-dogfood018-"),
    );
    oldNamespacesPath = process.env.DUCKBRAIN_NAMESPACES_PATH;
    process.env.DUCKBRAIN_NAMESPACES_PATH = scratchDir;
    buildPoisonedNamespace(path.join(scratchDir, "repro"));

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

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (oldNamespacesPath === undefined) {
      delete process.env.DUCKBRAIN_NAMESPACES_PATH;
    } else {
      process.env.DUCKBRAIN_NAMESPACES_PATH = oldNamespacesPath;
    }
    if (scratchDir) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("/activity over a duplicate-key namespace returns 200 and the server stays alive", async () => {
    const { status, body } = await httpRequest("GET", "/activity?limit=200");

    // 200 with an activities array OR a clean JSON error — NEVER an abort.
    if (status === 200) {
      expect(Array.isArray(body.activities)).toBe(true);
    } else {
      expect(typeof body.error).toBe("string");
      expect(body.code).toBeUndefined(); // clean error path, not a crash
    }

    // The process must still be alive and serving.
    const health = await httpRequest("GET", "/health");
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("healthy");
  });

  it("/activity returns the poisoned namespace's rows with parsed attributes", async () => {
    const { status, body } = await httpRequest("GET", "/activity?limit=200");

    expect(status).toBe(200);
    expect(Array.isArray(body.activities)).toBe(true);
    expect(body.activities.length).toBeGreaterThan(0);
    expect(body.count).toBe(body.activities.length);

    // The duplicate-key row itself must be served — its attributes arrive as
    // raw JSON text and are parsed in JS (duplicate keys collapse harmlessly
    // to the last occurrence per JSON.parse semantics).
    const dup = body.activities.find((a: any) => a.id === "dup1");
    expect(dup).toBeDefined();
    expect(dup.key).toBe("/alpha/dup");
    expect(dup.content).toBe("alpha dup row");
    expect(typeof dup.attributes).toBe("object");
    expect(dup.attributes.key_0).toBeDefined();
    expect(dup.attributes.key_1).toBe("high");

    // A normal row keeps its attributes too.
    const normal = body.activities.find((a: any) => a.id === "sentinel1");
    expect(normal).toBeDefined();
    expect(typeof normal.attributes).toBe("object");
    expect(Object.keys(normal.attributes).length).toBeGreaterThan(0);
  });

  it("/activity over an empty namespaces root returns 200 with an empty list", async () => {
    const emptyDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-dogfood018-empty-"),
    );
    const saved = process.env.DUCKBRAIN_NAMESPACES_PATH;
    process.env.DUCKBRAIN_NAMESPACES_PATH = emptyDir;
    try {
      const { status, body } = await httpRequest("GET", "/activity");
      expect(status).toBe(200);
      expect(body.activities).toEqual([]);
      expect(body.count).toBe(0);
    } finally {
      process.env.DUCKBRAIN_NAMESPACES_PATH = saved;
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }

    // Server still healthy after the empty-scan path.
    const health = await httpRequest("GET", "/health");
    expect(health.status).toBe(200);
  });
});
