/**
 * RETR-006 Regression Tests: attribute filters at the query layer.
 *
 * Guards src/duckdb/queries.ts buildAttributeConditions:
 *   - attr.name=value returns ONLY rows whose attributes JSON matches
 *   - numeric values match by their string form (tick=403 matches both
 *     `403` and `"403"` — json_extract_string normalization)
 *   - combined with keyPrefix/domain filters — intersection semantics
 *   - countMemories reports the same attr-scoped row set
 *   - injection safety: names/values containing quotes and backslashes
 *     neither break the SQL nor produce wrong matches
 *   - RFC 8259 duplicate keys in attributes (DOGFOOD-018/019) never crash
 *     the extraction (first value wins)
 *   - empty attr record = no-op
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDuckDB, closeDuckDB } from "./connection";
import { insertMemory, queryMemories, countMemories } from "./queries";
import type { MemoryType } from "../schema/memory";
import path from "path";
import fs from "fs";

function memory(
  id: string,
  key: string,
  attributes: Record<string, unknown>,
  domain:
    | "config"
    | "message"
    | "person"
    | "event"
    | "concept"
    | "raw_note" = "config",
): MemoryType {
  return {
    id,
    key,
    domain,
    timestamp: "2026-08-01T00:00:00.000Z",
    author: "test@example.com",
    action: "add",
    embedding_text: `Record ${id}`,
    attributes,
  };
}

describe("RETR-006: attribute filters — queryMemories/countMemories", () => {
  let db: any;
  const testPartition = path.join(process.cwd(), "test-memory-attr");

  beforeEach(async () => {
    db = await initDuckDB(":memory:");
    if (fs.existsSync(testPartition)) {
      fs.rmSync(testPartition, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    if (db) {
      await closeDuckDB(db);
    }
    if (fs.existsSync(testPartition)) {
      fs.rmSync(testPartition, { recursive: true, force: true });
    }
  });

  function seed(records: MemoryType[]): void {
    for (const r of records) insertMemory(db, r, testPartition);
  }

  it("attr.domain=config returns only rows whose attributes match, excluding non-config rows", async () => {
    seed([
      memory("a1", "/t/config-1", { domain: "config" }),
      memory("a2", "/t/config-2", { domain: "config", tick: 403 }),
      memory("a3", "/t/message-1", { domain: "message" }),
      memory("a4", "/t/noattr", {}),
    ]);

    const rows = await queryMemories(db, [testPartition], {
      attr: { domain: "config" },
      limit: 10,
    });
    expect(rows.map((r) => r.id).sort()).toEqual(["a1", "a2"]);
    expect(
      await countMemories(db, [testPartition], { attr: { domain: "config" } }),
    ).toBe(2);
  });

  it('attr.tick=403 matches BOTH numeric (403) and string ("403") values', async () => {
    seed([
      memory("n1", "/t/num", { tick: 403 }),
      memory("n2", "/t/str", { tick: "403" }),
      memory("n3", "/t/other", { tick: 402 }),
      memory("n4", "/t/missing", {}),
    ]);

    const rows = await queryMemories(db, [testPartition], {
      attr: { tick: "403" },
      limit: 10,
    });
    expect(rows.map((r) => r.id).sort()).toEqual(["n1", "n2"]);
    expect(
      await countMemories(db, [testPartition], { attr: { tick: "403" } }),
    ).toBe(2);
  });

  it("combines with keyPrefix and domain filters — intersection semantics", async () => {
    seed([
      memory("c1", "/cfg/a", { domain: "config" }, "config"),
      memory("c2", "/cfg/b", { domain: "config", env: "prod" }, "config"),
      memory("c3", "/cfg/c", { domain: "config" }, "raw_note"),
      memory("c4", "/other/d", { domain: "config" }, "config"),
    ]);

    const rows = await queryMemories(db, [testPartition], {
      keyPrefix: "/cfg/",
      domain: "config",
      attr: { env: "prod" },
      limit: 10,
    });
    expect(rows.map((r) => r.id)).toEqual(["c2"]);
    expect(
      await countMemories(db, [testPartition], {
        keyPrefix: "/cfg/",
        domain: "config",
        attr: { env: "prod" },
      }),
    ).toBe(1);
  });

  it("multiple attr pairs AND together", async () => {
    seed([
      memory("m1", "/t/1", { domain: "config", tick: 403 }),
      memory("m2", "/t/2", { domain: "config", tick: 404 }),
      memory("m3", "/t/3", { domain: "message", tick: 403 }),
    ]);

    const rows = await queryMemories(db, [testPartition], {
      attr: { domain: "config", tick: "403" },
      limit: 10,
    });
    expect(rows.map((r) => r.id)).toEqual(["m1"]);
  });

  it("attribute names and values containing quotes/backslashes neither break SQL nor mis-match", async () => {
    seed([
      memory("q1", "/t/1", {
        'weird"name': 'it\'s a "quoted" value',
        "back\\slash": "y\\z",
      }),
      memory("q2", "/t/2", {
        'weird"name': "different",
        "back\\slash": "other",
      }),
    ]);

    // Value with single quote + double quote + backslash.
    const byValue = await queryMemories(db, [testPartition], {
      attr: { 'weird"name': 'it\'s a "quoted" value' },
      limit: 10,
    });
    expect(byValue.map((r) => r.id)).toEqual(["q1"]);

    // Name with a double quote (JSONPath-escaped segment).
    const byQuotedName = await queryMemories(db, [testPartition], {
      attr: { 'weird"name': "different" },
      limit: 10,
    });
    expect(byQuotedName.map((r) => r.id)).toEqual(["q2"]);

    // Name with a backslash (JSONPath-escaped segment).
    const byBackslashName = await queryMemories(db, [testPartition], {
      attr: { "back\\slash": "y\\z" },
      limit: 10,
    });
    expect(byBackslashName.map((r) => r.id)).toEqual(["q1"]);
  });

  it("duplicate keys in attributes (RFC 8259) never crash extraction — first value wins", async () => {
    // insertMemory stringifies through JSON, which collapses duplicates —
    // write the raw line exactly like an external writer would (DOGFOOD-018).
    seed([memory("d1", "/t/1", { domain: "config" })]);
    const chunk = path.join(
      testPartition,
      fs.readdirSync(testPartition).filter((f) => f.endsWith(".jsonl"))[0],
    );
    fs.appendFileSync(
      chunk,
      '{"id":"d2","key":"/t/2","domain":"config","timestamp":"2026-08-02T00:00:00.000Z","author":"test@example.com","action":"add","embedding_text":"Record d2","attributes":{"domain":"config","domain":"dup"}}\n',
      "utf-8",
    );

    const rows = await queryMemories(db, [testPartition], {
      attr: { domain: "config" },
      limit: 10,
    });
    const ids = rows.map((r) => r.id).sort();
    // d1 via insertMemory + d2 via the raw duplicate-key line — no crash.
    expect(ids).toEqual(["d1", "d2"]);
    expect(
      await countMemories(db, [testPartition], { attr: { domain: "config" } }),
    ).toBe(2);
  });

  it("empty attr record is a no-op", async () => {
    seed([
      memory("e1", "/t/1", { domain: "config" }),
      memory("e2", "/t/2", {}),
    ]);

    const rows = await queryMemories(db, [testPartition], {
      attr: {},
      limit: 10,
    });
    expect(rows.map((r) => r.id).sort()).toEqual(["e1", "e2"]);
    expect(await countMemories(db, [testPartition], { attr: {} })).toBe(2);
  });

  it("a missing attribute key matches nothing, never everything", async () => {
    seed([memory("f1", "/t/1", { env: "prod" })]);

    const rows = await queryMemories(db, [testPartition], {
      attr: { env: "staging" },
      limit: 10,
    });
    expect(rows).toEqual([]);
    expect(
      await countMemories(db, [testPartition], { attr: { env: "staging" } }),
    ).toBe(0);
  });
});
