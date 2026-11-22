/**
 * PERF-DUCKBRAIN-003 — newest-segment bounded plain-list read.
 *
 * The bounded plain-list path (PERF-001) still handed EVERY chunk path to
 * read_json per request. This file pins the file-bound read:
 *   - a 500-chunk fixture partition passes fewer than 50 chunk paths to the
 *     read (AC3's letter), and a second identical limit=10 read performs no
 *     read-path chunk re-stats and no re-readdir (the directory-listing
 *     cache keyed by directory mtime);
 *   - page AND total stay byte-identical to the untouched fused statement
 *     across duplicate ids, tombstones, and slices;
 *   - when the newest-segment slice cannot PROVE it fills the page (an
 *     excluded chunk's mtime at/after the window cut — the backdated/future
 *     timestamp pathology), the read falls back to the full chunk list and
 *     the result is still byte-identical (AC2's own fallback);
 *   - an APPEND IN PLACE to an excluded chunk (invisible to any directory
 *     mtime) is still honored: the per-file (size, mtimeMs) freshness signal
 *     changes, so the page and total recompute — never a stale answer.
 *
 * Rows are seeded as RAW JSONL (not via insertMemory) exactly like
 * queries-plainlist-bounded-perf001.test.ts, so exact timestamps and
 * chunk-to-segment placement are pinned.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDuckDB, closeDuckDB } from "./connection";
import {
  queryMemoriesWithTotal,
  queryMemoriesWithTotalFused,
  collectJsonlFiles,
  __jsonlListingCacheForTests,
  __totalCacheForTests,
} from "./queries";
import path from "path";
import fs from "fs";
import os from "os";

interface SeedRow {
  id: string;
  key: string;
  timestamp: string;
  action?: "add" | "update" | "tombstone";
}

function line(row: SeedRow): string {
  return (
    JSON.stringify({
      id: row.id,
      key: row.key,
      domain: "event",
      timestamp: row.timestamp,
      author: "test@example.com",
      action: row.action ?? "add",
      embedding_text: `record ${row.id}`,
      attributes: {},
    }) + "\n"
  );
}

function fixtureId(label: string): string {
  return `00000000-0000-4000-8000-${Buffer.from(label)
    .toString("hex")
    .padEnd(12, "0")
    .slice(0, 12)}`;
}

/** Chunk paths handed to read_json, captured from the SQL of each statement. */
function pathsInSql(sql: string): string[] {
  const matches = sql.match(/'([^']+\.jsonl)'/g) ?? [];
  return matches.map((m) => m.slice(1, -1));
}

