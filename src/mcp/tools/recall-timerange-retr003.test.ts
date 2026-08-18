/**
 * RETR-003 Regression Tests: time-scoped recall via the MCP recall tool.
 *
 * Guards src/mcp/tools/recall.ts end-to-end against a real seeded namespace
 * (JSONL partition + manifest under the DUCKBRAIN_NAMESPACES_PATH temp
 * root — same pattern as recall-dogfood002.test.ts):
 *   - after/before/between filter the result set AND the reported total
 *   - date-only before= includes the whole end day (until semantics)
 *   - chat-archive date facets match since/until even when the row
 *     timestamp is the archive ingestion time
 *   - invalid ISO-8601 values return a clean error payload (no throw)
 *   - between= combined with after/before is rejected
 *   - the keyword (contains=) path windows its candidates too (real
 *     rebuilt FTS sidecar, rebuildNamespaceIndex)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { recallTool } from "./recall";
import { rebuildNamespaceIndex } from "../../search/index";

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const NS = path.join(NS_ROOT, "recall-retr003");
const PARTITION = path.join(NS, "concept", "2026-08");
const JSONL = path.join(PARTITION, "current.jsonl");
const MANIFEST = path.join(NS, "manifest.json");

function mem(id: string, key: string, timestamp: string, text: string): string {
  return JSON.stringify({
    id,
    key,
    domain: "concept",
    timestamp,
    author: "test@example.com",
    action: "add",
    embedding_text: text,
    attributes: {},
  });
}

const ROWS = [
  // 2026-08-10 .. 2026-08-14 spread.
  mem("r1", "/timerange/1", "2026-08-10T12:00:00.000Z", "alpha early"),
  mem("r2", "/timerange/2", "2026-08-11T12:00:00.000Z", "alpha mid"),
  mem("r3", "/timerange/3", "2026-08-12T12:00:00.000Z", "beta day"),
  mem("r4", "/timerange/4", "2026-08-13T12:00:00.000Z", "alpha late"),
  mem("r5", "/timerange/5", "2026-08-14T12:00:00.000Z", "gamma tail"),
  // Chat-archive: key facet 2026-05-24, timestamp = INGESTION time.
  mem(
    "chat1",
    "/chats/karahermes-dm/2026-05-24/part-1",
    "2026-08-07T09:26:22.496Z",
    "chat archive content",
  ),
  mem(
    "chat2",
    "/chats/karahermes-dm/2026-06-01",
    "2026-08-07T09:26:22.611Z",
    "chat archive content two",
  ),
];

beforeAll(() => {
  fs.mkdirSync(PARTITION, { recursive: true });
  fs.writeFileSync(JSONL, ROWS.join("\n") + "\n");
  fs.writeFileSync(
    MANIFEST,
    JSON.stringify({
      partitions: ["concept/2026-08"],
      lastUpdated: new Date().toISOString(),
    }),
  );
});

afterAll(() => {
  fs.rmSync(PARTITION, { recursive: true, force: true });
  fs.rmSync(MANIFEST, { force: true });
  fs.rmSync(path.join(NS, ".search"), { recursive: true, force: true });
  fs.rmSync(path.join(NS, ".embeddings"), { recursive: true, force: true });
});

describe("RETR-003: time-scoped recall — MCP recall tool", () => {
  it("after+before returns only in-range rows with a matching total", async () => {
    const result = await recallTool({
      keyPrefix: "/timerange/",
      namespace: "recall-retr003",
      after: "2026-08-11",
      before: "2026-08-12",
      limit: 50,
    });

    expect(result.error).toBeUndefined();
    expect(result.count).toBe(2); // r2 (08-11) + r3 (08-12)
    expect(result.total).toBe(2);
    const ids = result.memories.map((m) => m.id).sort();
    expect(ids).toEqual(["r2", "r3"]);
  });

  it("between=START,END expands to the same window", async () => {
    const result = await recallTool({
      keyPrefix: "/timerange/",
      namespace: "recall-retr003",
      between: "2026-08-12,2026-08-13",
      limit: 50,
    });

    expect(result.error).toBeUndefined();
    expect(result.total).toBe(2); // r3 (08-12) + r4 (08-13)
    const ids = result.memories.map((m) => m.id).sort();
    expect(ids).toEqual(["r3", "r4"]);
  });

  it("chat-archive date facets match since/until via the tool", async () => {
    const result = await recallTool({
      keyPrefix: "/chats/",
      namespace: "recall-retr003",
      after: "2026-05-24",
      before: "2026-05-24",
      limit: 50,
    });

    expect(result.error).toBeUndefined();
    expect(result.total).toBe(1); // chat1 by facet; chat2 facet 06-01 out
    expect(result.memories[0].id).toBe("chat1");
  });

  it("invalid after= returns a clean error payload, not a throw", async () => {
    const result = await recallTool({
      namespace: "recall-retr003",
      after: "not-a-date",
    });

    expect(result.memories).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.error).toMatch(/Invalid ISO-8601 datetime for after/);
  });

  it("calendar-impossible dates return a clean error payload", async () => {
    const result = await recallTool({
      namespace: "recall-retr003",
      after: "2026-02-30",
    });

    expect(result.count).toBe(0);
    expect(result.error).toMatch(/Invalid ISO-8601 datetime for after/);
  });

  it("between= without a comma returns a clean error payload", async () => {
    const result = await recallTool({
      namespace: "recall-retr003",
      between: "2026-08-10",
    });

    expect(result.count).toBe(0);
    expect(result.error).toMatch(/two comma-separated ISO-8601 values/);
  });

  it("between= combined with after= is rejected cleanly", async () => {
    const result = await recallTool({
      namespace: "recall-retr003",
      after: "2026-08-10",
      between: "2026-08-11,2026-08-12",
    });

    expect(result.count).toBe(0);
    expect(result.error).toMatch(/either 'between' or 'after'\/'before'/);
  });

  it("an empty window (after > before) is rejected cleanly", async () => {
    const result = await recallTool({
      namespace: "recall-retr003",
      after: "2026-08-12",
      before: "2026-08-10",
    });

    expect(result.count).toBe(0);
    expect(result.error).toMatch(/must not be later than before/);
  });
});

describe("RETR-003: time-scoped recall — keyword (contains=) path", () => {
  beforeAll(async () => {
    await rebuildNamespaceIndex(NS);
  });

  it("windows keyword candidates by the time bounds", async () => {
    const result = await recallTool({
      contains: "alpha",
      namespace: "recall-retr003",
      after: "2026-08-12",
      limit: 50,
    });

    expect(result.error).toBeUndefined();
    const ids = result.memories.map((m) => m.id).sort();
    // r4 (08-13) only — r1 (08-10) and r2 (08-11) are before the window.
    expect(ids).toEqual(["r4"]);
  });

  it("keeps unfiltered keyword results unchanged", async () => {
    const result = await recallTool({
      contains: "alpha",
      namespace: "recall-retr003",
      limit: 50,
    });

    expect(result.error).toBeUndefined();
    const ids = result.memories.map((m) => m.id).sort();
    expect(ids).toEqual(["r1", "r2", "r4"]);
  });
});
