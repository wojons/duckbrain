/**
 * DF-0926-03 Regression Tests: ?contains=<stopword> must find content
 * stored verbatim.
 *
 * "hello", "from", "different" are members of FTS_STOPWORDS (stopwords.ts
 * dumps the DuckDB FTS extension's default English stopword list), so
 * dropStopwords removes them from the query side to keep the query token
 * set aligned with the tokens the FTS index stored. Before the fix a
 * stopword-only query produced NO candidate pass at all: the FTS block is
 * guarded by `ftsTokens.length > 0` and the prefix pass only runs on a
 * trailing `*` — so ?contains=Hello returned total 0 while
 * ?contains=zebra (not a stopword) hit. Deterministic per-term, exactly
 * the board row's observed pattern (Hello/from/different → 0; zebra hit).
 *
 * The fix adds a raw-text word-boundary pass for stopword-only queries —
 * the same role as the prefix LIKE pass: candidates outside the BM25
 * macro, re-ranked by rank.ts's tiers on the raw text. The FTS query
 * construction is untouched, so the FTS/JS stopword alignment rank.ts
 * depends on is preserved.
 *
 * Real FTS sidecar, no mocks — the fixtures are the board row's contents
 * ('Hello from HTTP API' + 'zebra').
 */
// @ts-nocheck


import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import { keywordSearch } from "./query";
import { recallTool } from "../mcp/tools/recall";

// Real DuckDB `fts` extension load + rebuild, as in search-retr001.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const NS = path.join(NS_ROOT, "df092603-stopword");
const PARTITION = path.join(NS, "concept", "2026-09");
const JSONL = path.join(PARTITION, "current.jsonl");
const MANIFEST = path.join(NS, "manifest.json");

function mem(id: string, key: string, text: string, timestamp: string) {
  return JSON.stringify({
    id,
    key,
    domain: "raw_note",
    timestamp,
    author: "test@example.com",
    action: "add",
    embedding_text: text,
    attributes: {},
  });
}

beforeAll(() => {
  fs.mkdirSync(PARTITION, { recursive: true });
  fs.writeFileSync(
    JSONL,
    [
      // m1: the board row's exact fixture content. Key deliberately carries
      // no stopword substring, so a hit can only come from the CONTENT.
      mem("m1", "/df/m1", "Hello from HTTP API", "2026-09-29T00:00:00.000Z"),
      // m2: the non-stopword control fixture.
      mem("m2", "/df/m2", "zebra", "2026-09-29T00:01:00.000Z"),
    ].join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(
    MANIFEST,
    JSON.stringify({
      partitions: ["concept/2026-09"],
      lastUpdated: new Date().toISOString(),
    }),
  );
});

afterAll(() => {
  fs.rmSync(NS, { recursive: true, force: true });
});

describe("DF-0926-03: ?contains=<stopword> finds stored content", () => {
  it("contains=Hello hits the row whose CONTENT contains it", async () => {
    // includeStopwordLiterals is the recallTool contains= surface wiring
    // (see recall.ts); the default-off contract is asserted further below.
    const res = await keywordSearch(NS, "Hello", {
      limit: 10,
      includeStopwordLiterals: true,
    });
    expect(res.total).toBeGreaterThanOrEqual(1);
    expect(res.memories.map((m) => m.id)).toContain("m1");
    expect(res.memories[0].snippet).toContain("Hello");
  });

  it("contains=zebra still hits (non-stopword control, no flag needed)", async () => {
    const res = await keywordSearch(NS, "zebra", { limit: 10 });
    expect(res.total).toBe(1);
    expect(res.memories[0].id).toBe("m2");
  });

  it("contains=from hits via the raw-text pass (board fixture)", async () => {
    const res = await keywordSearch(NS, "from", {
      limit: 10,
      includeStopwordLiterals: true,
    });
    expect(res.total).toBeGreaterThanOrEqual(1);
    expect(res.memories.map((m) => m.id)).toContain("m1");
  });

  it("default stays opt-out: keywordSearch without the flag finds nothing (RETR-002 hybrid contract)", async () => {
    const res = await keywordSearch(NS, "Hello", { limit: 10 });
    expect(res.total).toBe(0);
  });

  it("recallTool contains= surfaces the same hits", async () => {
    const res = await recallTool({
      contains: "Hello",
      namespace: "df092603-stopword",
      limit: 10,
    });
    expect(res.error).toBeUndefined();
    expect(res.total).toBeGreaterThanOrEqual(1);
    expect(res.memories.map((m: any) => m.id)).toContain("m1");
  });

  it("a stopword absent from the corpus still returns zero rows (no false positives)", async () => {
    const res = await keywordSearch(NS, "greetings", {
      limit: 10,
      includeStopwordLiterals: true,
    });
    expect(res.total).toBe(0);
  });
});
