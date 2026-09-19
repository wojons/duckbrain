/**
 * DB-GAP-053 regression: squashPartition() must write the compacted Parquet
 * in a DETERMINISTIC, CHRONOLOGICAL row order.
 *
 * Root cause: the compaction COPY was
 *   COPY (SELECT * FROM records WHERE action NOT IN ('tombstone','forget')) TO ...
 * with no ORDER BY — the row order inside the compacted artifact was
 * engine-determined (whatever the read_json scan over the JSONL file list
 * produced, potentially parallel and version-dependent).
 *
 * Fix: ORDER BY try_cast(timestamp AS TIMESTAMP) ASC NULLS LAST, id ASC —
 * the same doctrine as the RETR-005 read path (DEFAULT_ORDER_BY in
 * src/duckdb/queries.ts):
 *   - the timestamp is compared PARSED, not as text: the chat-archive corpus
 *     mixes formats ('.749Z' vs '.676525+00:00', RETR-003), and a
 *     lexicographic sort misorders those (0x2B '+' < 0x5A 'Z');
 *   - NULLS LAST pins rows with an unparseable/missing timestamp at the
 *     bottom deterministically (the COPY must not crash on them either);
 *   - `id ASC` is the stable tiebreaker for equal parsed instants — the
 *     records view (all-VARCHAR READ_JSON_COLUMNS) exposes no ingest
 *     ordinal, and ids are unique per record, so (parsed timestamp, id) is
 *     a total order.
 *
 * The tests squash scratch partitions under a temp dir directly (same
 * pattern as squash-ordering.test.ts / squash-dogfood019.test.ts — no HTTP
 * server, manifest found by walking up). Parquet preserves row order on a
 * plain scan, so reading the artifact back with read_parquet (no ORDER BY)
 * observes exactly the order the COPY wrote.
 */

import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { squashPartition } from "./squash";
import { closeAllConnections, getDuckDBConnection } from "../duckdb/connection";

let root: string;

function manifest(nsDir: string, partitionRel: string): void {
  fs.writeFileSync(
    path.join(nsDir, "manifest.json"),
    JSON.stringify({
      version: "1.0",
      createdAt: "2026-09-19T00:00:00.000Z",
      partitions: [partitionRel],
      lastUpdated: "2026-09-19T00:00:00.000Z",
    }),
    "utf-8",
  );
}

/**
 * A record whose timestamp is given EXPLICITLY (the mixed-format corpus is
 * the point of this regression), not derived from an epoch.
 */
function recordAt(id: number, timestamp: string, action = "add"): string {
  return JSON.stringify({
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    key: `/event/order/${id}`,
    domain: "event",
    timestamp,
    author: "test@example.com",
    action,
    embedding_text: `order record ${id}`,
    attributes: {},
  });
}

/** Read the compacted Parquet back in stored order (read_parquet scan order). */
function parquetIds(parquetPath: string): Promise<string[]> {
  const db = getDuckDBConnection("singleton", path.dirname(parquetPath));
  return new Promise<string[]>((resolve, reject) => {
    db.all(
      `SELECT id FROM read_parquet('${parquetPath.replace(/\\/g, "/")}')`,
      (err: any, rows: any[]) => {
        if (err) reject(err);
        else resolve((rows || []).map((r: any) => r.id));
      },
    );
  });
}

function nsDirFor(name: string): string {
  return path.join(root, name, "default");
}

