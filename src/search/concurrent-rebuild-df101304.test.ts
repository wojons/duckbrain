/**
 * DF-1013-04 Regression Tests: concurrent sidecar rebuild corruption.
 *
 * Live-prod evidence (2026-10-13): 11 stdio MCP daemons + the HTTP daemon
 * all rebuild the SAME `.search/` sidecars concurrently (boot warm-up). The
 * old `rebuildNamespaceIndex` did `rm -rf dir → write tmp → rename` with NO
 * cross-process coordination, so process A's finished DB was deleted by
 * process B's wipe: 53/813 sidecars came out EMPTY (no memories table) and
 * ~20 lost their fts_main_memories schema — every allNamespaces contains=
 * union then hard-failed 400.
 *
 * Fixes under test:
 *   AC1  cross-process single-flight: two CONCURRENT rebuild calls for the
 *        same namespace serialize on a `.search.rebuild.lock` file — the
 *        sidecar always ends up complete (memories table + FTS index).
 *   AC1b per-namespace IN-PROCESS single-flight: concurrent callers in ONE
 *        process share a single rebuild of that namespace (keyed by resolved
 *        namespace path), so they cannot interleave the wipe/build/rename
 *        either — and rebuilds of DIFFERENT namespaces still run concurrently,
 *        because the key is the namespace and not a global lock.
 *   AC2  one corrupt sidecar (empty DuckDB file, no `memories` table) in
 *        the namespaces dir does NOT abort the allNamespaces union — the
 *        union returns the healthy namespaces' hits and reports the corrupt
 *        one as a `namespaceErrors` facet.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import duckdb from "duckdb";
import {
  rebuildNamespaceIndex,
  indexDbPath,
  inFlightRebuildNamespaces,
  REBUILD_LOCK_NAME,
  SEARCH_INDEX_DIR,
} from "./index";
import { keywordSearch, keywordSearchAllNamespaces } from "./query";

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const NS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "df101304-ns-"));

function record(id: string, key: string, text: string, ts: string): string {
  return JSON.stringify({
    id,
    key,
    domain: "raw_note",
    timestamp: ts,
    author: "df101304@test.local",
    action: "add",
    embedding_text: text,
    attributes: {},
  });
}

function writeNamespace(
  name: string,
  rows: Array<{ id: string; key: string; text: string; ts: string }>,
): string {
  const nsPath = path.join(NS_ROOT, name);
  const partition = path.join(nsPath, "concept", "2026-10");
  fs.mkdirSync(partition, { recursive: true });
  fs.writeFileSync(
    path.join(partition, "current.jsonl"),
    rows.map((r) => record(r.id, r.key, r.text, r.ts)).join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(nsPath, "manifest.json"),
    JSON.stringify({
      partitions: ["concept/2026-10"],
      lastUpdated: new Date().toISOString(),
    }),
  );
  return nsPath;
}

/** Race a promise against a deadline so a HANG fails the test fast and by name. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)),
        ms,
      ),
    ),
  ]);
}

/** Open a sidecar DB and assert its shape (memories table + FTS schema). */
async function inspectSidecar(
  dbPath: string,
): Promise<{ memories: boolean; ftsSchema: boolean; rowCount: number }> {
  const db = new duckdb.Database(dbPath);
  const all = (sql: string): Promise<any[]> =>
    new Promise((resolve, reject) =>
      db.all(sql, (err: any, rows: any) =>
        err ? reject(err) : resolve(rows ?? []),
      ),
    );
  try {
    const tables = await all(
      "SELECT table_name, table_schema FROM information_schema.tables",
    );
    const memories = tables.some(
      (t: any) =>
        String(t.table_name).toLowerCase() === "memories" &&
        String(t.table_schema) === "main",
    );
    if (!memories) return { memories: false, ftsSchema: false, rowCount: 0 };
    const count = await all("SELECT COUNT(*) AS c FROM memories");
    const ftsSchema = tables.some(
      (t: any) => String(t.table_schema) === "fts_main_memories",
    );
    return {
      memories: true,
      ftsSchema,
      rowCount: Number(count[0]?.c ?? 0),
    };
  } finally {
    await new Promise<void>((resolve) => db.close(() => resolve()));
  }
}

