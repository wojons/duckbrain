/**
 * DOGFOOD-011 Regression Tests: semantic search must apply a minimum
 * relevance threshold, expose scores over REST, and stay consistent across
 * the MCP recall path (same recallTool underneath).
 *
 * Previously ?q= ranked candidates but NEVER filtered — a garbage query
 * (e.g. q=zzznothing) returned every memory, so "search" could not say
 * "no match". Now candidates scoring below DEFAULT_MIN_SCORE (0.25) are
 * dropped in semanticSearch, and the surviving items carry their cosine
 * similarity as items[].score in the REST response.
 *
 * These tests run the REAL DuckDB path against a scratch namespace built in
 * the temp dir (DUCKBRAIN_NAMESPACES_PATH isolation — never touches the live
 * namespaces/ tree). Only the embedding provider is mocked (bag-of-words
 * vectors, so cosine similarity is MEANINGFUL: "alpha" matches texts
 * containing "alpha", scores 0 otherwise). The embedding cache is pre-seeded
 * for every candidate text so ranking covers the whole pool deterministically
 * regardless of candidate order or the on-the-fly embed cap.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHttpServer } from "../../cli/http";
import { createServer, Server } from "http";
import fs from "fs";
import os from "os";
import path from "path";
import type { EmbeddingProvider } from "../../embedding/providers";
import { EmbeddingCache } from "../../embedding/cache";
import { DEFAULT_MIN_SCORE } from "../../embedding/search";

// Shared by the mocked provider AND the pre-seeded cache, so vectors agree.
const { bowVector } = vi.hoisted(() => {
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
  return { bowVector };
});

// Mock ONLY the provider registry: recallTool must run its real DuckDB path.
vi.mock("../../embedding/providers", async () => {
  const actual = await vi.importActual<
    typeof import("../../embedding/providers")
  >("../../embedding/providers");
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
 * Build a namespace with two topical groups:
 *  - 8 "alpha" memories (text contains the word alpha)
 *  - 8 "beta" memories (text contains the word beta, never alpha)
 * Under the bag-of-words provider, q=alpha scores alpha texts ~0.5 and beta
 * texts 0.0; q=zzznothing (a word present in NO text) scores everything 0.0.
 */
function buildNamespace(nsDir: string): string[] {
  fs.mkdirSync(path.join(nsDir, "concept", "2026-06"), { recursive: true });
  fs.writeFileSync(
    path.join(nsDir, "manifest.json"),
    JSON.stringify({
      version: "1.0",
      createdAt: "2026-08-16T00:00:00.000Z",
      partitions: ["concept/2026-06/"],
      lastUpdated: "2026-08-16T00:00:00.000Z",
    }),
    "utf-8",
  );

  const texts: string[] = [];
  let out = "";
  for (let i = 0; i < 8; i++) {
    const text = `alpha memory number ${i}`;
    texts.push(text);
    out +=
      JSON.stringify({
        id: `da${i}`,
        key: `/alpha/mem/${i}`,
        domain: "concept",
        timestamp: `2026-08-01T00:00:0${i}.000Z`,
        author: "dogfood@test.local",
        action: "add",
        embedding_text: text,
        attributes: { source: "dogfood011" },
      }) + "\n";
  }
  for (let i = 0; i < 8; i++) {
    const text = `beta memory number ${i}`;
    texts.push(text);
    out +=
      JSON.stringify({
        id: `db${i}`,
        key: `/beta/mem/${i}`,
        domain: "concept",
        timestamp: `2026-08-02T00:00:0${i}.000Z`,
        author: "dogfood@test.local",
        action: "add",
        embedding_text: text,
        attributes: { source: "dogfood011" },
      }) + "\n";
  }
  fs.writeFileSync(
    path.join(nsDir, "concept", "2026-06", "current.jsonl"),
    out,
    "utf-8",
  );
  return texts;
}

describe("DOGFOOD-011: semantic search relevance threshold + scores", () => {
  beforeAll(async () => {
    scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-dogfood011-"),
    );
    oldNamespacesPath = process.env.DUCKBRAIN_NAMESPACES_PATH;
    process.env.DUCKBRAIN_NAMESPACES_PATH = scratchDir;

    const nsDir = path.join(scratchDir, "repro");
    const texts = buildNamespace(nsDir);

    // Pre-seed the embedding cache for EVERY candidate text under the mocked
    // provider id, so the whole pool is ranked (no dependence on candidate
    // order or the 10-embed on-the-fly cap).
    const cache = EmbeddingCache.forNamespace(nsDir);
    for (const text of texts) {
      cache.set("test/fake", EmbeddingCache.contentHash(text), bowVector(text));
    }

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

  it("(a) nonsense query returns 0 items — search can say 'no match'", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?q=zzznothing&namespace=repro",
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(0);
    expect(body.total).toBeGreaterThan(0); // the pool existed — it was filtered
  });

  it("(b) relevant query returns only the matching (above-threshold) memories", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?q=alpha&namespace=repro",
    );
    expect(status).toBe(200);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item.content).toMatch(/alpha/);
      expect(item.score).toBeGreaterThanOrEqual(DEFAULT_MIN_SCORE);
    }
  });

  it("(c) similarity scores are exposed on REST ?q= response items", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?q=alpha&namespace=repro&limit=3",
    );
    expect(status).toBe(200);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(typeof item.score).toBe("number");
      expect(item.score).toBeGreaterThan(0);
      expect(item.score).toBeLessThanOrEqual(1);
    }
  });

  it("plain listing (no ?q=) is unfiltered and carries no scores", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=repro&limit=10",
    );
    expect(status).toBe(200);
    // The full pool (16 rows) is listable without a query vector — no
    // threshold applies to plain enumeration.
    expect(body.items.length).toBe(10); // limit respected
    expect(body.total).toBeGreaterThanOrEqual(16);
    for (const item of body.items) {
      expect(item.score).toBeUndefined();
    }
  });

  it("DUCKBRAIN_SEARCH_MIN_SCORE env knob tightens the floor (MCP/REST shared path)", async () => {
    // alpha texts score ~0.5 under the bag-of-words provider; a 0.9 floor
    // must drop them all, proving the knob reaches semanticSearch via the
    // same recallTool used by MCP recall.
    const old = process.env.DUCKBRAIN_SEARCH_MIN_SCORE;
    try {
      process.env.DUCKBRAIN_SEARCH_MIN_SCORE = "0.9";
      const { status, body } = await httpRequest(
        "GET",
        "/api/memories?q=alpha&namespace=repro",
      );
      expect(status).toBe(200);
      expect(body.items.length).toBe(0);
    } finally {
      if (old === undefined) {
        delete process.env.DUCKBRAIN_SEARCH_MIN_SCORE;
      } else {
        process.env.DUCKBRAIN_SEARCH_MIN_SCORE = old;
      }
    }
  });
});
