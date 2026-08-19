/**
 * RETR-008 Regression Tests: chat-archive full-text (Q-5).
 *
 * Guards the chat-archive indexing + snippet/highlight projection against
 * REAL rebuilt FTS sidecars on an isolated namespace root (same no-mocks
 * pattern as search-retr001/retr007):
 *
 *   - the rebuild path (rebuildAllNamespaces) enumerates and indexes a
 *     chat-archive-shaped namespace — dated message rows under
 *     /chats/<view>/<YYYY-MM-DD> keys — alongside other manifest
 *     namespaces
 *   - keywordSearch over the chat-archive namespace finds dated rows and
 *     surfaces the row TIMESTAMP, a RAW snippet (unchanged, marker-free)
 *     AND a highlightedSnippet with the matched term(s) wrapped in
 *     <mark>…</mark> — the CLI-printable display form
 *   - highlightMatches unit behavior: intact ticket-ID literals wrap
 *     whole, remaining tokens fill in, prefix queries wrap whole words,
 *     casing is preserved, no double-wrapping, regex metachars safe
 *   - searchTool + recallTool (contains) surfaces carry the highlight
 *   - default single-namespace behavior and the RETR-007 namespace facet
 *     are unchanged (no cross-namespace leakage, no union bookkeeping on
 *     the single-namespace path)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { rebuildAllNamespaces } from "./index";
import { highlightMatches } from "./rank";
import { keywordSearch, keywordSearchAllNamespaces } from "./query";
import { searchTool } from "../mcp/tools/search";
import { recallTool } from "../mcp/tools/recall";

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
// A chat-archive-shaped namespace: dated message rows.
const CHAT_NS = path.join(NS_ROOT, "chat-retr008");
const CHAT_PARTITION = path.join(CHAT_NS, "message", "2026-08");
// A sibling namespace — proves rebuildAllNamespaces covers both.
const NOTES_NS = path.join(NS_ROOT, "notes-retr008");
const NOTES_PARTITION = path.join(NOTES_NS, "concept", "2026-08");

const C1_TIMESTAMP = "2026-08-07T09:26:26.867Z";

function chatRow(
  id: string,
  date: string,
  text: string,
  timestamp: string,
): string {
  return JSON.stringify({
    id,
    key: `/chats/karahermes-set/${date}`,
    domain: "message",
    timestamp,
    author: "totalwindupflightsystems@gmail.com",
    action: "add",
    embedding_text: text,
    attributes: {},
  });
}

function noteRow(id: string, key: string, text: string): string {
  return JSON.stringify({
    id,
    key,
    domain: "concept",
    timestamp: "2026-08-01T00:00:00.000Z",
    author: "test@example.com",
    action: "add",
    embedding_text: text,
    attributes: {},
  });
}

beforeAll(async () => {
  // Chat-archive rows: multi-line chat dumps, dated keys, ingestion
  // timestamps — the exact shape of namespaces/chat-archive/message/*.
  fs.mkdirSync(CHAT_PARTITION, { recursive: true });
  fs.writeFileSync(
    path.join(CHAT_PARTITION, "current.jsonl"),
    [
      // c1: exact literal "GAP-020" in the chat body — tier 0 for GAP-020.
      chatRow(
        "c1",
        "2026-06-26",
        "00:40 Bane: what did you come up with for the GAP-020 harness\n00:42 Bane: have fun figuring out the issue",
        C1_TIMESTAMP,
      ),
      // c2: unrelated chat — must never match.
      chatRow(
        "c2",
        "2026-06-27",
        "09:15 Bane: pick up milk and eggs on the way back",
        "2026-08-07T09:27:00.000Z",
      ),
      // c3: both tokens present but no literal — tier 1 for GAP-020.
      chatRow(
        "c3",
        "2026-06-28",
        "GAP docs mention 020 numbers in passing",
        "2026-08-07T09:28:00.000Z",
      ),
    ].join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(CHAT_NS, "manifest.json"),
    JSON.stringify({
      partitions: ["message/2026-08"],
      lastUpdated: new Date().toISOString(),
    }),
  );

  fs.mkdirSync(NOTES_PARTITION, { recursive: true });
  fs.writeFileSync(
    path.join(NOTES_PARTITION, "current.jsonl"),
    [noteRow("n1", "/proj/s3-config", "S3 bucket sync configuration")].join(
      "\n",
    ) + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(NOTES_NS, "manifest.json"),
    JSON.stringify({
      partitions: ["concept/2026-08"],
      lastUpdated: new Date().toISOString(),
    }),
  );

  // The production rebuild path: every manifest namespace under the root.
  await rebuildAllNamespaces(NS_ROOT);
});

afterAll(() => {
  fs.rmSync(CHAT_NS, { recursive: true, force: true });
  fs.rmSync(NOTES_NS, { recursive: true, force: true });
});

describe("RETR-008: chat-archive namespace indexing", () => {
  it("rebuildAllNamespaces enumerates and indexes the chat-archive namespace", async () => {
    const results = await rebuildAllNamespaces(NS_ROOT);
    // Both manifest namespaces are covered — chat-archive is NOT skipped
    // by an index path that only knows some namespace kinds.
    expect(Object.keys(results).sort()).toEqual([
      "chat-retr008",
      "notes-retr008",
    ]);
    // 3 live chat rows, no tombstones/dedup in play.
    expect(results["chat-retr008"].rowCount).toBe(3);
    expect(results["notes-retr008"].rowCount).toBe(1);
  });

  it("searching a rebuilt chat-archive namespace returns dated rows with highlighted snippets", async () => {
    const res = await keywordSearch(CHAT_NS, "GAP-020", { limit: 10 });

    // c1 (exact literal, tier 0) + c3 (both tokens, tier 1); c2 unmatched.
    expect(res.total).toBe(2);

    const [first, second] = res.memories;
    expect(first.id).toBe("c1");
    // The dated row's timestamp is surfaced on the hit.
    expect(first.timestamp).toBe(C1_TIMESTAMP);
    expect(first.key).toBe("/chats/karahermes-set/2026-06-26");
    expect(first.domain).toBe("message");

    // The raw snippet is unchanged and marker-free (API/MCP contract).
    expect(first.snippet).toContain("GAP-020");
    expect(first.snippet).not.toContain("<mark>");
    // The highlighted display form wraps the intact ticket ID.
    expect(first.highlightedSnippet).toContain("<mark>GAP-020</mark>");

    // c3 has no literal — per-token highlight fills in.
    expect(second.id).toBe("c3");
    expect(second.highlightedSnippet).toContain("<mark>GAP</mark>");
    expect(second.highlightedSnippet).toContain("<mark>020</mark>");
  });

  it("prefix queries highlight whole words (GAP-02* wraps GAP-020 intact)", async () => {
    const res = await keywordSearch(CHAT_NS, "GAP-02*", { limit: 10 });
    // c1 (gap + "GAP-020" starts with "02") + c3 ("020" starts with "02").
    expect(res.total).toBe(2);
    const c1 = res.memories.find((m) => m.id === "c1");
    expect(c1?.highlightedSnippet).toContain("<mark>GAP-020</mark>");
    const c3 = res.memories.find((m) => m.id === "c3");
    expect(c3?.highlightedSnippet).toContain("<mark>020</mark>");
  });
});

describe("RETR-008: highlightMatches", () => {
  it("wraps the intact literal before per-token marks — ticket IDs stay whole", () => {
    expect(
      highlightMatches("GAP-020 memory", ["gap", "020"], undefined, "GAP-020"),
    ).toBe("<mark>GAP-020</mark> memory");
    expect(
      highlightMatches("gap-020", ["gap", "020"], undefined, "GAP-020"),
    ).toBe("<mark>gap-020</mark>");
  });

  it("fills remaining tokens when the literal is absent", () => {
    expect(
      highlightMatches("GAP docs 020", ["gap", "020"], undefined, "GAP"),
    ).toBe("<mark>GAP</mark> docs <mark>020</mark>");
  });

  it("prefix mode wraps whole words whose segments start with the prefix", () => {
    expect(highlightMatches("the GAP-020 fix", ["gap", "02"], "02")).toBe(
      "the <mark>GAP-020</mark> fix",
    );
    expect(highlightMatches("no prefix here", ["gap", "02"], "02")).toBe(
      "no prefix here",
    );
  });

  it("never double-wraps repeated literals and preserves casing", () => {
    expect(
      highlightMatches("GAP-020 GAP-020", ["gap", "020"], undefined, "GAP-020"),
    ).toBe("<mark>GAP-020</mark> <mark>GAP-020</mark>");
  });

  it("handles empty text, no-match text, and regex metacharacters", () => {
    expect(highlightMatches("", ["gap"], undefined, "GAP")).toBe("");
    expect(
      highlightMatches("nothing here", ["gap", "020"], undefined, "GAP-020"),
    ).toBe("nothing here");
    expect(highlightMatches("a (b) c", [], undefined, "(b)")).toBe(
      "a <mark>(b)</mark> c",
    );
  });
});

describe("RETR-008: MCP surfaces carry the highlight", () => {
  it("searchTool returns highlightedSnippet alongside the raw snippet", async () => {
    const res = await searchTool({
      query: "GAP-020",
      namespace: "chat-retr008",
    });
    expect(res.error).toBeUndefined();
    expect(res.total).toBe(2);
    expect(res.memories[0].id).toBe("c1");
    expect(res.memories[0].snippet).not.toContain("<mark>");
    expect(res.memories[0].highlightedSnippet).toContain(
      "<mark>GAP-020</mark>",
    );
  });

  it("recallTool contains= returns the highlight on keyword hits", async () => {
    const res = await recallTool({
      contains: "GAP-020",
      namespace: "chat-retr008",
      limit: 10,
    });
    expect(res.error).toBeUndefined();
    expect(res.total).toBe(2);
    const c1 = res.memories.find((m) => m.id === "c1");
    expect(c1?.timestamp).toBe(C1_TIMESTAMP);
    expect(c1?.highlightedSnippet).toContain("<mark>GAP-020</mark>");
    expect(c1?.snippet).not.toContain("<mark>");
  });
});

describe("RETR-008: single-namespace and union behavior unchanged", () => {
  it("single-namespace search keeps the RETR-007 facet and no union bookkeeping", async () => {
    const res = await keywordSearch(CHAT_NS, "GAP-020", { limit: 10 });
    expect(res.memories[0].namespace).toBe("chat-retr008");
    expect(res.namespacesSearched).toBeUndefined();
    expect(res.namespacesSkipped).toBeUndefined();
    // The sibling namespace's rows never leak into the single-namespace path.
    const s3 = await keywordSearch(CHAT_NS, "S3", { limit: 10 });
    expect(s3.total).toBe(0);
  });

  it("the all-namespaces union includes chat-archive hits with highlight and facet", async () => {
    const res = await keywordSearchAllNamespaces(NS_ROOT, "GAP-020", {
      limit: 10,
    });
    // c1 + c3 from the chat namespace; notes-retr008 has no match.
    expect(res.total).toBe(2);
    const c1 = res.memories.find((m) => m.id === "c1");
    expect(c1?.namespace).toBe("chat-retr008");
    expect(c1?.highlightedSnippet).toContain("<mark>GAP-020</mark>");
    expect(res.namespacesSearched).toEqual(["chat-retr008", "notes-retr008"]);
  });
});
