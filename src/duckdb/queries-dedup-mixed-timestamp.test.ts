/**
 * SYNC-2026-09-28-001 — dedup window must order timestamps as INSTANTS.
 *
 * The dedup window in `queryMemories` / `countMemories` /
 * `queryMemoriesWithTotal` (and the read-only `query-surface.ts` view)
 * used to pick the "latest" version per id with a LEXICOGRAPHIC
 * `ORDER BY timestamp DESC` over the all-VARCHAR `timestamp` column.
 * For a single id written by different writers with mixed timestamp
 * formats (`.749Z` vs `.749525+00:00`, RETR-003), the string sort compares
 * `Z` (0x5A) against `5` (0x35) after the common `.749` prefix and ranks
 * the OLDER `.749Z` row first — so the genuinely newer version was hidden
 * by the dedup and a freshly-acked write became invisible to recall.
 *
 * The fix orders the dedup window by `try_cast(timestamp AS TIMESTAMP) DESC
 * NULLS LAST` — the same temporal ordering the page ORDER BY already used —
 * so mixed-format timestamps order as instants and the newest version wins.
 *
 * Rows are seeded as RAW JSONL (not via `insertMemory`/the serializer) so the
 * test can exercise timestamps the write path would never emit but the read
 * path must still tolerate (mixed formats, NULL/missing timestamps from
 * external writers or torn lines).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDuckDB, closeDuckDB } from "./connection";
import { queryMemories, countMemories } from "./queries";
import path from "path";
import fs from "fs";
import os from "os";

interface RawRow {
  id: string;
  key: string;
  timestamp: string | null;
  action?: "add" | "update" | "tombstone";
}

function line(row: RawRow): string {
  return (
    JSON.stringify({
      id: row.id,
      key: row.key,
      domain: "message",
      timestamp: row.timestamp,
      author: "test@example.com",
      action: row.action ?? "add",
      embedding_text: `record ${row.id}`,
      attributes: { tag: row.id },
    }) + "\n"
  );
}

const OLDER_ID = "00000000-0000-4000-8000-0000000000a1";
const TOMB_ID = "00000000-0000-4000-8000-0000000000a2";
const NULL_ID = "00000000-0000-4000-8000-0000000000a3";

describe("SYNC-2026-09-28-001: dedup keeps the newest version across mixed timestamp formats", () => {
  let db: any;
  const partition = fs.mkdtempSync(
    path.join(os.tmpdir(), "duckbrain-dedup-mixed-"),
  );

  beforeAll(async () => {
    db = await initDuckDB(":memory:");
  });

  beforeEach(() => {
    // Fresh file per test so seeded rows never accumulate.
    const f = path.join(partition, "current.jsonl");
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  });

  afterAll(async () => {
    if (db) await closeDuckDB(db);
    fs.rmSync(partition, { recursive: true, force: true });
  });

  function seed(lines: string[]): void {
    fs.appendFileSync(
      path.join(partition, "current.jsonl"),
      lines.join(""),
      "utf-8",
    );
  }

  it("same id, mixed formats: the NEWER (+00:00 microsecond) version wins, not the lexicographically-last Z version", async () => {
    seed([
      // OLDER: .749Z = 749.000ms.
      line({
        id: OLDER_ID,
        key: "/dedup/mixed",
        timestamp: "2026-08-07T09:27:00.749Z",
      }),
      // NEWER: .749525+00:00 = 749.525ms. A lexicographic DESC sorts the
      // '.749Z' row first ('Z' 0x5A > '5' 0x35) and would hide this one.
      line({
        id: OLDER_ID,
        key: "/dedup/mixed",
        timestamp: "2026-08-07T09:27:00.749525+00:00",
      }),
    ]);

    const rows = await queryMemories(db, [partition], {
      key: "/dedup/mixed",
      limit: 10,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].timestamp).toBe("2026-08-07T09:27:00.749525+00:00");
  });

  it("count agrees with the query: exactly one live version survives the dedup", async () => {
    seed([
      line({
        id: OLDER_ID,
        key: "/dedup/mixed",
        timestamp: "2026-08-07T09:27:00.749Z",
      }),
      line({
        id: OLDER_ID,
        key: "/dedup/mixed",
        timestamp: "2026-08-07T09:27:00.749525+00:00",
      }),
    ]);

    const total = await countMemories(db, [partition], {
      key: "/dedup/mixed",
    });
    expect(total).toBe(1);
  });

  it("a mixed-format TOMBSTONE still outranks an older add and excludes the memory", async () => {
    seed([
      line({
        id: TOMB_ID,
        key: "/dedup/tomb",
        timestamp: "2026-08-10T00:00:00.749Z",
      }),
      // Tombstone at a NEWER instant, but lexicographically EARLIER.
      line({
        id: TOMB_ID,
        key: "/dedup/tomb",
        timestamp: "2026-08-10T00:00:00.749525+00:00",
        action: "tombstone",
      }),
    ]);

    const rows = await queryMemories(db, [partition], {
      keyPrefix: "/dedup/tomb",
      limit: 10,
    });
    expect(rows).toHaveLength(0);
  });

  it("a parseable new version outranks an unparseable (NULL) old version", async () => {
    // First version has a NULL timestamp (external writer / torn line);
    // NULLS LAST must never let it win over a later parseable version.
    seed([
      line({ id: NULL_ID, key: "/dedup/null", timestamp: null }),
      line({
        id: NULL_ID,
        key: "/dedup/null",
        timestamp: "2026-08-20T00:00:00.000Z",
      }),
    ]);

    const rows = await queryMemories(db, [partition], {
      key: "/dedup/null",
      limit: 10,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].timestamp).toBe("2026-08-20T00:00:00.000Z");
  });
});
