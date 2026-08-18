/**
 * RETR-005 Regression Tests: recency-aware ordering at the query layer.
 *
 * Guards src/duckdb/queries.ts and src/mcp/tools/list_keys.ts:
 *   - listing paths (exact-key, glob/keyPrefix, domain, plain list) return
 *     NEWEST-first by default — before RETR-005 they had no ORDER BY and
 *     surfaced rows in read_json file order (oldest-first on appended
 *     JSONL, live-probed 08-02)
 *   - the glob/prefix surface (list_keys distinct-key listing) is
 *     recency-ordered too, by each key's newest live record
 *   - mixed timestamp formats (.749Z vs .676525+00:00) order as INSTANTS,
 *     not lexicographic strings (same try_cast approach as RETR-003 — a
 *     string sort would misorder `…+00:00` below `…Z` at the same instant)
 *   - equal timestamps fall back to id ascending (fully deterministic)
 *   - dedup/tombstone semantics are untouched: the surfaced (latest,
 *     non-tombstone) record determines the position
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { initDuckDB, closeDuckDB } from "./connection";
import { insertMemory, queryMemories } from "./queries";
import type { MemoryType } from "../schema/memory";
import { listKeysTool } from "../mcp/tools/list_keys";
import path from "path";
import fs from "fs";
import os from "os";

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

describe("RETR-005: recency-aware listing — queryMemories", () => {
  let db: any;
  const testPartition = path.join(process.cwd(), "test-memory-recency");

  beforeAll(async () => {
    db = await initDuckDB(":memory:");
  });

  beforeEach(() => {
    // Fresh partition per test — seeded rows must not accumulate across
    // tests (the plain-listing assertion needs an exact row set).
    if (fs.existsSync(testPartition)) {
      fs.rmSync(testPartition, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    if (db) await closeDuckDB(db);
    if (fs.existsSync(testPartition)) {
      fs.rmSync(testPartition, { recursive: true, force: true });
    }
  });

  function seed(records: MemoryType[]): void {
    for (const r of records) insertMemory(db, r, testPartition);
  }

  it("exact-key listing returns newest first (was oldest-first)", async () => {
    seed([
      memory("oldest", "/notes/same-key", "2026-08-01T00:00:00.000Z"),
      memory("middle", "/notes/same-key", "2026-08-10T00:00:00.000Z"),
      memory("newest", "/notes/same-key", "2026-08-20T00:00:00.000Z"),
    ]);

    const rows = await queryMemories(db, [testPartition], {
      key: "/notes/same-key",
      limit: 10,
    });
    expect(rows.map((r) => r.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("glob/keyPrefix listing returns newest first", async () => {
    seed([
      memory("g1", "/proj/alpha", "2026-08-01T00:00:00.000Z"),
      memory("g2", "/proj/beta", "2026-08-05T00:00:00.000Z"),
      memory("g3", "/proj/gamma", "2026-08-09T00:00:00.000Z"),
      memory("g4", "/other/delta", "2026-08-20T00:00:00.000Z"),
    ]);

    const rows = await queryMemories(db, [testPartition], {
      keyPrefix: "/proj/",
      limit: 10,
    });
    expect(rows.map((r) => r.id)).toEqual(["g3", "g2", "g1"]);
  });

  it("plain and domain listing legs are newest-first too", async () => {
    seed([
      memory("d1", "/dom/person", "2026-08-01T00:00:00.000Z"),
      memory("d2", "/dom/event", "2026-08-02T00:00:00.000Z"),
      memory("d3", "/dom/person", "2026-08-03T00:00:00.000Z"),
    ]);

    const all = await queryMemories(db, [testPartition], { limit: 10 });
    expect(all.map((r) => r.id)).toEqual(["d3", "d2", "d1"]);

    const persons = await queryMemories(db, [testPartition], {
      domain: "message",
      keyPrefix: "/dom/",
      limit: 10,
    });
    expect(persons.map((r) => r.id)).toEqual(["d3", "d2", "d1"]);
  });

  it("mixed timestamp formats order as instants, not strings (RETR-003 try_cast semantics)", async () => {
    // `.749525+00:00` is NEWER than `.749Z` at the same second (microsecond
    // fraction vs millisecond). A lexicographic sort misorders them: after
    // the common `.749` prefix it compares 'Z' (0x5A) against '5' (0x35),
    // so `.749Z` sorts ABOVE the newer `.749525+00:00` row — a string DESC
    // would wrongly put the OLDER row first. try_cast parses both to
    // TIMESTAMPs and orders them as instants.
    seed([
      memory("zulu", "/fmt/z", "2026-08-07T09:27:00.749Z"),
      memory("micros", "/fmt/m", "2026-08-07T09:27:00.749525+00:00"),
      memory("earlier", "/fmt/e", "2026-08-07T09:27:00.500Z"),
    ]);

    const rows = await queryMemories(db, [testPartition], {
      keyPrefix: "/fmt/",
      limit: 10,
    });
    expect(rows.map((r) => r.id)).toEqual(["micros", "zulu", "earlier"]);
  });

  it("equal timestamps fall back to id ascending (deterministic)", async () => {
    const sameTs = "2026-08-15T12:00:00.000Z";
    seed([
      memory("c-id", "/tie/c", sameTs),
      memory("a-id", "/tie/a", sameTs),
      memory("b-id", "/tie/b", sameTs),
    ]);

    const rows = await queryMemories(db, [testPartition], {
      keyPrefix: "/tie/",
      limit: 10,
    });
    expect(rows.map((r) => r.id)).toEqual(["a-id", "b-id", "c-id"]);
  });

  it("dedup + tombstone semantics survive: latest non-tombstone record decides", async () => {
    seed([
      // v1 updated over time — the 08-20 record surfaces.
      memory("v1", "/ver/dupe", "2026-08-01T00:00:00.000Z"),
      memory("v1", "/ver/dupe", "2026-08-20T00:00:00.000Z"),
      // dead is tombstoned after its last live record — excluded entirely.
      memory("dead", "/ver/dead", "2026-08-10T00:00:00.000Z"),
      memory("dead", "/ver/dead", "2026-08-12T00:00:00.000Z", "tombstone"),
      // newer-than-v1's update, but tombstoned — must NOT win.
      memory("dead2", "/ver/dead2", "2026-08-21T00:00:00.000Z"),
      memory("dead2", "/ver/dead2", "2026-08-22T00:00:00.000Z", "tombstone"),
    ]);

    const rows = await queryMemories(db, [testPartition], {
      keyPrefix: "/ver/",
      limit: 10,
    });
    expect(rows.map((r) => r.id)).toEqual(["v1"]);
    expect(rows[0].timestamp).toBe("2026-08-20T00:00:00.000Z");
  });
});

describe("RETR-005: recency-aware listing — list_keys glob surface", () => {
  const nsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-retr005-"));
  const ns = "retr005-ns";
  const partition = path.join(nsRoot, ns, "concept", "2026-08");
  const manifest = path.join(nsRoot, ns, "manifest.json");

  beforeAll(() => {
    process.env.DUCKBRAIN_NAMESPACES_PATH = nsRoot;
    fs.mkdirSync(partition, { recursive: true });
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        partitions: ["concept/2026-08"],
        lastUpdated: new Date().toISOString(),
      }),
      "utf8",
    );
  });

  afterAll(() => {
    delete process.env.DUCKBRAIN_NAMESPACES_PATH;
    fs.rmSync(nsRoot, { recursive: true, force: true });
  });

  it("distinct keys surface by their newest live record (newest key first)", async () => {
    // Written in OLDEST-first file order — the pre-RETR-005 listing
    // returned exactly this order (alphabetical-insertion).
    const lines =
      [
        {
          id: "k1",
          key: "/keys/alpha",
          domain: "concept",
          timestamp: "2026-08-01T00:00:00.000Z",
          author: "retr005@test.local",
          action: "add",
          embedding_text: "alpha",
          attributes: {},
        },
        {
          id: "k2",
          key: "/keys/bravo",
          domain: "concept",
          timestamp: "2026-08-10T00:00:00.000Z",
          author: "retr005@test.local",
          action: "add",
          embedding_text: "bravo",
          attributes: {},
        },
        {
          id: "k3",
          key: "/keys/charlie",
          domain: "concept",
          timestamp: "2026-08-20T00:00:00.000Z",
          author: "retr005@test.local",
          action: "add",
          embedding_text: "charlie",
          attributes: {},
        },
        {
          id: "gone",
          key: "/keys/tombstoned",
          domain: "concept",
          timestamp: "2026-08-25T00:00:00.000Z",
          author: "retr005@test.local",
          action: "tombstone",
          embedding_text: "",
          attributes: {},
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n";
    fs.writeFileSync(path.join(partition, "current.jsonl"), lines, "utf8");

    const result = await listKeysTool({
      namespace: ns,
      prefix: "/keys/",
      limit: 10,
    });
    expect(result.error).toBeUndefined();
    // Newest live record first; the tombstoned key is excluded (its only
    // record is a tombstone).
    expect(result.keys).toEqual([
      "/keys/charlie",
      "/keys/bravo",
      "/keys/alpha",
    ]);
  });

  it("equal-timestamp keys fall back to key ascending (deterministic)", async () => {
    const sameTs = "2026-08-15T00:00:00.000Z";
    const extra =
      [
        {
          id: "e1",
          key: "/keys/zulu",
          domain: "concept",
          timestamp: sameTs,
          author: "retr005@test.local",
          action: "add",
          embedding_text: "zulu",
          attributes: {},
        },
        {
          id: "e2",
          key: "/keys/alpha2",
          domain: "concept",
          timestamp: sameTs,
          author: "retr005@test.local",
          action: "add",
          embedding_text: "alpha2",
          attributes: {},
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n";
    fs.appendFileSync(path.join(partition, "current.jsonl"), extra, "utf8");

    const result = await listKeysTool({
      namespace: ns,
      prefix: "/keys/",
      limit: 20,
    });
    expect(result.error).toBeUndefined();
    // charlie (08-20) is still newest; the two 08-15 keys tie and fall
    // back to key ascending; then bravo (08-10), alpha (08-01).
    expect(result.keys).toEqual([
      "/keys/charlie",
      "/keys/alpha2",
      "/keys/zulu",
      "/keys/bravo",
      "/keys/alpha",
    ]);
  });
});
