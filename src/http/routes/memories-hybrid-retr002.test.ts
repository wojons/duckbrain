/**
 * RETR-002 End-to-End Tests: hybrid recall (?q= = RRF fusion of the
 * keyword FTS leg + the embedding-cosine leg).
 *
 * Full stack: HTTP route → recallTool → (semanticSearch | keywordSearch)
 * → rankFused, against a REAL rebuilt FTS sidecar and a REAL DuckDB
 * namespace under the DUCKBRAIN_NAMESPACES_PATH temp root. Only the
 * embedding provider is mocked (bag-of-words vectors, so cosine
 * similarity is MEANINGFUL and deterministic); the embedding cache is
 * pre-seeded for every candidate text so ranking never depends on the
 * on-the-fly embed cap.
 *
 * The 20-query fixture has three families:
 *   10 dual-leg queries ("alpha ocean".."alpha tundra") — both retrievers
 *      find the relevant doc (hybrid, semantic and keyword all MRR 1.0)
 *    5 keyword-only queries ("kbox-01".."kbox-05") — the relevant doc's
 *      token lives in its KEY only, so the semantic leg (embedding_text
 *      only) misses it entirely (cosine 0 < 0.25 floor)
 *    5 stopword queries ("the","and","or","of","for") — all query tokens
 *      are FTS stopwords, so the keyword leg finds nothing while the
 *      semantic leg still matches
 *
 * Expected mean reciprocal rank over the fixture:
 *   hybrid   20/20 = 1.00   (each query's relevant doc is found)
 *   semantic 15/20 = 0.75   (misses the 5 keyword-only queries)
 *   keyword  15/20 = 0.75   (misses the 5 stopword queries)
 * ⇒ hybrid strictly beats both single-retriever modes.
 *
 * Also covers the fallback ladder: missing FTS index → semantic-only with
 * the unchanged cosine score shape (0.25 floor intact); no embedding
 * provider → keyword-only; both unavailable → the legacy semantic error
 * (never a silent unfiltered list).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHttpServer } from "../../cli/http";
import { createServer, Server } from "http";
import fs from "fs";
import path from "path";
import { recallTool } from "../../mcp/tools/recall";
import { createAutoProviders } from "../../embedding/providers";
import type { EmbeddingProvider } from "../../embedding/providers";
import { EmbeddingCache } from "../../embedding/cache";
import { rebuildNamespaceIndex } from "../../search/index";

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

// Mock ONLY the provider registry: recallTool must run its real DuckDB +
// FTS sidecar path.
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

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const NS_NAME = "hybrid-retr002";
const NS = path.join(NS_ROOT, NS_NAME);
const SEARCH_DIR = path.join(NS, ".search");
const SEARCH_ASIDE = path.join(NS, ".search.retr002-aside");
const PARTITION = path.join(NS, "concept", "2026-08");
const JSONL = path.join(PARTITION, "current.jsonl");
const MANIFEST = path.join(NS, "manifest.json");

// Topic words for family A. Chosen to be bag-of-words COLLISION-FREE:
// hash(word) % 384 must be unique per word and must not collide with any
// other fixture word's hash (a collision would tie two docs at rank 1 and
// make the semantic order depend on candidate fetch order instead of the
// fixture's intended math). Verified by script before committing.
const WORDS = [
  "ocean",
  "river",
  "mountain",
  "forest",
  "desert",
  "valley",
  "canyon",
  "meadow",
  "lagoon",
  "tundra",
];

interface FixtureDoc {
  id: string;
  key: string;
  text: string;
  day: number;
}

function buildFixtureDocs(): FixtureDoc[] {
  const docs: FixtureDoc[] = [];
  // Family A: dual-leg queries — "alpha <word>" finds doc a<i> in both legs.
  WORDS.forEach((w, i) => {
    docs.push({
      id: `a${i + 1}`,
      key: `/alpha/${w}`,
      text: `alpha ${w} discussion`,
      day: i + 1,
    });
  });
  // Family B: keyword-only — the query token lives in the KEY, never in
  // the embedding text, so semantic misses these (cosine 0 < 0.25 floor).
  for (let i = 0; i < 5; i++) {
    docs.push({
      id: `k${i + 1}`,
      key: `/kbox-0${i + 1}/entry`,
      text: "unrelated filler words",
      day: 11 + i,
    });
  }
  // Family C: stopword queries — every query token is an FTS stopword, so
  // the keyword leg finds nothing while semantic still matches.
  const stopwordDocs: Array<[string, string, string]> = [
    ["s1", "/stop/the", "the quarterly review"],
    ["s2", "/stop/and", "pandas and numpy"],
    ["s3", "/stop/or", "stay or go"],
    ["s4", "/stop/of", "cup of tea"],
    ["s5", "/stop/for", "wait for me"],
  ];
  stopwordDocs.forEach(([id, key, text], i) => {
    docs.push({ id, key, text, day: 16 + i });
  });
  return docs;
}

const DOCS = buildFixtureDocs();

const QUERIES: { q: string; relevant: string[] }[] = [
  ...WORDS.map((w, i) => ({ q: `alpha ${w}`, relevant: [`a${i + 1}`] })),
  ...[1, 2, 3, 4, 5].map((n) => ({ q: `kbox-0${n}`, relevant: [`k${n}`] })),
  { q: "the", relevant: ["s1"] },
  { q: "and", relevant: ["s2"] },
  { q: "or", relevant: ["s3"] },
  { q: "of", relevant: ["s4"] },
  { q: "for", relevant: ["s5"] },
];

function timestampFor(day: number): string {
  return `2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`;
}

function mrr(ids: string[], relevant: Set<string>): number {
  for (let i = 0; i < ids.length; i++) {
    if (relevant.has(ids[i])) return 1 / (i + 1);
  }
  return 0;
}

function average(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

let server: Server;
let port: number;

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

function hideIndex(): void {
  if (fs.existsSync(SEARCH_DIR)) fs.renameSync(SEARCH_DIR, SEARCH_ASIDE);
}

function restoreIndex(): void {
  if (fs.existsSync(SEARCH_ASIDE)) fs.renameSync(SEARCH_ASIDE, SEARCH_DIR);
}

describe("RETR-002: hybrid ?q= — RRF fusion beats single retrievers", () => {
  beforeAll(async () => {
    // The host environment must not tighten the semantic floor out from
    // under the fixture (DUCKBRAIN_SEARCH_MIN_SCORE is a live-daemon knob).
    delete process.env.DUCKBRAIN_SEARCH_MIN_SCORE;

    fs.mkdirSync(PARTITION, { recursive: true });
    fs.writeFileSync(
      JSONL,
      DOCS.map((d) =>
        JSON.stringify({
          id: d.id,
          key: d.key,
          domain: "concept",
          timestamp: timestampFor(d.day),
          author: "retr002@test.local",
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

    // Pre-seed the embedding cache for every candidate text under the
    // mocked provider id — deterministic ranking, no on-the-fly embeds.
    const cache = EmbeddingCache.forNamespace(NS);
    for (const d of DOCS) {
      cache.set(
        "test/fake",
        EmbeddingCache.contentHash(d.text),
        bowVector(d.text),
      );
    }

    // Real rebuilt FTS sidecar (the RETR-001 keyword leg).
    await rebuildNamespaceIndex(NS);

    const app = createHttpServer();
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
    restoreIndex();
    if (server) server.close();
    fs.rmSync(NS, { recursive: true, force: true });
  });

  it("hybrid beats semantic-only and keyword-only on the 20-query fixture (MRR)", async () => {
    const hybrid: number[] = [];
    const semantic: number[] = [];
    const keyword: number[] = [];

    for (const q of QUERIES) {
      const relevant = new Set(q.relevant);
      const enc = encodeURIComponent(q.q);

      // Hybrid: index present, provider available.
      const hy = await httpRequest(
        "GET",
        `/api/memories?q=${enc}&namespace=${NS_NAME}&limit=10`,
      );
      hybrid.push(mrr(hy.body.items?.map((i: any) => i.id) ?? [], relevant));

      // Semantic-only: hide the FTS sidecar — recall degrades exactly as
      // it would on a namespace that never ran `search-index rebuild`.
      try {
        hideIndex();
        const se = await httpRequest(
          "GET",
          `/api/memories?q=${enc}&namespace=${NS_NAME}&limit=10`,
        );
        semantic.push(
          mrr(se.body.items?.map((i: any) => i.id) ?? [], relevant),
        );
      } finally {
        restoreIndex();
      }

      // Keyword-only: the contains= path (same keywordSearch leg).
      const kw = await httpRequest(
        "GET",
        `/api/memories?contains=${enc}&namespace=${NS_NAME}&limit=10`,
      );
      keyword.push(mrr(kw.body.items?.map((i: any) => i.id) ?? [], relevant));
    }

    // Exact expectations from the fixture construction.
    expect(average(hybrid)).toBe(1);
    expect(average(semantic)).toBe(0.75);
    expect(average(keyword)).toBe(0.75);
    // The acceptance criterion: hybrid ≥ both, strictly on at least one.
    expect(average(hybrid)).toBeGreaterThan(average(semantic));
    expect(average(hybrid)).toBeGreaterThan(average(keyword));
    // Per-query: hybrid never does worse than either single retriever.
    QUERIES.forEach((_, i) => {
      expect(hybrid[i]).toBeGreaterThanOrEqual(semantic[i]);
      expect(hybrid[i]).toBeGreaterThanOrEqual(keyword[i]);
    });
  }, 60000);

  it("?q= returns fused RRF scores (not cosine/BM25) with keyword snippets", async () => {
    const { status, body } = await httpRequest(
      "GET",
      `/api/memories?q=alpha%20ocean&namespace=${NS_NAME}&limit=3`,
    );
    expect(status).toBe(200);
    expect(body.items).toHaveLength(3);
    const [a1, a2, a3] = body.items;
    // a1 is rank #1 in BOTH retrievers → normalized fused score 1.0.
    expect(a1.id).toBe("a1");
    expect(a1.score).toBe(1);
    expect(a1.snippet).toContain("alpha ocean");
    expect(a1.content).toBe("alpha ocean discussion");
    // a2/a3 come from the semantic leg only (ranks #2/#3 there, absent
    // from the keyword top-k): fused scores (1/62)/(2/61) = 61/124 and
    // (1/63)/(2/61) = 61/126. The exact ids in the rank-2/3 slots depend
    // on the semantic candidate tie order, so assert the fused scores.
    expect(a2.score).toBeCloseTo(61 / 124, 10);
    expect(a3.score).toBeCloseTo(61 / 126, 10);
    // Total = the fused candidate pool (union of both legs' top-k).
    expect(body.total).toBe(10);
  });

  it("recallTool (MCP surface) carries the fused score + snippet", async () => {
    const result = await recallTool({
      query: "alpha ocean",
      namespace: NS_NAME,
      limit: 10,
    });
    expect(result.error).toBeUndefined();
    expect(result.memories[0].id).toBe("a1");
    expect(result.memories[0].score).toBe(1);
    expect(typeof result.memories[0].snippet).toBe("string");
    expect(result.total).toBe(10);
  });

  it("keyword-only fixtures fuse from the keyword leg alone (semantic finds nothing)", async () => {
    const { status, body } = await httpRequest(
      "GET",
      `/api/memories?q=kbox-01&namespace=${NS_NAME}&limit=10`,
    );
    expect(status).toBe(200);
    expect(body.items[0].id).toBe("k1");
    // Semantic leg contributed nothing (below the 0.25 floor), so the
    // keyword rank-1 contribution normalizes to 1.0.
    expect(body.items[0].score).toBe(1);
    expect(body.items[0].snippet).toContain("kbox-01");
    expect(body.total).toBe(1);
  });

  it("stopword queries fuse from the semantic leg alone (keyword finds nothing)", async () => {
    const { status, body } = await httpRequest(
      "GET",
      `/api/memories?q=the&namespace=${NS_NAME}&limit=10`,
    );
    expect(status).toBe(200);
    expect(body.items[0].id).toBe("s1");
    expect(body.items[0].score).toBe(1);
    // No keyword hit → no snippet on the semantic-only candidate.
    expect(body.items[0].snippet).toBeUndefined();
    expect(body.total).toBe(1);
  });

  it("a garbage query returns no match in hybrid mode (floor still filters)", async () => {
    const { status, body } = await httpRequest(
      "GET",
      `/api/memories?q=zzznothing&namespace=${NS_NAME}&limit=10`,
    );
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("missing FTS index → semantic-only fallback with cosine scores (regression-safe)", async () => {
    try {
      hideIndex();
      const { status, body } = await httpRequest(
        "GET",
        `/api/memories?q=alpha%20ocean&namespace=${NS_NAME}&limit=10`,
      );
      expect(status).toBe(200);
      expect(body.items[0].id).toBe("a1");
      // Cosine similarity of "alpha ocean" vs "alpha ocean discussion" under
      // bag-of-words: 2/sqrt(2*3) — NOT the fused 1.0.
      expect(body.items[0].score).toBeCloseTo(2 / Math.sqrt(6), 5);
      // Semantic-only items carry no snippet.
      expect(body.items[0].snippet).toBeUndefined();
      // GAP-024: total = the semantic candidate pool (20 docs).
      expect(body.total).toBe(20);
    } finally {
      restoreIndex();
    }
  });

  it("no embedding provider → ?q= degrades to keyword-only (offline)", async () => {
    vi.mocked(createAutoProviders).mockResolvedValueOnce([]);
    const { status, body } = await httpRequest(
      "GET",
      `/api/memories?q=kbox-01&namespace=${NS_NAME}&limit=10`,
    );
    expect(status).toBe(200);
    expect(body.items[0].id).toBe("k1");
    expect(body.items[0].snippet).toContain("kbox-01");
    expect(typeof body.items[0].score).toBe("number");
    expect(body.items[0].score).toBeGreaterThan(0);
  });

  it("both legs unavailable → the legacy semantic error (never a silent list)", async () => {
    vi.mocked(createAutoProviders).mockResolvedValueOnce([]);
    try {
      hideIndex();
      const { status, body } = await httpRequest(
        "GET",
        `/api/memories?q=alpha%20ocean&namespace=${NS_NAME}&limit=10`,
      );
      expect(status).toBe(500);
      expect(body.error).toContain(
        "Semantic search requires an embedding provider",
      );
    } finally {
      restoreIndex();
    }
  });
});
