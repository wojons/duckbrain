/**
 * RETR-007 Regression Tests: cross-namespace keyword search (Q-4).
 *
 * Guards the union path end-to-end against REAL rebuilt FTS sidecars on
 * an isolated namespace root (same no-mocks pattern as search-retr001):
 *
 *   - keywordSearchAllNamespaces unions hits from EVERY manifest
 *     namespace and ranks the combined pool once (tier → BM25 → recency)
 *   - each hit carries an explicit `namespace` facet identifying its
 *     source — never inferred from the key
 *   - index-less namespaces are skipped and reported (namespacesSkipped);
 *     when NO namespace has an index the union is empty with every
 *     namespace reported as skipped (no throw — the CLI warns on stderr)
 *   - the default single-namespace search is UNCHANGED: no
 *     cross-namespace leakage, no union bookkeeping fields
 *   - searchTool surfaces the union via allNamespaces=true and rejects
 *     the allNamespaces+namespace combination loudly
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { rebuildNamespaceIndex } from "./index";
import { keywordSearch, keywordSearchAllNamespaces } from "./query";
import { searchTool } from "../mcp/tools/search";

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const NS_A = path.join(NS_ROOT, "search-retr007-a");
const NS_B = path.join(NS_ROOT, "search-retr007-b");
// A namespace with NO index — must be skipped by the union, not fatal.
const BARE_NS = path.join(NS_ROOT, "search-retr007-bare");
// A root with no manifest namespaces at all — union is trivially empty.
const EMPTY_ROOT = path.join(NS_ROOT, "retr007-empty-root");

function mem(
  id: string,
  key: string,
  text: string,
  timestamp: string,
  attributes: Record<string, unknown> = {},
) {
  return JSON.stringify({
    id,
    key,
    domain: "raw_note",
    timestamp,
    author: "test@example.com",
    action: "add",
    embedding_text: text,
    attributes,
  });
}

function writeNamespace(
  nsPath: string,
  rows: Array<{ id: string; key: string; text: string; ts: string }>,
): void {
  const partition = path.join(nsPath, "concept", "2026-08");
  fs.mkdirSync(partition, { recursive: true });
  fs.writeFileSync(
    path.join(partition, "current.jsonl"),
    rows.map((r) => mem(r.id, r.key, r.text, r.ts)).join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(nsPath, "manifest.json"),
    JSON.stringify({
      partitions: ["concept/2026-08"],
      lastUpdated: new Date().toISOString(),
    }),
  );
}

beforeAll(async () => {
  // NS_A: the exact literal "S3 bucket" lives here — must win the union
  // for "S3 bucket" (tier 0 beats NS_B's any-token tier 2).
  writeNamespace(NS_A, [
    {
      id: "a1",
      key: "/proj/s3-config",
      text: "S3 bucket sync configuration for the fleet",
      ts: "2026-08-01T00:00:00.000Z",
    },
    {
      id: "a2",
      key: "/notes/alpha",
      text: "totally unrelated content",
      ts: "2026-08-02T00:00:00.000Z",
    },
  ]);
  // NS_B: token-level match only (S3 present, no "bucket").
  writeNamespace(NS_B, [
    {
      id: "b1",
      key: "/proj/s3-archive",
      text: "S3 archive policy keeps old snapshots",
      ts: "2026-08-03T00:00:00.000Z",
    },
    {
      id: "b2",
      key: "/notes/beta",
      text: "more unrelated content",
      ts: "2026-08-04T00:00:00.000Z",
    },
  ]);
  fs.mkdirSync(BARE_NS, { recursive: true });
  fs.writeFileSync(
    path.join(BARE_NS, "manifest.json"),
    JSON.stringify({ partitions: [] }),
  );
  fs.mkdirSync(EMPTY_ROOT, { recursive: true });

  await rebuildNamespaceIndex(NS_A);
  await rebuildNamespaceIndex(NS_B);
});

afterAll(() => {
  fs.rmSync(NS_A, { recursive: true, force: true });
  fs.rmSync(NS_B, { recursive: true, force: true });
  fs.rmSync(BARE_NS, { recursive: true, force: true });
  fs.rmSync(EMPTY_ROOT, { recursive: true, force: true });
});

describe("RETR-007: keywordSearchAllNamespaces", () => {
  it("unions hits from every indexed namespace with an explicit namespace facet", async () => {
    const res = await keywordSearchAllNamespaces(NS_ROOT, "S3", {
      limit: 10,
    });

    // a1 + b1 match; a2/b2 don't; bare has no index.
    expect(res.total).toBe(2);

    const byId = new Map(res.memories.map((m) => [m.id, m]));
    expect(byId.get("a1")?.namespace).toBe("search-retr007-a");
    expect(byId.get("b1")?.namespace).toBe("search-retr007-b");

    // The facet is explicit and non-empty on every hit — never inferred.
    for (const m of res.memories) {
      expect(m.namespace.length).toBeGreaterThan(0);
    }

    // Union bookkeeping: which namespaces contributed, which were skipped.
    expect(res.namespacesSearched).toEqual([
      "search-retr007-a",
      "search-retr007-b",
    ]);
    expect(res.namespacesSkipped).toEqual(["search-retr007-bare"]);
  });

  it("default single-namespace search is unchanged — no cross-namespace leakage", async () => {
    const res = await keywordSearch(NS_A, "S3", { limit: 10 });

    expect(res.total).toBe(1);
    expect(res.memories[0].id).toBe("a1");
    // The facet on a single-namespace hit is the searched namespace.
    expect(res.memories[0].namespace).toBe("search-retr007-a");
    // No union bookkeeping on the single-namespace result.
    expect(res.namespacesSearched).toBeUndefined();
    expect(res.namespacesSkipped).toBeUndefined();
    // NS_B's b1 must NOT leak into the default path.
    expect(res.memories.some((m) => m.id === "b1")).toBe(false);
  });

  it("ranks the union by tier across namespaces — exact literal wins over any-token", async () => {
    const res = await keywordSearchAllNamespaces(NS_ROOT, "S3 bucket", {
      limit: 10,
    });

    // a1 contains the literal "S3 bucket" (tier 0); b1 has only "S3"
    // (tier 2). The union must order by tier, not by namespace.
    expect(res.total).toBe(2);
    expect(res.memories[0].id).toBe("a1");
    expect(res.memories[0].namespace).toBe("search-retr007-a");

    const bHit = res.memories.find((m) => m.id === "b1");
    expect(bHit).toBeDefined();
    expect(res.memories.indexOf(bHit!)).toBeGreaterThan(0);
  });

  it("skips index-less namespaces and reports them; restricts via opts.namespaces", async () => {
    const restricted = await keywordSearchAllNamespaces(NS_ROOT, "S3", {
      namespaces: ["search-retr007-a"],
      limit: 10,
    });
    expect(restricted.memories.map((m) => m.id)).toEqual(["a1"]);
    expect(restricted.namespacesSearched).toEqual(["search-retr007-a"]);
    expect(restricted.namespacesSkipped).toEqual([]);
  });

  it("returns an empty union with all namespaces skipped when NO namespace has an index", async () => {
    const res = await keywordSearchAllNamespaces(NS_ROOT, "S3", {
      namespaces: ["search-retr007-bare"],
    });
    expect(res).toEqual({
      memories: [],
      total: 0,
      namespacesSearched: [],
      namespacesSkipped: ["search-retr007-bare"],
    });
  });

  it("returns an empty result, not an error, for a root with no namespaces", async () => {
    const res = await keywordSearchAllNamespaces(EMPTY_ROOT, "S3");
    expect(res).toEqual({
      memories: [],
      total: 0,
      namespacesSearched: [],
      namespacesSkipped: [],
    });
  });

  it("honors limit=0 as count-only on the union", async () => {
    const res = await keywordSearchAllNamespaces(NS_ROOT, "S3", {
      limit: 0,
    });
    expect(res.memories).toHaveLength(0);
    expect(res.total).toBe(2);
  });
});

describe("RETR-007: searchTool surface", () => {
  it("allNamespaces=true returns the union with namespace facets", async () => {
    const res = await searchTool({ query: "S3", allNamespaces: true });

    expect(res.error).toBeUndefined();
    expect(res.namespace).toBe("all");
    expect(res.total).toBe(2);
    expect(res.memories.map((m) => m.namespace).sort()).toEqual([
      "search-retr007-a",
      "search-retr007-b",
    ]);
    expect(res.namespacesSearched).toEqual([
      "search-retr007-a",
      "search-retr007-b",
    ]);
    expect(res.namespacesSkipped).toEqual(["search-retr007-bare"]);
  });

  it("rejects allNamespaces + namespace together", async () => {
    const res = await searchTool({
      query: "S3",
      allNamespaces: true,
      namespace: "search-retr007-a",
    });
    expect(res.error).toContain("allNamespaces");
    expect(res.memories).toHaveLength(0);
    expect(res.count).toBe(0);
  });

  it("single-namespace search keeps default behavior and carries the facet", async () => {
    const res = await searchTool({
      query: "S3",
      namespace: "search-retr007-a",
    });
    expect(res.error).toBeUndefined();
    expect(res.namespace).toBe("search-retr007-a");
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0].id).toBe("a1");
    expect(res.memories[0].namespace).toBe("search-retr007-a");
    expect(res.namespacesSearched).toBeUndefined();
    expect(res.namespacesSkipped).toBeUndefined();
  });
});