describe("PERF-DUCKBRAIN-003: newest-segment bounded plain-list read", () => {
  let db: any;
  const partition = fs.mkdtempSync(
    path.join(os.tmpdir(), "duckbrain-perf003-"),
  );
  const DAY = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    db = await initDuckDB(":memory:");
  });

  beforeEach(() => {
    fs.rmSync(partition, { recursive: true, force: true });
    fs.mkdirSync(partition, { recursive: true });
    __jsonlListingCacheForTests("reset");
    __totalCacheForTests("reset");
  });

  afterAll(async () => {
    if (db) await closeDuckDB(db);
    fs.rmSync(partition, { recursive: true, force: true });
  });

  /** Spy that records every SQL statement executed against db. */
  function captureSql(): string[] {
    const statements: string[] = [];
    const original = db.all.bind(db);
    db.all = (sql: string, cb: unknown) => {
      statements.push(sql);
      return original(sql, cb);
    };
    return statements;
  }

  /**
   * Build a partition of `chunks` segment files (numeric 0001.jsonl …
   * <chunks-1>.jsonl plus the trailing current.jsonl = exactly `chunks`
   * files). The newest `hotChunks` segments hold `hotRows` fresh rows; every
   * older segment holds one stale row and gets its mtime frozen `frozenDays`
   * days in the past.
   */
  function seedPartition(
    chunks: number,
    hotChunks: number,
    hotRows: number,
    frozenDays: number,
  ): { freshIds: string[]; staleIds: string[] } {
    const base = Date.now();
    const names: string[] = [];
    for (let i = 1; i < chunks; i += 1) {
      names.push(`${String(i).padStart(4, "0")}.jsonl`);
    }
    names.push("current.jsonl"); // compareChunkNames sorts it LAST (newest)

    const freshIds: string[] = [];
    const staleIds: string[] = [];
    const hotStart = chunks - hotChunks;
    let freshSeq = 0;
    names.forEach((name, idx) => {
      const isHot = idx >= hotStart;
      const rows: SeedRow[] = [];
      if (isHot) {
        for (let i = 0; i < hotRows; i += 1) {
          const id = fixtureId(`f${freshSeq}`);
          freshIds.push(id);
          rows.push({
            id,
            key: `/p/fresh/${idx}/${i}`,
            timestamp: new Date(base - freshSeq * 1000).toISOString(),
          });
          freshSeq += 1;
        }
      } else {
        const id = fixtureId(`s${idx}`);
        staleIds.push(id);
        rows.push({
          id,
          key: `/p/stale/${idx}`,
          timestamp: new Date(base - 30 * DAY).toISOString(),
        });
      }
      const full = path.join(partition, name);
      fs.appendFileSync(full, rows.map(line).join(""), "utf-8");
      if (!isHot) {
        // Freeze excluded segments' mtimes: append-time is the record-time
        // ceiling the slice proof relies on.
        fs.utimesSync(full, new Date(base - frozenDays * DAY), new Date(base - frozenDays * DAY));
      }
    });
    return { freshIds, staleIds };
  }

  it("a 500-chunk partition passes fewer than 50 chunk paths to the page read, the total is exact, and a second identical read re-stats no chunk and re-reads no directory", async () => {
    seedPartition(500, 8, 10, 30);

    // Classify captured statements: the bounded PAGE read carries a LIMIT;
    // the full-corpus exact-total scan (countLiveDeduped, fired once per
    // namespace state on the total cache's first request) does not.
    const pageReadsOf = (statements: string[]) =>
      statements
        .map((s) => ({ sql: s, paths: pathsInSql(s) }))
        .filter((r) => r.paths.length > 0 && /LIMIT/.test(r.sql));
    const totalScansOf = (statements: string[]) =>
      statements
        .map((s) => ({ sql: s, paths: pathsInSql(s) }))
        .filter((r) => r.paths.length > 0 && !/LIMIT/.test(r.sql));

    // Read 1: proved slice serves the page; the total pays ONE full-corpus
    // count (then it is cached under the audit's per-file stats).
    const statements1 = captureSql();
    const first = await queryMemoriesWithTotal(db, [partition], { limit: 10 });
    const sliceReads1 = pageReadsOf(statements1);
    expect(sliceReads1.length).toBeGreaterThan(0);
    // AC3: fewer than 50 chunk paths reach DuckDB for the page...
    for (const read of sliceReads1) {
      expect(read.paths.length).toBeLessThan(50);
    }
    // ...and the total came from exactly one full-corpus scan (all chunks).
    const totalScans1 = totalScansOf(statements1);
    expect(totalScans1.length).toBe(1);
    expect(totalScans1[0].paths.length).toBe(500);

    // ...and the page is the true newest page (the fused statement's).
    const fusedFiles = collectJsonlFiles([partition]);
    const fused = await queryMemoriesWithTotalFused(db, fusedFiles, {
      limit: 10,
    });
    expect(first.memories.map((m) => m.key).slice(0, 10)).toEqual(
      fused.memories.map((m) => m.key),
    );
    expect(first.total).toBe(fused.total);

    // AC3: the read path's OWN enumeration layer stats no chunk it did not
    // open on a second identical read — zero chunk stats, zero readdirs,
    // served from the directory-mtime listing cache, and the total comes
    // from the per-file-stat cache (no second full-corpus scan). The
    // corruption audit's own per-file statSync pass is corruption.ts's
    // mandated freshness check and is deliberately NOT part of this
    // counter — it is unchanged.
    __jsonlListingCacheForTests("reset");
    const statements2 = captureSql();
    const second = await queryMemoriesWithTotal(db, [partition], { limit: 10 });
    const metrics = __jsonlListingCacheForTests("peek");
    expect(metrics.chunkStats).toBe(0);
    expect(metrics.readdirs).toBe(0);
    expect(metrics.hits).toBe(1); // one partition dir, listing cache hit
    expect(totalScansOf(statements2).length).toBe(0); // total cache hit

    const sliceReads2 = pageReadsOf(statements2);
    for (const read of sliceReads2) {
      expect(read.paths.length).toBeLessThan(50);
      // The second read opens nothing the first read did not open.
      for (const p of read.paths) {
        expect(sliceReads1.flatMap((r) => r.paths)).toContain(p);
      }
    }
    // Byte-identical repeat: same page, same total.
    expect(JSON.stringify(second.memories)).toBe(
      JSON.stringify(first.memories),
    );
    expect(second.total).toBe(first.total);
  });

  it("page and total are byte-identical to the fused statement on a multi-segment corpus (dups + tombstone in the slice)", async () => {
    const base = Date.now();
    const dup = fixtureId("dup");
    const victim = fixtureId("victim");
    // 12 segments; newest 3 carry a 60-version duplicate chain, a fresh
    // tombstone, and distinct rows; older segments hold stale rows.
    const names: string[] = [];
    for (let i = 1; i < 12; i += 1) names.push(`${String(i).padStart(4, "0")}.jsonl`);
    names.push("current.jsonl");
    names.forEach((name, idx) => {
      const full = path.join(partition, name);
      let rows: SeedRow[] = [];
      if (idx === 9) {
        rows = Array.from({ length: 60 }, (_, i) => ({
          id: dup,
          key: "/p/dup",
          timestamp: new Date(base - i * 1000).toISOString(),
          action: i === 0 ? "add" : "update",
        }));
      } else if (idx === 10) {
        rows = [
          { id: victim, key: "/p/gone", timestamp: new Date(base - 1000).toISOString() },
          { id: victim, key: "/p/gone", timestamp: new Date(base - 2000).toISOString() },
          { action: "tombstone", id: victim, key: "/p/gone", timestamp: new Date(base - 500).toISOString() } as SeedRow,
          { id: fixtureId("live1"), key: "/p/live1", timestamp: new Date(base - 3000).toISOString() },
        ];
      } else if (idx === 11) {
        rows = [
          { id: fixtureId("live2"), key: "/p/live2", timestamp: new Date(base - 4000).toISOString() },
          { id: fixtureId("live3"), key: "/p/live3", timestamp: new Date(base - 5000).toISOString() },
        ];
      } else {
        rows = [
          {
            id: fixtureId(`s${idx}`),
            key: `/p/stale/${idx}`,
            timestamp: new Date(base - 30 * DAY).toISOString(),
          },
        ];
        fs.appendFileSync(full, rows.map(line).join(""), "utf-8");
        fs.utimesSync(full, new Date(base - 30 * DAY), new Date(base - 30 * DAY));
        return;
      }
      fs.appendFileSync(full, rows.map(line).join(""), "utf-8");
    });

    const files = collectJsonlFiles([partition]);
    const bounded = await queryMemoriesWithTotal(db, [partition], { limit: 10 });
    const fused = await queryMemoriesWithTotalFused(db, files, { limit: 10 });
    expect(JSON.stringify(bounded.memories)).toBe(
      JSON.stringify(fused.memories),
    );
    expect(bounded.total).toBe(fused.total);
    // The dup chain collapses to one and the tombstoned id is gone.
    expect(bounded.memories.some((m) => m.id === dup)).toBe(true);
    expect(bounded.memories.some((m) => m.id === victim)).toBe(false);
  });

  it("falls back to the full chunk list when the slice cannot prove it fills the page, and stays byte-identical", async () => {
    seedPartition(40, 8, 10, 30);
    // Poison the proof: an EXCLUDED segment with an mtime AT the fresh row
    // era — its rows could outrank the window cut, so no slice smaller than
    // the full list is provable.
    const poisoned = path.join(partition, "0005.jsonl");
    fs.utimesSync(poisoned, new Date(), new Date());

    const statements = captureSql();
    const bounded = await queryMemoriesWithTotal(db, [partition], { limit: 10 });
    const reads = statements.map(pathsInSql).filter((p) => p.length > 0);
    // The fallback must eventually read the poisoned segment.
    expect(reads.some((paths) => paths.includes(poisoned))).toBe(true);

    const files = collectJsonlFiles([partition]);
    const fused = await queryMemoriesWithTotalFused(db, files, { limit: 10 });
    expect(JSON.stringify(bounded.memories)).toBe(
      JSON.stringify(fused.memories),
    );
    expect(bounded.total).toBe(fused.total);
  });

  it("an append IN PLACE to an excluded chunk changes the page and the total (per-file freshness, never a directory signal)", async () => {
    seedPartition(40, 8, 10, 30);
    const staleChunk = path.join(partition, "0005.jsonl");

    const before = await queryMemoriesWithTotal(db, [partition], { limit: 10 });

    // Append a brand-new live id to the OLD, excluded segment. This changes
    // only that chunk's (size, mtimeMs) — the directory mtime is untouched.
    const appendedId = fixtureId("appended");
    const appendedRow: SeedRow = {
      id: appendedId,
      key: "/p/appended",
      timestamp: new Date().toISOString(),
    };
    fs.appendFileSync(staleChunk, line(appendedRow), "utf-8");

    const after = await queryMemoriesWithTotal(db, [partition], { limit: 10 });

    // The appended row must surface and the total must grow by exactly one.
    expect(after.memories.some((m) => m.id === appendedId)).toBe(true);
    expect(after.total).toBe(before.total + 1);

    const files = collectJsonlFiles([partition]);
    const fused = await queryMemoriesWithTotalFused(db, files, { limit: 10 });
    expect(JSON.stringify(after.memories)).toBe(
      JSON.stringify(fused.memories),
    );
    expect(after.total).toBe(fused.total);
  });

  /**
   * THE DAEMON-SHAPED REQUEST: the recall surface sets `historical=false`
   * and a fresh `now` on EVERY list request (RETR-011), so the validity
   * clause of the WHERE string carries a per-request instant. A total cache
   * keyed on the whole WHERE clause changes key per request and NEVER
   * serves — the exact defect this row's rework fixed. The key therefore
   * rides on the now-independent semantics, and validity is anchored by the
   * next boundary the count statement itself reports: the cached count is
   * served while now stays inside [computedAt, nextEdge) and recomputed —
   * exactly, with the row appearing/disappearing — at the first `now` past
   * the edge.
   */
  it("a moving per-request `now` still serves the cached total until the count's next validity boundary, at which point it recomputes exactly", async () => {
    seedPartition(300, 8, 10, 30); // 292 stale ids + 80 fresh ids
    const base = Date.now();

    // rowA expires at base+60s (counted now, dropped later); rowB becomes
    // valid at base+120s (dropped now, counted later). Both land in the
    // current (newest) segment with the newest timestamps.
    const expiringId = fixtureId("rowA");
    const futureId = fixtureId("rowB");
    const baseRecord = (id: string, key: string, ts: string) => ({
      id,
      key,
      domain: "event",
      timestamp: ts,
      author: "test@example.com",
      action: "add",
      embedding_text: `record ${id}`,
      attributes: {},
    });
    const validityLines =
      JSON.stringify({
        ...baseRecord(expiringId, "/p/validity/expiring", new Date(base + 5000).toISOString()),
        valid_until: new Date(base + 60_000).toISOString(),
      }) +
      "\n" +
      JSON.stringify({
        ...baseRecord(futureId, "/p/validity/future", new Date(base + 4000).toISOString()),
        valid_from: new Date(base + 120_000).toISOString(),
      }) +
      "\n";
    fs.appendFileSync(path.join(partition, "current.jsonl"), validityLines, "utf-8");

    const fullScansOf = (statements: string[]) =>
      statements
        .map((s) => ({ sql: s, paths: pathsInSql(s) }))
        .filter((r) => r.paths.length > 0 && !/LIMIT/.test(r.sql));
    const filtersAt = (now: number) => ({
      limit: 10,
      historical: false,
      now: new Date(now).toISOString(),
    });

    // One capture for the whole sequence; `mark` slices per-call windows
    // (nested captureSql wrappers would cross-contaminate the windows).
    const statements = captureSql();
    const mark = () => statements.length;

    // Call 1 (now = base): one full-corpus count (miss) under the exact
    // validity view. Stale + fresh + expiring (valid_until future); the
    // future row is not yet valid.
    const w1 = mark();
    const first = await queryMemoriesWithTotal(db, [partition], filtersAt(base));
    expect(fullScansOf(statements.slice(w1)).length).toBe(1);
    const totalAtBase = 292 + 80 + 1;
    expect(first.total).toBe(totalAtBase);
    expect(first.memories.some((m) => m.id === expiringId)).toBe(true);
    expect(first.memories.some((m) => m.id === futureId)).toBe(false);

    // Call 2 — the DAEMON shape: a LATER request instant whose validity view
    // provably contains no boundary (now within [computedAt, nextEdge)).
    // The cached total MUST serve: no second full-corpus scan, page and
    // total byte-identical.
    __jsonlListingCacheForTests("reset");
    const w2 = mark();
    const second = await queryMemoriesWithTotal(db, [partition], filtersAt(base + 5000));
    expect(fullScansOf(statements.slice(w2)).length).toBe(0);
    expect(second.total).toBe(totalAtBase);
    expect(JSON.stringify(second.memories)).toBe(JSON.stringify(first.memories));
    const cacheAfterTwo = __totalCacheForTests("peek");
    expect(cacheAfterTwo.hits).toBe(1);
    expect(cacheAfterTwo.misses).toBe(1);
    expect(cacheAfterTwo.entries).toBe(1);

    // Call 3 (now crosses the row's valid_until): the cache must NOT serve
    // the old count — the exact count recomputes and the expired row is
    // gone. Byte-identical to the fused statement under the same view.
    const w3 = mark();
    const third = await queryMemoriesWithTotal(db, [partition], filtersAt(base + 61_000));
    expect(fullScansOf(statements.slice(w3)).length).toBe(1);
    expect(third.total).toBe(totalAtBase - 1);
    expect(third.memories.some((m) => m.id === expiringId)).toBe(false);
    const filesAtNow3 = collectJsonlFiles([partition]);
    const fused3 = await queryMemoriesWithTotalFused(db, filesAtNow3, filtersAt(base + 61_000));
    expect(third.total).toBe(fused3.total);
    expect(JSON.stringify(third.memories)).toBe(JSON.stringify(fused3.memories));

    // Call 4 (now crosses rowB's valid_from): recompute, and the not-yet-
    // valid row ENTERS the count and the page.
    const w4 = mark();
    const fourth = await queryMemoriesWithTotal(db, [partition], filtersAt(base + 121_000));
    expect(fullScansOf(statements.slice(w4)).length).toBe(1);
    expect(fourth.total).toBe(totalAtBase);
    expect(fourth.memories.some((m) => m.id === futureId)).toBe(true);
    const filesAtNow4 = collectJsonlFiles([partition]);
    const fused4 = await queryMemoriesWithTotalFused(db, filesAtNow4, filtersAt(base + 121_000));
    expect(fourth.total).toBe(fused4.total);
    expect(JSON.stringify(fourth.memories)).toBe(JSON.stringify(fused4.memories));

    const seam = __totalCacheForTests("peek");
    expect(seam.hits).toBe(1);
    expect(seam.misses).toBe(3);
  });

  it("a corpus change still invalidates the cached total while a validity view is active (freshness outranks the boundary window)", async () => {
    seedPartition(40, 8, 10, 30);
    const base = Date.now();
    const filters = { limit: 10, historical: false, now: new Date(base).toISOString() };

    const first = await queryMemoriesWithTotal(db, [partition], filters);
    const cachedSeam = __totalCacheForTests("peek");
    expect(cachedSeam.misses).toBe(1);

    // Append a fresh id to the NEWEST (included) segment: its (size,
    // mtimeMs) changes → the per-file digest changes → the entry must not
    // serve even though `now` sits identically. (An append to an EXCLUDED
    // segment freshens its mtime past the window cut, which by AC2's own
    // fallback widens the read to the full list instead of consulting the
    // cache — a different, also-correct path.)
    const appendedId = fixtureId("appended-under-validity");
    fs.appendFileSync(
      path.join(partition, "current.jsonl"),
      line({
        id: appendedId,
        key: "/p/appended-validity",
        timestamp: new Date(base + 1000).toISOString(),
      }),
      "utf-8",
    );

    const second = await queryMemoriesWithTotal(db, [partition], filters);
    const seam = __totalCacheForTests("peek");
    expect(seam.misses).toBe(2);
    expect(second.total).toBe(first.total + 1);
    expect(second.memories.some((m) => m.id === appendedId)).toBe(true);

    const files = collectJsonlFiles([partition]);
    const fused = await queryMemoriesWithTotalFused(db, files, filters);
    expect(JSON.stringify(second.memories)).toBe(JSON.stringify(fused.memories));
    expect(second.total).toBe(fused.total);
  });
});
