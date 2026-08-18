/**
 * RETR-003 Regression Tests: time-scoped recall at the query layer.
 *
 * Guards the after/before filters in src/duckdb/queries.ts:
 *   - rows are windowed on their timestamp (inclusive bounds)
 *   - timestamps are compared as real TIMESTAMPs, NOT strings — chat-archive
 *     rows mix formats (`.749Z`, `.676525+00:00`, `+05:00` offsets) and
 *     lexicographic comparison is wrong across timezone offsets
 *   - chat-archive DATE FACETS work: a /chats/<view>/<YYYY-MM-DD> key whose
 *     row timestamp is the archive INGESTION time still matches a since/until
 *     window covering its facet date
 *   - the window applies INSIDE the dedup window: a memory updated after the
 *     window's end surfaces as its latest in-window record
 *   - countMemories reports the same windowed row set
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
  timestamp: string,
  action: "add" | "update" | "tombstone" = "add",
): MemoryType {
  return {
    id,
    key,
    domain: "message",
    timestamp,
    author: "test@example.com",
    action,
    embedding_text: `Record ${id}`,
    attributes: {},
  };
}

describe("RETR-003: time-scoped recall — queryMemories/countMemories", () => {
  let db: any;
  const testPartition = path.join(process.cwd(), "test-memory-timerange");

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

  it("after= excludes older rows and is inclusive on the boundary", async () => {
    seed([
      memory("a1", "/t/early", "2026-08-09T23:59:59.000Z"),
      memory("a2", "/t/at-boundary", "2026-08-10T00:00:00.000Z"),
      memory("a3", "/t/later", "2026-08-11T00:00:00.000Z"),
    ]);

    const rows = await queryMemories(db, [testPartition], {
      after: "2026-08-10",
      limit: 10,
    });
    expect(rows.map((r) => r.id).sort()).toEqual(["a2", "a3"]);
    expect(
      await countMemories(db, [testPartition], { after: "2026-08-10" }),
    ).toBe(2);
  });

  it("before= excludes newer rows and is inclusive on the boundary", async () => {
    seed([
      memory("b1", "/t/early", "2026-08-10T00:00:00.000Z"),
      memory("b2", "/t/at-boundary", "2026-08-12T00:00:00.000Z"),
      memory("b3", "/t/newer", "2026-08-13T00:00:00.000Z"),
    ]);

    const rows = await queryMemories(db, [testPartition], {
      before: "2026-08-12",
      limit: 10,
    });
    expect(rows.map((r) => r.id).sort()).toEqual(["b1", "b2"]);
    expect(
      await countMemories(db, [testPartition], { before: "2026-08-12" }),
    ).toBe(2);
  });

  it("after+before windows the result and the count matches", async () => {
    seed([
      memory("w1", "/t/out-before", "2026-08-09T00:00:00.000Z"),
      memory("w2", "/t/in-1", "2026-08-10T12:00:00.000Z"),
      memory("w3", "/t/in-2", "2026-08-11T12:00:00.000Z"),
      memory("w4", "/t/out-after", "2026-08-13T00:00:00.000Z"),
    ]);

    const rows = await queryMemories(db, [testPartition], {
      after: "2026-08-10",
      before: "2026-08-12",
      limit: 10,
    });
    expect(rows.map((r) => r.id).sort()).toEqual(["w2", "w3"]);
    expect(
      await countMemories(db, [testPartition], {
        after: "2026-08-10",
        before: "2026-08-12",
      }),
    ).toBe(2);
  });

  it("compares timestamps as TIMESTAMPs — +00:00 rows at the bound are included", async () => {
    // The chat-archive corpus mixes formats: `.749Z` and `.676525+00:00`
    // denote the SAME instant. A lexicographic string compare would rank
    // `…+00:00` BELOW `…Z` (0x2B '+' < 0x5A 'Z') and wrongly EXCLUDE the
    // +00:00 row from an inclusive after=…Z bound. try_cast parses both
    // to the same TIMESTAMP, so the boundary row must be included.
    seed([
      memory("fmt1", "/t/plus00", "2026-08-07T09:27:00.749+00:00"),
      memory("fmt2", "/t/zulu", "2026-08-07T09:27:00.749Z"),
      memory("fmt3", "/t/earlier", "2026-08-07T09:27:00.500Z"),
    ]);

    const rows = await queryMemories(db, [testPartition], {
      after: "2026-08-07T09:27:00.749Z",
      limit: 10,
    });
    expect(rows.map((r) => r.id).sort()).toEqual(["fmt1", "fmt2"]);
  });

  it("chat-archive date facets match since/until even when the row timestamp is ingestion time", async () => {
    // The record's timestamp is when the archive job INGESTED the chat
    // (2026-08-07); the message date lives in the key facet (2026-05-24).
    seed([
      memory(
        "chat1",
        "/chats/karahermes-dm/2026-05-24/part-1",
        "2026-08-07T09:26:22.496Z",
      ),
      memory(
        "chat2",
        "/chats/karahermes-dm/2026-05-24/part-2",
        "2026-08-07T09:26:22.577Z",
      ),
      memory(
        "chat3",
        "/chats/karahermes-dm/2026-06-01",
        "2026-08-07T09:26:22.611Z",
      ),
      memory("plain", "/notes/alpha", "2026-05-24T10:00:00.000Z"),
    ]);

    // Window covers 2026-05-24 (facet) — chat1+chat2 match by facet date,
    // plain matches by its own timestamp. chat3 (2026-06-01) is out.
    // Bounds are the NORMALIZED form parseTimeRange produces for
    // after=2026-05-24&before=2026-05-24 (before date-only → end of day).
    const rows = await queryMemories(db, [testPartition], {
      after: "2026-05-24T00:00:00.000Z",
      before: "2026-05-24T23:59:59.999Z",
      limit: 10,
    });
    expect(rows.map((r) => r.id).sort()).toEqual(["chat1", "chat2", "plain"]);
    expect(
      await countMemories(db, [testPartition], {
        after: "2026-05-24T00:00:00.000Z",
        before: "2026-05-24T23:59:59.999Z",
      }),
    ).toBe(3);

    // A window that excludes 2026-05-24 drops the facet matches entirely —
    // even though all four row timestamps fall inside 2026-08.
    const later = await queryMemories(db, [testPartition], {
      after: "2026-06-01T00:00:00.000Z",
      before: "2026-06-01T23:59:59.999Z",
      limit: 10,
    });
    expect(later.map((r) => r.id)).toEqual(["chat3"]);
  });

  it("applies the window inside the dedup — the latest in-window record wins", async () => {
    seed([
      memory("v1", "/notes/versioned", "2026-08-01T00:00:00.000Z"),
      memory("v1", "/notes/versioned", "2026-08-20T00:00:00.000Z"),
      memory("v2", "/notes/other", "2026-08-15T00:00:00.000Z"),
    ]);

    // The 2026-08-20 update is outside the window; the in-window record
    // (2026-08-01) is the one that surfaces — not dropped entirely.
    const rows = await queryMemories(db, [testPartition], {
      after: "2026-08-01",
      before: "2026-08-10",
      limit: 10,
    });
    expect(rows.map((r) => r.id)).toEqual(["v1"]);
    expect(
      await countMemories(db, [testPartition], {
        after: "2026-08-01",
        before: "2026-08-10",
      }),
    ).toBe(1);
  });

  it("excludes tombstoned memories inside the window", async () => {
    seed([
      memory("t1", "/t/dead", "2026-08-11T00:00:00.000Z"),
      memory("t1", "/t/dead", "2026-08-12T00:00:00.000Z", "tombstone"),
      memory("t2", "/t/alive", "2026-08-12T00:00:00.000Z"),
    ]);

    const rows = await queryMemories(db, [testPartition], {
      after: "2026-08-10",
      before: "2026-08-13",
      limit: 10,
    });
    expect(rows.map((r) => r.id)).toEqual(["t2"]);
  });

  it("combines time filters with other filters (keyPrefix)", async () => {
    seed([
      memory("p1", "/proj/alpha", "2026-08-10T00:00:00.000Z"),
      memory("p2", "/proj/beta", "2026-08-11T00:00:00.000Z"),
      memory("p3", "/other/gamma", "2026-08-11T00:00:00.000Z"),
    ]);

    const rows = await queryMemories(db, [testPartition], {
      keyPrefix: "/proj/",
      after: "2026-08-11",
      limit: 10,
    });
    expect(rows.map((r) => r.id)).toEqual(["p2"]);
  });
});
