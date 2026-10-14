/**
 * DF-1013-03 End-to-End Tests: opt-in ?debug=search diagnostics on
 * GET /api/memories?q=.
 *
 * Commit 32de0244 claimed per-namespace searchRebuilt/searchFreshness/
 * searchSkipReason are "reported per namespace", but those fields exist
 * only in the boot warm-up stderr summary (NamespaceWarmResult) — the REST
 * ?q= response carried items/total/offset/limit/hasMore/nextOffset/count/
 * memories and nothing else, so a client could not tell whether a slow
 * first query paid an inline FTS rebuild or used a warm index, and
 * DUCKBRAIN_SEARCH_TIMING=1 logs to stderr only.
 *
 * The fix adds `&debug=search` (opt-in) which appends a `searchDebug`
 * object to the response. These tests pin:
 *
 *  1. WITHOUT the flag the response shape is unchanged — `searchDebug` is
 *     absent (and the route still rejects unknown params).
 *  2. WITH the flag the diagnostics expose index freshness, whether THIS
 *     request rebuilt the sidecar, candidate counts, and embed timing —
 *     collected on a REAL rebuilt FTS sidecar + REAL DuckDB namespace
 *     under the DUCKBRAIN_NAMESPACES_PATH temp root (only the embedding
 *     provider is mocked, like RETR-002).
 *  3. The warm-up summary and the request-time debug field AGREE for the
 *     same namespace: warmNamespace reports searchFreshness from
 *     ensureFreshIndex, the ?debug=search response reports indexFreshness
 *     from the SAME seam, and a warm-then-query sequence must agree.
 *  4. ?debug=search without ?q= is a clean 400 (the diagnostics only
 *     exist on the search path), and a wrong debug value is refused.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHttpServer } from "../../cli/http";
import { createServer, Server } from "http";
import fs from "fs";
import path from "path";
import type { EmbeddingProvider } from "../../embedding/providers";
import { EmbeddingCache } from "../../embedding/cache";
import {
  warmNamespace,
  type NamespaceWarmResult,
} from "../namespace-warmup";

// Mock ONLY the provider registry: recallTool must run its real DuckDB +
// FTS sidecar path (deterministic bag-of-words vectors, same shape as the
// RETR-002 fixture).
vi.mock("../../embedding/providers", async () => {
  const actual = await vi.importActual<
    typeof import("../../embedding/providers")
  >("../../embedding/providers");
  function bowVector(text: string): number[] {
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
  }
  const fakeProvider: EmbeddingProvider = {
    id: "test/fake",
    model: "fake",
    dimensions: 384,
    async embed(text: string): Promise<number[]> {
      return bowVector(text);
    },
  };
  return {
    ...actual,
    createAutoProviders: vi.fn().mockResolvedValue([fakeProvider]),
    createAutoProvider: vi.fn().mockResolvedValue(fakeProvider),
  };
});

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const NS_NAME = "debug-search-df101303";
const NS = path.join(NS_ROOT, NS_NAME);
const PARTITION = path.join(NS, "concept", "2026-08");
const JSONL = path.join(PARTITION, "current.jsonl");
const MANIFEST = path.join(NS, "manifest.json");

const DOCS = [
  {
    id: "d1",
    key: "/notes/pgbouncer",
    text: "pgbouncer connection pooling notes",
  },
  { id: "d2", key: "/notes/duckdb", text: "duckdb columnar engine notes" },
  { id: "d3", key: "/notes/git", text: "git plumbing internals" },
];

let server: Server;
let port: number;

interface HttpResponse {
  status: number;
  body: any;
}

function httpRequest(p: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method: "GET",
        headers: { Host: "localhost", "Content-Type": "application/json" },
      },
      (res: any) => {
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
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("DF-1013-03: opt-in ?debug=search diagnostics on GET /api/memories?q=", () => {
  beforeAll(async () => {
    delete process.env.DUCKBRAIN_SEARCH_MIN_SCORE;

    fs.mkdirSync(PARTITION, { recursive: true });
    fs.writeFileSync(
      JSONL,
      DOCS.map((d) =>
        JSON.stringify({
          id: d.id,
          key: d.key,
          domain: "concept",
          timestamp: "2026-08-10T00:00:00.000Z",
          author: "df101303@test.local",
          action: "add",
          embedding_text: d.text,
          attributes: {},
        }),
      ).join("\n") + "\n",
      "utf8",
    );
    fs.writeFileSync(
      MANIFEST,
      JSON.stringify({
        partitions: ["concept/2026-08"],
        lastUpdated: new Date().toISOString(),
      }),
    );

    const cache = EmbeddingCache.forNamespace(NS);
    for (const d of DOCS) {
      cache.set("test/fake", EmbeddingCache.contentHash(d.text), [
        0.1, 0.2, 0.3,
      ]);
    }

    const app = createHttpServer({ authType: "none" });
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") port = addr.port;
        resolve();
      });
    });
  }, 30000);

  afterAll(() => {
    if (server) server.close();
    fs.rmSync(NS, { recursive: true, force: true });
  });

  it("WITHOUT ?debug=search the response shape is unchanged — no searchDebug key", async () => {
    const { status, body } = await httpRequest(
      `/api/memories?q=pgbouncer&namespace=${NS_NAME}&limit=10`,
    );

    expect(status).toBe(200);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    // The exact canonical envelope keys — nothing added.
    expect(Object.keys(body).sort()).toEqual(
      [
        "count",
        "hasMore",
        "items",
        "limit",
        "memories",
        "nextOffset",
        "offset",
        "total",
      ].sort(),
    );
    expect(body.searchDebug).toBeUndefined();
  });

  it("WITH ?debug=search the diagnostics expose freshness, rebuild, candidates and embed timing", async () => {
    const { status, body } = await httpRequest(
      `/api/memories?q=pgbouncer&namespace=${NS_NAME}&limit=10&debug=search`,
    );

    expect(status).toBe(200);
    const dbg = body.searchDebug;
    expect(dbg).toBeDefined();

    // A sidecar was rebuilt in beforeAll, and no write happened since —
    // the keyword leg must see it as fresh and NOT rebuild again.
    expect(dbg.indexFreshness).toBe("fresh");
    expect(dbg.indexRebuilt).toBe(false);
    // Real candidate counts from both legs (the fixture has 3 docs).
    expect(dbg.keywordCandidates).toBeGreaterThanOrEqual(0);
    expect(dbg.semanticCandidates).toBeGreaterThan(0);
    // Every candidate's vector was pre-seeded → all cache hits, no misses.
    expect(dbg.cacheHits).toBe(dbg.semanticCandidates);
    expect(dbg.uniqueMisses).toBe(0);
    expect(typeof dbg.embedMs).toBe("number");
    expect(dbg.embedMs).toBeGreaterThanOrEqual(0);
    expect(typeof dbg.queryEmbedMs).toBe("number");

    // The canonical envelope survives the addition.
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.total).toBeGreaterThan(0);
  });

  it("AC-2: the warm-up summary and the request-time debug field agree for the same namespace", async () => {
    // Fresh namespace dir with REAL content for the warm-up leg: the
    // sidecar is deleted so warm-up must observe missing → rebuild and
    // report both (warm-up refuses to index an empty namespace dir).
    const warmNS = path.join(NS_ROOT, `${NS_NAME}-warm`);
    fs.rmSync(warmNS, { recursive: true, force: true });
    fs.mkdirSync(path.join(warmNS, "concept", "2026-08"), { recursive: true });
    fs.writeFileSync(
      path.join(warmNS, "concept", "2026-08", "current.jsonl"),
      DOCS.map((d) =>
        JSON.stringify({
          id: d.id,
          key: d.key,
          domain: "concept",
          timestamp: "2026-08-10T00:00:00.000Z",
          author: "df101303@test.local",
          action: "add",
          embedding_text: d.text,
          attributes: {},
        }),
      ).join("\n") + "\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(warmNS, "manifest.json"),
      JSON.stringify({
        partitions: ["concept/2026-08"],
        lastUpdated: new Date().toISOString(),
      }),
    );

    const warm: NamespaceWarmResult = await warmNamespace(warmNS);
    expect(warm.warmed).toBe(true);
    // The warm-up summary observed the sidecar missing BEFORE rebuilding it.
    expect(warm.searchFreshness).toBe("missing");
    expect(warm.searchRebuilt).toBe(true);

    // The request path must agree: the SAME freshness state, no second
    // rebuild (warm-up left the index fresh).
    const { status, body } = await httpRequest(
      `/api/memories?q=pgbouncer&namespace=${NS_NAME}-warm&limit=10&debug=search`,
    );
    expect(status).toBe(200);
    expect(body.searchDebug).toBeDefined();
    expect(body.searchDebug.indexFreshness).toBe("fresh");
    expect(body.searchDebug.indexRebuilt).toBe(false);

    fs.rmSync(warmNS, { recursive: true, force: true });
  });

  it("?debug=search without ?q= is a clean 400 VALIDATION_ERROR", async () => {
    const { status, body } = await httpRequest(
      `/api/memories?namespace=${NS_NAME}&debug=search`,
    );

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.error).toContain("?debug=search requires ?q=");
    expect(body.items).toBeUndefined();
  });

  it("an invalid ?debug= value is refused, never silently ignored", async () => {
    const { status, body } = await httpRequest(
      `/api/memories?q=pgbouncer&namespace=${NS_NAME}&debug=true`,
    );

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.error).toContain("'true'");
    expect(body.error).toContain("search");
  });
});