afterAll(async () => {
  // Squash leaves cached scratch connections behind; release them before the
  // temp tree goes away so no reader touches deleted paths.
  await closeAllConnections();
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("DB-GAP-053: compacted Parquet row order is deterministic and chronological", () => {
  it("orders rows by parsed timestamp even when segments are written out of order", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-dbgap053-"));
    const nsDir = nsDirFor("chrono");
    const partitionRel = "event/2026-09";
    const partitionPath = path.join(nsDir, partitionRel);
    fs.mkdirSync(partitionPath, { recursive: true });
    manifest(nsDir, partitionRel);

    // Timestamps ASCEND with the record number, but the LOWER-numbered
    // segment holds the LATER records: the file list is numeric-ordered, so
    // a COPY without ORDER BY emits 4,5,6,1,2,3 — the pre-fix engine scan
    // order — while the contract requires chronological 1..6.
    fs.writeFileSync(
      path.join(partitionPath, "0001.jsonl"),
      `${recordAt(4, "2026-01-04T00:00:00.000Z")}\n${recordAt(5, "2026-01-05T00:00:00.000Z")}\n${recordAt(6, "2026-01-06T00:00:00.000Z")}\n`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(partitionPath, "10000.jsonl"),
      `${recordAt(1, "2026-01-01T00:00:00.000Z")}\n${recordAt(2, "2026-01-02T00:00:00.000Z")}\n${recordAt(3, "2026-01-03T00:00:00.000Z")}\n`,
      "utf-8",
    );

    const result = await squashPartition(partitionPath, {
      dryRun: false,
      squashCommits: false,
    });
    expect(result.success).toBe(true);
    if (!result.success) return; // TS narrowing
    expect(result.recordsKept).toBe(6);

    const ids = await parquetIds(result.parquetPath as string);
    expect(ids).toEqual(
      Array.from(
        { length: 6 },
        (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      ),
    );
  });

  it("gives a deterministic total order for mixed ISO shapes, timestamp ties, and unparseable timestamps", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-dbgap053-"));
    const nsDir = nsDirFor("mixed");
    const partitionRel = "event/2026-09";
    const partitionPath = path.join(nsDir, partitionRel);
    fs.mkdirSync(partitionPath, { recursive: true });
    manifest(nsDir, partitionRel);

    // Mirror of the RETR-003 mixed-format corpus plus hostile edge cases:
    //  - id 1 / id 4: the two documented chat-archive shapes for the SAME
    //    wall-clock hour (a text ORDER BY would put '+00:00' before 'Z');
    //  - id 2 / id 7: EQUAL parsed instants written in DIFFERENT shapes
    //    ('.000Z' vs '.000000+00:00') — the id tiebreaker decides;
    //  - id 3 / id 5: genuinely distinct instants;
    //  - id 9 / id 10: unparseable/absent timestamps — must sort LAST,
    //    deterministically by id, and must not crash the COPY.
    // Segments interleave everything so no single file is already ordered.
    fs.writeFileSync(
      path.join(partitionPath, "0001.jsonl"),
      [
        recordAt(5, "2023-11-14T22:13:21.500Z"),
        recordAt(2, "2023-11-14T22:13:20.000Z"),
        recordAt(9, "not-a-timestamp"),
        recordAt(4, "2023-11-14T22:13:22.749Z"),
      ].join("\n") + "\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(partitionPath, "0002.jsonl"),
      [
        recordAt(3, "2023-11-14T22:13:21.000Z"),
        recordAt(1, "2023-11-14T22:13:19.676525+00:00"),
        recordAt(7, "2023-11-14T22:13:20.000000+00:00"),
        recordAt(10, ""),
      ].join("\n") + "\n",
      "utf-8",
    );

    const result = await squashPartition(partitionPath, {
      dryRun: false,
      squashCommits: false,
    });
    expect(result.success).toBe(true);
    if (!result.success) return; // TS narrowing

    const ids = await parquetIds(result.parquetPath as string);
    const idNum = (hex: string) => parseInt(hex.slice(-12), 10);
    expect(ids.map(idNum)).toEqual([1, 2, 7, 3, 5, 4, 9, 10]);
  });

  it("produces byte-identical Parquet for repeated squashes of identical input", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-dbgap053-"));

    const buildIdenticalPartition = (nsName: string): string => {
      const nsDir = nsDirFor(nsName);
      const partitionRel = "event/2026-09";
      const partitionPath = path.join(nsDir, partitionRel);
      fs.mkdirSync(partitionPath, { recursive: true });
      manifest(nsDir, partitionRel);
      // Same fixture shape as squash-ordering.test.ts (segments straddling
      // the 9999/10000 numeric boundary) plus two unparseable timestamps —
      // ties in the sort key are exactly where an unstable order diverges.
      fs.writeFileSync(
        path.join(partitionPath, "9999.jsonl"),
        [
          recordAt(1, "2026-03-01T00:00:00.000Z"),
          recordAt(99, "2026-03-09T00:00:00.000Z", "tombstone"),
          recordAt(11, "not-a-timestamp"),
        ].join("\n") + "\n",
        "utf-8",
      );
      fs.writeFileSync(
        path.join(partitionPath, "10000.jsonl"),
        [
          recordAt(2, "2026-03-02T00:00:00.000Z"),
          recordAt(3, "2026-03-03T00:00:00.000Z"),
          recordAt(10, ""),
        ].join("\n") + "\n",
        "utf-8",
      );
      return partitionPath;
    };

    const run1 = await squashPartition(buildIdenticalPartition("run1"), {
      dryRun: false,
      squashCommits: false,
    });
    const run2 = await squashPartition(buildIdenticalPartition("run2"), {
      dryRun: false,
      squashCommits: false,
    });
    expect(run1.success).toBe(true);
    expect(run2.success).toBe(true);
    if (!run1.success || !run2.success) return;

    // Byte-identical artifact = identical content AND identical length. The
    // filename embeds Date.now(), so compare file bytes, not names.
    const bytes1 = fs.readFileSync(run1.parquetPath as string);
    const bytes2 = fs.readFileSync(run2.parquetPath as string);
    expect(bytes1.equals(bytes2)).toBe(true);
  });
});