let nsPath = "";

beforeEach(() => {
  nsPath = writeNamespace("concurrent-rebuild", [
    {
      id: "a1",
      key: "/df101304/alpha",
      text: "concurrent rebuild corruption probe",
      ts: "2026-10-01T00:00:00.000Z",
    },
    {
      id: "a2",
      key: "/df101304/beta",
      text: "second row for the union",
      ts: "2026-10-02T00:00:00.000Z",
    },
  ]);
});

afterEach(() => {
  try {
    fs.rmSync(nsPath, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
});

describe("DF-1013-04 AC1: concurrent same-namespace rebuilds never corrupt the sidecar", () => {
  it("two concurrent rebuildNamespaceIndex calls leave a complete sidecar", async () => {
    // Fire BOTH calls with no await between them — the exact race the
    // fleet hit at boot warm-up. Under the old rm-then-build code this
    // intermittently wiped the winner's finished DB.
    const [metaA, metaB] = await Promise.all([
      rebuildNamespaceIndex(nsPath),
      rebuildNamespaceIndex(nsPath),
    ]);
    expect(metaA.rowCount).toBe(2);
    expect(metaB.rowCount).toBe(2);

    const shape = await inspectSidecar(indexDbPath(nsPath));
    expect(shape.memories).toBe(true);
    expect(shape.ftsSchema).toBe(true);
    expect(shape.rowCount).toBe(2);

    // The lock is released after the rebuild.
    expect(fs.existsSync(path.join(nsPath, REBUILD_LOCK_NAME))).toBe(false);
  }, 60_000);

  it("N=5 concurrent rebuilds all report full rowCount and one complete sidecar", async () => {
    const metas = await Promise.all(
      Array.from({ length: 5 }, () => rebuildNamespaceIndex(nsPath)),
    );
    for (const meta of metas) expect(meta.rowCount).toBe(2);
    const shape = await inspectSidecar(indexDbPath(nsPath));
    expect(shape.memories).toBe(true);
    expect(shape.ftsSchema).toBe(true);
    expect(shape.rowCount).toBe(2);
  }, 90_000);

  it("a foreign live-pid lock does not get stolen — the caller waits and reuses the result", async () => {
    // Simulate another process mid-rebuild: a lock file with a LIVE pid
    // (this process) — the stale reaper must NOT steal it.
    fs.mkdirSync(path.join(nsPath, SEARCH_INDEX_DIR), { recursive: true });
    fs.writeFileSync(
      path.join(nsPath, REBUILD_LOCK_NAME),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      "utf8",
    );
    // Drop nothing else: the caller below must WAIT on this foreign lock,
    // and a timer releases it while it polls — mirroring the other process
    // finishing its build.
    const release = setTimeout(() => {
      try {
        fs.rmSync(path.join(nsPath, SEARCH_INDEX_DIR), {
          recursive: true,
          force: true,
        });
        fs.unlinkSync(path.join(nsPath, REBUILD_LOCK_NAME));
      } catch {
        // Best effort.
      }
    }, 200);

    try {
      const meta = await rebuildNamespaceIndex(nsPath);
      expect(meta.rowCount).toBe(2);
      const shape = await inspectSidecar(indexDbPath(nsPath));
      expect(shape.memories).toBe(true);
      expect(shape.ftsSchema).toBe(true);
    } finally {
      clearTimeout(release);
    }
  }, 60_000);
});

describe("DF-1013-04 AC1b: per-namespace in-process single-flight, never a global lock", () => {
  it("N concurrent callers for ONE namespace share one rebuild and one result", async () => {
    // Five calls with no `await` between them: each one registers while the
    // first is still in flight (registration in rebuildNamespaceIndex is
    // synchronous), and the registry is keyed by resolved namespace path — so
    // it must hold exactly ONE entry. Five entries would mean five concurrent
    // rebuilds of the same `.search/` directory, which is the corruption this
    // row is about.
    const pending = Array.from({ length: 5 }, () =>
      rebuildNamespaceIndex(nsPath),
    );
    expect(inFlightRebuildNamespaces()).toEqual([path.resolve(nsPath)]);

    const metas = await Promise.all(pending);
    // Identical objects: all five observed the SAME rebuild's stats, so the
    // sidecar was wiped/built/renamed once rather than five times.
    for (const meta of metas) expect(meta).toBe(metas[0]);
    expect(metas[0].rowCount).toBe(2);

    // The registry drains once the rebuild settles.
    expect(inFlightRebuildNamespaces()).toEqual([]);

    // And the shared sidecar is a real QUERYABLE index, not merely a shaped
    // DuckDB file: the FTS path finds the row by a body token ("corruption"
    // is not an FTS stopword, so the keyword leg actually runs).
    const hits = await keywordSearch(nsPath, "corruption", { limit: 10 });
    expect(hits.memories.map((m) => m.id)).toEqual(["a1"]);
  }, 60_000);

  it("rebuilds of DIFFERENT namespaces run concurrently — no global lock", async () => {
    const parallel = [
      writeNamespace("df101304-par-a", [
        {
          id: "pa1",
          key: "/df101304/par-a",
          text: "alpha namespace payload",
          ts: "2026-10-04T00:00:00.000Z",
        },
      ]),
      writeNamespace("df101304-par-b", [
        {
          id: "pb1",
          key: "/df101304/par-b",
          text: "bravo namespace payload",
          ts: "2026-10-05T00:00:00.000Z",
        },
      ]),
      writeNamespace("df101304-par-c", [
        {
          id: "pc1",
          key: "/df101304/par-c",
          text: "charlie namespace payload",
          ts: "2026-10-06T00:00:00.000Z",
        },
      ]),
    ];
    try {
      const pending = parallel.map((ns) => rebuildNamespaceIndex(ns));
      // Three namespaces in flight at once. A global mutex (or one shared
      // chain) would show exactly ONE entry here.
      expect(inFlightRebuildNamespaces().sort()).toEqual(
        parallel.map((ns) => path.resolve(ns)).sort(),
      );

      const metas = await Promise.all(pending);
      expect(metas.map((m) => m.rowCount)).toEqual([1, 1, 1]);

      // Each namespace owns its own COMPLETE sidecar — no cross-namespace
      // clobbering (separate `.search/` dirs, and not one shared build).
      for (const ns of parallel) {
        const shape = await inspectSidecar(indexDbPath(ns));
        expect(shape.memories).toBe(true);
        expect(shape.ftsSchema).toBe(true);
        expect(shape.rowCount).toBe(1);
      }
    } finally {
      for (const ns of parallel) {
        try {
          fs.rmSync(ns, { recursive: true, force: true });
        } catch {
          // Best effort.
        }
      }
    }
  }, 90_000);

  it("a missing namespace fails loudly instead of spinning in the lock wait loop", async () => {
    // Regression found while adding the in-process layer — and a regression
    // against the pre-DF-1013-04 code, which threw ENOENT from
    // ensureSearchGitignored. The cross-process wait loop polls `for (;;)`
    // while the lock file is ABSENT, which is exactly the state a failed
    // lock-file create leaves behind, so a rebuild for a directory that does
    // not exist never settled. The bounded race keeps the RED failure fast and
    // names the timeout instead of eating the file timeout.
    const ghost = path.join(NS_ROOT, "df101304-missing");
    fs.rmSync(ghost, { recursive: true, force: true });
    await expect(
      withTimeout(
        rebuildNamespaceIndex(ghost),
        5_000,
        "rebuild for a missing namespace",
      ),
    ).rejects.toThrow(/namespace directory not found/);
  }, 30_000);
});

describe("DF-1013-04 AC2: one corrupt sidecar does not abort the allNamespaces union", () => {
  let corruptNs = "";
  let healthyNs = "";

  beforeEach(() => {
    healthyNs = writeNamespace("df101304-healthy", [
      {
        id: "h1",
        key: "/healthy/hit",
        text: "union survives corrupt sidecar",
        ts: "2026-10-03T00:00:00.000Z",
      },
    ]);
    corruptNs = path.join(NS_ROOT, "df101304-corrupt");
    fs.mkdirSync(path.join(corruptNs, SEARCH_INDEX_DIR), { recursive: true });
    // The observed corruption: an EMPTY DuckDB file — no memories table at
    // all (meta.json even claimed rowCount>0 in prod).
    fs.writeFileSync(indexDbPath(corruptNs), "", "utf8");
    fs.writeFileSync(
      path.join(corruptNs, "manifest.json"),
      JSON.stringify({ partitions: [], lastUpdated: new Date().toISOString() }),
    );
  });

  afterEach(() => {
    for (const p of [healthyNs, corruptNs]) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    }
  });

  it("the union returns healthy-namespace hits and reports the corrupt namespace as a facet", async () => {
    // Pre-build the healthy namespace's sidecar.
    await rebuildNamespaceIndex(healthyNs);

    const result = await keywordSearchAllNamespaces(NS_ROOT, "corrupt sidecar");
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.memories.length).toBeGreaterThanOrEqual(1);
    expect(
      result.memories.some((m) => m.namespace === "df101304-healthy"),
    ).toBe(true);
    expect(result.namespaceErrors).toBeDefined();
    const corrupt = result.namespaceErrors!.find(
      (e) => e.namespace === "df101304-corrupt",
    );
    expect(corrupt).toBeDefined();
    // The empty DB file fails its DuckDB open (node-duckdb reports the open
    // failure as a Connection Error on the first query) — either way it is
    // a real error message on the corrupt namespace's facet, and the union
    // itself returned results.
    expect(corrupt!.error.length).toBeGreaterThan(0);
  }, 60_000);

  it("an all-corrupt fleet still returns a shaped (empty) union, never a throw", async () => {
    // NOTE: "anything" is in FTS_STOPWORDS, so a stopword-only query never
    // touches ANY sidecar (no candidate pass runs) — use a non-stopword
    // token to actually exercise the corrupt DuckDB files.
    const result = await keywordSearchAllNamespaces(NS_ROOT, "zznonword");
    expect(result.memories).toEqual([]);
    expect(result.total).toBe(0);
    // The corrupt namespace is reported as an error facet, not lost.
    expect(
      result.namespaceErrors?.some((e) => e.namespace === "df101304-corrupt"),
    ).toBe(true);
  }, 60_000);

  it("a sidecar whose DuckDB file is valid but LACKS the memories table also degrades to a facet", async () => {
    // The second observed corruption shape: a valid DuckDB file with no
    // `memories` table (the fts schema lost). A real DB open succeeds and
    // the missing table surfaces as a Catalog Error at query time.
    const noTableNs = path.join(NS_ROOT, "df101304-notable");
    fs.mkdirSync(path.join(noTableNs, SEARCH_INDEX_DIR), { recursive: true });
    fs.writeFileSync(
      path.join(noTableNs, "manifest.json"),
      JSON.stringify({ partitions: [], lastUpdated: new Date().toISOString() }),
    );
    const db = new duckdb.Database(indexDbPath(noTableNs));
    await new Promise<void>((res) => db.close(() => res()));

    try {
      // "zznonword" is not in FTS_STOPWORDS, so the FTS pass actually runs
      // against the table-less sidecar and surfaces the Catalog Error.
      const result = await keywordSearchAllNamespaces(NS_ROOT, "zznonword");
      expect(
        result.namespaceErrors?.some((e) => e.namespace === "df101304-notable"),
      ).toBe(true);
      const facet = result.namespaceErrors!.find(
        (e) => e.namespace === "df101304-notable",
      )!;
      expect(facet.error.toLowerCase()).toContain("memories");
    } finally {
      try {
        fs.rmSync(noTableNs, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    }
  }, 60_000);
});
