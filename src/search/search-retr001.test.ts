/**
 * RETR-001 Regression Tests: keyword full-text search.
 *
 * Guards the whole keyword half end-to-end against a REAL rebuilt FTS
 * sidecar (DuckDB `fts` extension) on an isolated namespace under the
 * DUCKBRAIN_NAMESPACES_PATH temp root — no mocks, no embedding provider:
 *
 *   - rebuild creates a gitignored sidecar, is idempotent, applies the
 *     same dedup/tombstone semantics as queryMemories
 *   - `duckbrain search "GAP-020"` finds the literal-token memory first
 *     (exact-token ranking), with a snippet, and matches attribute text
 *   - digit-heavy tokens (ticket IDs, cron IDs, hex ids) are searchable —
 *     the stock DuckDB tokenizer drops pure-numeric tokens, which is why
 *     the index uses the digit-mapped search_text column (transform.ts)
 *   - trailing `*` prefix queries work via the raw_text LIKE pass
 *   - recallTool's `contains` param and searchTool surface the same path,
 *     with the same missing-index guidance
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import {
  rebuildNamespaceIndex,
  ensureSearchGitignored,
  indexStatus,
  SEARCH_INDEX_DIR,
  SearchIndexMissingError,
} from "./index";
import {
  computeTier,
  makeSnippet,
  RANK_TIER_EXACT,
  RANK_TIER_ALL,
  RANK_TIER_ANY,
  type IndexRow,
} from "./rank";
import { keywordSearch } from "./query";
import { searchTool } from "../mcp/tools/search";
import { recallTool } from "../mcp/tools/recall";

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const NS = path.join(NS_ROOT, "search-retr001");
// A namespace with NO index — shared by all missing-index tests.
const BARE_NS = path.join(NS_ROOT, "search-retr001-bare");
const PARTITION = path.join(NS, "concept", "2026-08");
const JSONL = path.join(PARTITION, "current.jsonl");
const MANIFEST = path.join(NS, "manifest.json");

function mem(
  id: string,
  key: string,
  text: string,
  attributes: Record<string, unknown> = {},
  extra: Partial<{ action: string; timestamp: string }> = {},
) {
  return JSON.stringify({
    id,
    key,
    domain: "concept",
    timestamp: extra.timestamp ?? `2026-08-0${id.slice(1)}T00:00:00.000Z`,
    author: "test@example.com",
    action: extra.action ?? "add",
    embedding_text: text,
    attributes,
  });
}

beforeAll(() => {
  fs.mkdirSync(PARTITION, { recursive: true });
  fs.writeFileSync(
    JSONL,
    [
      // m1: exact literal in content — must rank first for "GAP-020".
      mem("m1", "/proj/gap-020", "GAP-020 memory about the fix"),
      // m2: both tokens present but no literal — tier 1.
      mem("m2", "/proj/other", "GAP docs mention 020 numbers"),
      // m3: no match at all.
      mem("m3", "/notes/alpha", "totally unrelated content"),
      // m4: digit-only token in content.
      mem("m4", "/tickets/42", "Fixed the bug in ticket 42"),
      // m5: hex cron id (letter/digit mixed).
      mem("m5", "/cfg/cron", "cron job 6e77662f1325 runs hourly"),
      // m6: tombstoned — must be excluded from the index.
      mem(
        "m6",
        "/dead/beef",
        "should not be indexed",
        {},
        { action: "tombstone" },
      ),
      // m7: two records, same id — only the latest may be indexed.
      mem(
        "m7",
        "/notes/versioned",
        "first draft of the versioned note",
        {},
        {
          timestamp: "2026-08-01T00:00:00.000Z",
        },
      ),
      mem(
        "m7",
        "/notes/versioned",
        "final version of the versioned note",
        {},
        {
          timestamp: "2026-08-05T00:00:00.000Z",
        },
      ),
      // m8: the token lives in the ATTRIBUTES, not the body — still searchable.
      mem(
        "m8",
        "/proj/ref",
        "This memory only mentions the ticket inside its structured attributes field rather than in the free text body, which makes this record considerably longer than the first one.",
        { ref: "GAP-020", status: "open" },
      ),
    ].join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(
    MANIFEST,
    JSON.stringify({
      partitions: ["concept/2026-08"],
      lastUpdated: new Date().toISOString(),
    }),
  );
  fs.mkdirSync(BARE_NS, { recursive: true });
  fs.writeFileSync(
    path.join(BARE_NS, "manifest.json"),
    JSON.stringify({ partitions: [] }),
  );
});

afterAll(() => {
  fs.rmSync(NS, { recursive: true, force: true });
  fs.rmSync(BARE_NS, { recursive: true, force: true });
});

describe("RETR-001: search index rebuild", () => {
  it("builds a gitignored sidecar with live rows only", async () => {
    const meta = await rebuildNamespaceIndex(NS);
    // m1..m5 + m7(latest) + m8 = 7; m6 tombstone excluded, m7 deduped.
    expect(meta.rowCount).toBe(7);
    expect(meta.sourceFiles).toBe(1);

    const dbPath = path.join(NS, SEARCH_INDEX_DIR, "fts.duckdb");
    expect(fs.existsSync(dbPath)).toBe(true);

    // Gitignore entry mirrors the .embeddings pattern.
    const gi = fs.readFileSync(path.join(NS, ".gitignore"), "utf8");
    expect(gi).toContain("/.search/");

    const status = indexStatus(NS);
    expect(status.indexExists).toBe(true);
    expect(status.gitignored).toBe(true);
    expect(status.meta?.rowCount).toBe(7);
  });

  it("is idempotent — a second rebuild produces the same index", async () => {
    const first = await rebuildNamespaceIndex(NS);
    const second = await rebuildNamespaceIndex(NS);
    expect(second.rowCount).toBe(first.rowCount);
    expect(second.rowCount).toBe(7);
    expect(fs.existsSync(path.join(NS, SEARCH_INDEX_DIR, "fts.duckdb"))).toBe(
      true,
    );
  });

  it("ensureSearchGitignored does not duplicate the entry", () => {
    const giPath = path.join(NS, ".gitignore");
    const before = fs.readFileSync(giPath, "utf8");
    ensureSearchGitignored(NS);
    const after = fs.readFileSync(giPath, "utf8");
    expect(after).toBe(before);
    expect(after.match(/\/\.search\//g)).toHaveLength(1);
  });
});

describe("RETR-001: ranking tiers and snippets", () => {
  function row(raw_text: string): IndexRow {
    return {
      id: "x",
      key: "",
      domain: "raw_note",
      timestamp: "2026-08-07T00:00:00.000Z",
      author: "test@example.com",
      action: "add",
      embedding_text: raw_text,
      attributes: "{}",
      raw_text,
      search_text: raw_text,
    };
  }

  it("exact literal beats token-AND beats any-token", () => {
    expect(computeTier(row("GAP-020 fix"), "GAP-020", ["gap", "020"])).toBe(
      RANK_TIER_EXACT,
    );
    expect(computeTier(row("GAP docs 020"), "GAP-020", ["gap", "020"])).toBe(
      RANK_TIER_ALL,
    );
    expect(computeTier(row("just GAP here"), "GAP-020", ["gap", "020"])).toBe(
      RANK_TIER_ANY,
    );
  });

  it("prefix tokens match via startsWith, not exact equality", () => {
    // "GAP-02*" → non-prefix token "gap" present AND "02" matches "020".
    expect(
      computeTier(
        row("/proj/gap-02 GAP-02 fix"),
        "GAP-02",
        ["gap", "02"],
        "02",
      ),
    ).toBe(RANK_TIER_ALL);
    // Bare "gap" without any token starting with "02" stays tier ANY.
    expect(computeTier(row("gap only"), "GAP-02", ["gap", "02"], "02")).toBe(
      RANK_TIER_ANY,
    );
  });

  it("makeSnippet anchors on the first token and windows around it", () => {
    const text =
      "alpha beta gamma GAP-020 delta epsilon zeta eta theta iota kappa lambda";
    const snippet = makeSnippet(text, ["gap", "020"], undefined, 2);
    expect(snippet).toContain("GAP-020");
    // Window keeps the two words before the anchor.
    expect(snippet).toContain("beta gamma");
    // Words outside the window are elided with ellipses.
    expect(snippet).toContain("…");
    expect(snippet).not.toContain("alpha");
    expect(snippet).not.toContain("lambda");
  });
});

describe("RETR-001: keyword search", () => {
  it("finds GAP-020 with the exact-token memory first and a snippet", async () => {
    const res = await keywordSearch(NS, "GAP-020", { limit: 10 });
    // m1 (literal in content) + m2 (both tokens, no literal) + m8 (literal
    // in attributes).
    expect(res.total).toBe(3);

    const [first, second, third] = res.memories;
    expect(first.id).toBe("m1");
    expect(first.snippet).toContain("GAP-020");
    expect(first.score).toBeGreaterThan(0);

    // m8's literal lives in attributes — still tier 0, but its long body
    // scores below m1's short one. m2 has no literal → tier 1, last.
    expect(second.id).toBe("m8");
    expect(third.id).toBe("m2");
  });

  it("finds digit-only and hex tokens the stock tokenizer would drop", async () => {
    const byDigits = await keywordSearch(NS, "020", { limit: 10 });
    // m1 ("GAP-020"), m2 ("020 numbers"), m8 (attributes ref "GAP-020").
    expect(byDigits.total).toBe(3);
    expect(byDigits.memories.map((m) => m.id).sort()).toEqual([
      "m1",
      "m2",
      "m8",
    ]);

    const byTicket = await keywordSearch(NS, "42", { limit: 10 });
    expect(byTicket.total).toBe(1);
    expect(byTicket.memories[0].id).toBe("m4");

    const byHex = await keywordSearch(NS, "6e77662f1325", { limit: 10 });
    expect(byHex.total).toBe(1);
    expect(byHex.memories[0].id).toBe("m5");
    expect(byHex.memories[0].snippet).toContain("6e77662f1325");
  });

  it("supports trailing-* prefix queries", async () => {
    const res = await keywordSearch(NS, "GAP-02*", { limit: 10 });
    // "GAP-02*" = gap AND 02*: m1 (gap + "GAP-020"), m8 (attributes) and
    // m2 (gap + "020" — the "02" prefix matches the "020" token).
    expect(res.total).toBe(3);
    expect(res.memories.map((m) => m.id).sort()).toEqual(["m1", "m2", "m8"]);
    expect(res.memories[0].snippet).toContain("GAP-020");
  });

  it("excludes tombstones and dedupes by id (latest wins)", async () => {
    const dead = await keywordSearch(NS, "indexed", { limit: 10 });
    expect(dead.total).toBe(0);

    const versioned = await keywordSearch(NS, "versioned", { limit: 10 });
    const m7hits = versioned.memories.filter((m) => m.id === "m7");
    expect(m7hits).toHaveLength(1);
    expect(m7hits[0].embedding_text).toBe(
      "final version of the versioned note",
    );
  });

  it("respects limit and count-only (limit=0)", async () => {
    const one = await keywordSearch(NS, "GAP-020", { limit: 1 });
    expect(one.memories).toHaveLength(1);
    expect(one.total).toBe(3);

    const zero = await keywordSearch(NS, "GAP-020", { limit: 0 });
    expect(zero.memories).toHaveLength(0);
    expect(zero.total).toBe(3);
  });

  it("throws a rebuild-hint error when no index exists", async () => {
    try {
      await keywordSearch(BARE_NS, "GAP-020");
      expect.unreachable("expected SearchIndexMissingError");
    } catch (e) {
      expect(e).toBeInstanceOf(SearchIndexMissingError);
      expect((e as Error).message).toContain("search-index rebuild");
    }
  });
});

describe("RETR-001: searchTool surface", () => {
  it("returns ranked hits with snippets", async () => {
    const res = await searchTool({
      query: "GAP-020",
      namespace: "search-retr001",
    });
    expect(res.error).toBeUndefined();
    expect(res.namespace).toBe("search-retr001");
    expect(res.total).toBe(3);
    expect(res.memories[0].id).toBe("m1");
    expect(res.memories[0].snippet).toContain("GAP-020");
  });

  it("surfaces the missing-index guidance as an error", async () => {
    const res = await searchTool({
      query: "GAP-020",
      namespace: "search-retr001-bare",
    });
    expect(res.error).toContain("search-index rebuild");
    expect(res.memories).toHaveLength(0);
  });
});

describe("RETR-001: recallTool contains path", () => {
  it("filters by keyword with snippets, offline", async () => {
    const res = await recallTool({
      contains: "GAP-020",
      namespace: "search-retr001",
      limit: 10,
    });
    expect(res.error).toBeUndefined();
    expect(res.namespace).toBe("search-retr001");
    expect(res.total).toBe(3);
    expect(res.memories[0].id).toBe("m1");
    expect(typeof res.memories[0].snippet).toBe("string");
    expect(typeof res.memories[0].score).toBe("number");
  });

  it("honors limit=0 as count-only (GAP-024 parity)", async () => {
    const res = await recallTool({
      contains: "GAP-020",
      namespace: "search-retr001",
      limit: 0,
    });
    expect(res.memories).toHaveLength(0);
    expect(res.total).toBe(3);
  });

  it("rejects query+contains together until hybrid fusion (RETR-002)", async () => {
    const res = await recallTool({
      query: "something",
      contains: "GAP-020",
      namespace: "search-retr001",
    });
    expect(res.error).toContain("RETR-002");
    expect(res.memories).toHaveLength(0);
  });

  it("reports a missing index instead of silently returning everything", async () => {
    const res = await recallTool({
      contains: "GAP-020",
      namespace: "search-retr001-bare",
    });
    expect(res.error).toContain("search-index rebuild");
    expect(res.memories).toHaveLength(0);
  });
});
