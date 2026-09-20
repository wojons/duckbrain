/**
 * GAP-054 Regression Tests: stale-sidecar keyword search must degrade, not throw.
 *
 * RETR-011 added valid_from/valid_until to the FTS sidecar and guarded the
 * WHERE clause with `sidecarHasValidityColumns()`. But ROW_COLUMNS projected
 * those columns UNCONDITIONALLY, and DuckDB binds the projection before it
 * evaluates predicates — so a namespace whose sidecar predates RETR-011 made
 * the entire search fail:
 *
 *   Binder Error: Referenced column "valid_from" not found in FROM clause!
 *   Candidate bindings: "id", "action"
 *
 * That turned a single stale namespace into a hard 500 for BOTH the
 * single-namespace search and the cross-namespace union (chat-archive in the
 * live fleet was exactly this shape). The fix projects
 * `NULL AS valid_from, NULL AS valid_until` when the sidecar lacks them, so
 * the WHERE guard and the projection always agree.
 *
 * These tests build a REAL sidecar, then simulate a pre-RETR-011 sidecar by
 * dropping the two columns, and assert:
 *   - single-namespace keywordSearch still returns hits
 *   - the cross-namespace union still returns hits
 *   - validity-scoped reads (historical=false) don't error out
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import duckdb from "duckdb";
import { rebuildNamespaceIndex, indexDbPath } from "./index";
import { keywordSearch, keywordSearchAllNamespaces } from "./query";

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const NS = path.join(NS_ROOT, "search-gap054-stale");

function mem(id: string, key: string, text: string, ts: string): string {
  return JSON.stringify({
    id,
    key,
    domain: "raw_note",
    timestamp: ts,
    author: "test@example.com",
    action: "add",
    embedding_text: text,
    attributes: {},
  });
}

function writeNamespace(): void {
  const partition = path.join(NS, "concept", "2026-08");
  fs.mkdirSync(partition, { recursive: true });
  fs.writeFileSync(
    path.join(partition, "current.jsonl"),
    [
      mem("s1", "/stale/one", "stale sidecar durability probe", "2026-08-01T00:00:00.000Z"),
      mem("s2", "/stale/two", "another stale sidecar row", "2026-08-02T00:00:00.000Z"),
    ].join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(NS, "manifest.json"),
    JSON.stringify({
      partitions: ["concept/2026-08"],
      lastUpdated: new Date().toISOString(),
    }),
  );
}

/** Rewrite the sidecar's memories table WITHOUT the RETR-011 validity columns. */
function degradeSidecarToPreRetr011(nsPath: string): Promise<void> {
  const dbPath = indexDbPath(nsPath);
  return new Promise((resolve, reject) => {
    const db = new duckdb.Database(dbPath, (err: any) => {
      if (err) return reject(err);
      db.all("PRAGMA table_info(memories)", (e: any, cols: any[]) => {
        if (e) return reject(e);
        const names = cols.map((c: any) => String(c.name));
        const keep = names.filter(
          (n: string) => n !== "valid_from" && n !== "valid_until",
        );
        const colList = keep.join(", ");
        const sqls = [
          "CREATE TABLE memories_pre AS SELECT " + colList + " FROM memories",
          "DROP TABLE memories",
          "CREATE TABLE memories AS SELECT * FROM memories_pre",
          "DROP TABLE memories_pre",
        ];
        const run = (i: number) => {
          if (i >= sqls.length) {
            db.close(() => resolve());
            return;
          }
          db.run(sqls[i], (e2: any) => (e2 ? reject(e2) : run(i + 1)));
        };
        run(0);
      });
    });
  });
}

beforeAll(async () => {
  writeNamespace();
  await rebuildNamespaceIndex(NS);
  await degradeSidecarToPreRetr011(NS);
});

afterAll(() => {
  fs.rmSync(NS, { recursive: true, force: true });
});

describe("GAP-054: pre-RETR-011 sidecar (missing validity columns)", () => {
  it("the sidecar really is missing the validity columns (fixture sanity)", async () => {
    const dbPath = indexDbPath(NS);
    const cols: string[] = await new Promise((resolve, reject) => {
      const db = new duckdb.Database(dbPath, { access_mode: "READ_ONLY" } as any);
      db.all("PRAGMA table_info(memories)", (e: any, rows: any[]) =>
        e ? reject(e) : resolve(rows.map((r: any) => String(r.name))),
      );
    });
    expect(cols).not.toContain("valid_from");
    expect(cols).not.toContain("valid_until");
    expect(cols).toContain("raw_text");
  });

  it("single-namespace keywordSearch returns hits instead of throwing", async () => {
    const res = await keywordSearch(NS, "stale sidecar");
    expect(res.memories.length).toBeGreaterThan(0);
    expect(res.memories.map((m) => m.id)).toContain("s1");
  });

  it("validity-scoped read (historical=false) does not error", async () => {
    const res = await keywordSearch(NS, "durability", { historical: false });
    expect(res.memories.map((m) => m.id)).toContain("s1");
  });

  it("cross-namespace union still returns hits (no hard 500)", async () => {
    const res = await keywordSearchAllNamespaces(NS_ROOT, "stale sidecar", {
      limit: 10,
    });
    expect(res.memories.map((m) => m.id)).toContain("s1");
    // The stale namespace is SEARCHED (it has an index), not skipped.
    expect(res.namespacesSkipped).not.toContain(path.basename(NS));
  });
});
