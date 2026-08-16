/**
 * DOGFOOD-010 P0 Regression Tests: ?q= over a populated namespace whose JSONL
 * contains duplicate keys inside `attributes` must NEVER abort the process.
 *
 * Root cause: recall's semantic path runs
 *   SELECT ... FROM read_json([...], format='newline_delimited')
 * with schema auto-inference. Heterogeneous `attributes` objects get typed
 * MAP(...); a record whose JSON object contains duplicate keys then fails MAP
 * conversion with `duckdb::InvalidInputException: Map keys must be unique.`
 * thrown from native code. node-duckdb's RunPreparedTask::DoWork() (the
 * db.all() path) has no try/catch around Execute(), so the C++ throw escapes
 * the libuv worker thread → std::terminate → SIGABRT → the whole process dies
 * (verified: 5 systemd restarts in ~2 min on the live daemon). A JS try/catch
 * cannot intercept it.
 *
 * Fix: read_json with an explicit all-VARCHAR column schema (attributes
 * arrives as raw JSON text, never MAP) + ignore_errors=true, a bounded
 * candidate pool + timeout on the semantic path, and write-path
 * canonicalization of attributes.
 *
 * These tests run the REAL DuckDB path against a scratch namespace built in
 * the temp dir (DUCKBRAIN_NAMESPACES_PATH isolation — never touches the live
 * namespaces/ tree). Only the embedding provider is mocked: the crash happens
 * in the candidate fetch BEFORE any embedding of results, so a fake provider
 * that returns a fixed vector exercises the full pipeline.
 *
 * On the unfixed code the first ?q= request SIGABRTs the whole vitest worker
 * — the suite dies mid-file, which IS the failing assertion.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import { createHttpServer } from "../../cli/http";
import { createServer, Server } from "http";
import fs from "fs";
import os from "os";
import path from "path";
import type { EmbeddingProvider } from "../../embedding/providers";

// Mock ONLY the provider registry: recallTool must run its real DuckDB path.
vi.mock("../../embedding/providers", async () => {
  const actual = await vi.importActual<typeof import("../../embedding/providers")>(
    "../../embedding/providers",
  );
  const fakeProvider: EmbeddingProvider = {
    id: "test/fake",
    model: "fake",
    dimensions: 384,
    // Bag-of-words vectors: each word sets one dimension. This makes cosine
    // similarity MEANINGFUL (query "alpha" ranks texts containing "alpha"
    // above texts that don't) so the test can assert real ranking behavior,
    // not just "no crash".
    async embed(text: string): Promise<number[]> {
      const vec = new Array<number>(384).fill(0);
      const words = text.toLowerCase().split(/\W+/).filter(Boolean);
      for (const w of words) {
        let h = 0;
        for (let i = 0; i < w.length; i++) {
          h = (h * 31 + w.charCodeAt(i)) >>> 0;
        }
        vec[h % 384] = 1;
      }
      return vec;
    },
  };
  return {
    ...actual,
    createAutoProviders: vi.fn().mockResolvedValue([fakeProvider]),
    createAutoProvider: vi.fn().mockResolvedValue(fakeProvider),
  };
});

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
 * Build a namespace whose JSONL would crash the unfixed reader:
 *  - attributes objects with 200+ DISTINCT keys across the file (DuckDB's
 *    map_inference_threshold default) — this forces read_json to type the
 *    column MAP(VARCHAR, VARCHAR) instead of a nullable STRUCT
 *  - one row whose `attributes` object contains DUPLICATE keys — written raw
 *    to the file, because JSON.stringify of a JS object can't express them
 *    (that is exactly how real-world external writers produced them)
 *  - a tombstone + same-id update pair to exercise the dedup window function
 *
 * With MAP inference, the dup-key row makes DuckDB throw
 * `InvalidInputException: Map keys must be unique.` from MapVector verify —
 * a raw C++ exception on the data pass that node-duckdb does not catch
 * (SIGABRT). Verified against the real hermes-memory trigger (hundreds of
 * free-form attribute keys) and reproduced here with synthetic data.
 */
function buildPoisonedNamespace(nsDir: string): void {
  const partitions = ["concept/2026-06/", "event/2026-06/", "raw_note/2026-06/"];
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
  // Dup-key row (line ~301, MAP already inferred across the file).
  out += row(301, "dup1", "/alpha/dup", "raw_note", "add", "alpha dup row", DUP_ATTRS);
  // Tombstone + revive pair to exercise the ROW_NUMBER dedup window.
  out += row(302, "t1", "/beta/tomb", "event", "add", "beta tombstone target", attrsFor(301));
  out += row(303, "t1", "/beta/tomb", "event", "tombstone", "beta tombstone target", '{"tombstone_reason":"test"}');
  for (let i = 302; i < 320; i++) {
    out += row(i, `d${i}`, `/beta/mem/${i}`, "raw_note", "add", `beta memory number ${i}`, attrsFor(i));
  }
  fs.writeFileSync(path.join(nsDir, "concept", "2026-06", "current.jsonl"), out, "utf-8");
  fs.writeFileSync(path.join(nsDir, "event", "2026-06", "current.jsonl"), out, "utf-8");
  fs.writeFileSync(path.join(nsDir, "raw_note", "2026-06", "current.jsonl"), out, "utf-8");
}

describe("DOGFOOD-010: ?q= survives duplicate-key attributes (no abort)", () => {
  beforeAll(async () => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-dogfood010-"));
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

  it("?q= over a duplicate-key namespace returns 200 or a clean error and the server stays alive", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?q=alpha&namespace=repro",
    );

    // 200 with ranked results OR a clean JSON error — NEVER an abort.
    if (status === 200) {
      expect(Array.isArray(body.items)).toBe(true);
    } else {
      expect(typeof body.error).toBe("string");
      expect(body.code).toBeUndefined(); // clean error path, not a crash
    }

    // The process must still be alive and serving.
    const health = await httpRequest("GET", "/health");
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("healthy");
  });

  it("?q= with a valid query still returns ranked results when embeddings are available", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?q=alpha&namespace=repro&limit=5",
    );

    expect(status).toBe(200);
    expect(body.items.length).toBeGreaterThan(0);
    // Ranked results: the bag-of-words provider ranks texts containing the
    // query term ("alpha") above texts that don't, so the top hit must be an
    // alpha memory — proving semantic ranking still works on this namespace.
    expect(body.items[0].content).toMatch(/alpha/);
    expect(body.total).toBeGreaterThanOrEqual(body.items.length);
  });

  it("no-q requests are unchanged (plain list still works on the same namespace)", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=repro&limit=10",
    );

    expect(status).toBe(200);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0].content).toBeTruthy();
  });
});
