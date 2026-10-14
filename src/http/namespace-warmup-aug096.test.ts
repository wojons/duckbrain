/**
 * AUG-096: per-namespace warm-up at HTTP daemon startup.
 *
 * Attempt 1 covered the three connection-leg behaviors:
 *   1. warm-up creates singleton connections for every enumerated namespace
 *      WITHOUT any HTTP request (and pays the first JSONL scan when the
 *      manifest lists data);
 *   2. a namespace that fails to warm neither throws nor blocks the others
 *      (skipped + evicted, reported on the result and in the log line);
 *   3. DUCKBRAIN_WARM_NAMESPACES=0 disables the whole pass.
 *
 * Rework (attempt 2) adds:
 *   4. warmNamespace() also warms the SEARCH leg (the SAME ensureFreshIndex
 *      the scoped ?q= path calls) + the EmbeddingCache directory;
 *   5. enumeration is MANIFEST namespaces (listNamespaces) with census
 *      fallback; concurrency-capped worker pool; budget + per-namespace
 *      timeout knobs.
 *
 * Enumeration-contract note (rework): the attempt-1 tests asserted census
 * enumeration (every on-disk directory). The rework's judge finding (b)
 * supersedes that with manifest enumeration — the mechanics assertions
 * below are unchanged, only the enumeration source they read moved from
 * censusOnDiskNamespaces to listNamespaces.
 *
 * The scoped-?q= acceptance is proven END TO END (judge finding (c)): after
 * warmNamespace() on a real namespace with a real stale sidecar, the first
 * GET /api/memories?namespace=X&q=... runs against an already-fresh index —
 * asserted via the exported autoBuildCount() seam (ensureFreshIndex counted
 * NO ADDITIONAL read-path rebuild), meta.json indexedAt unchanged, the
 * fts.duckdb mtime unchanged, and no rows.tmp.jsonl staging artifact.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import http, { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import path from "path";

const mocks = vi.hoisted(() => ({
  /** When set, replaces queryMemories for ALL calls in this file's registry. */
  queryMemoriesOverride:
    undefined as
    | ((
        db: unknown,
        partitionPaths: string[],
        filters: unknown,
      ) => Promise<unknown>)
    | undefined,
  /** The REAL queryMemories, captured by the factory below (a dynamic
   *  import() of the mocked path would return the mock and recurse). */
  actualQueryMemories:
    undefined as
      | ((db: any, partitionPaths: string[], filters: any) => unknown)
      | undefined,
}));

vi.mock("../duckdb/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../duckdb/queries")>();
  mocks.actualQueryMemories = actual.queryMemories;
  return {
    ...actual,
    queryMemories: (db: any, partitionPaths: string[], filters: any) =>
      mocks.queryMemoriesOverride
        ? mocks.queryMemoriesOverride(db, partitionPaths, filters)
        : actual.queryMemories(db, partitionPaths, filters),
  };
});

import {
  isNamespaceWarmupEnabled,
  startNamespaceWarmup,
  warmNamespace,
  warmManifestNamespaces,
  logNamespaceWarmup,
  WARM_BUDGET_ENV,
  WARM_PER_NAMESPACE_TIMEOUT_ENV,
  WARM_CONCURRENCY_ENV,
  DEFAULT_WARM_BUDGET_MS,
} from "./namespace-warmup";
import {
  getConnectionAge,
  getConnectionCount,
  closeAllConnections,
} from "../duckdb/connection";
import { censusOnDiskNamespaces } from "../namespaces/census";
import { resolveNamespacesPath } from "../config/index";
import {
  autoBuildCount,
  rebuildNamespaceIndex,
  listNamespaces,
} from "../search/index";
import { EMBEDDING_CACHE_DIR } from "../embedding/cache";
import { createHttpServer } from "../cli/http";

/** One valid storage row (the all-VARCHAR READ_JSON_COLUMNS shape). */
function memoryRow(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "904b1426-0431-45d7-8d47-687aebf0b9d5",
    key: "/project/warmup/test",
    domain: "config",
    timestamp: "2026-10-13T12:00:00.000Z",
    author: "totalwindupflightsystems@gmail.com",
    action: "add",
    embedding_text: "warm-up fixture row",
    attributes: { source_type: "fixture" },
    ...overrides,
  });
}

/** Create a namespace with one data-bearing partition + manifest, like the writer does. */
function createDataNamespace(name: string): string {
  const nsRoot = resolveNamespacesPath();
  const nsPath = path.join(nsRoot, name);
  const partition = path.join(nsPath, "config", "2026-10");
  fs.mkdirSync(partition, { recursive: true });
  fs.writeFileSync(path.join(partition, "0001.jsonl"), memoryRow() + "\n");
  fs.writeFileSync(
    path.join(nsPath, "manifest.json"),
    JSON.stringify(
      { partitions: ["config/2026-10/"], lastUpdated: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  );
  return nsPath;
}

/** Create an EMPTY namespace (directory only — a census row, NOT a manifest namespace). */
function createEmptyNamespace(name: string): string {
  const nsPath = path.join(resolveNamespacesPath(), name);
  fs.mkdirSync(nsPath, { recursive: true });
  return nsPath;
}

/**
 * Data namespace for the scoped-?q= e2e: TWO memories with distinct
 * searchable tokens, so the GET asserts real recall, not just a 200.
 */
function createSearchableNamespace(name: string): string {
  const nsPath = createDataNamespace(name);
  const jsonl = path.join(nsPath, "config", "2026-10", "0001.jsonl");
  fs.writeFileSync(
    jsonl,
    [
      memoryRow({
        id: "11111111-1111-4111-8111-111111111111",
        key: "/aug096/gravitron",
        embedding_text: "the gravitron flux capacitor needs calibration",
      }),
      memoryRow({
        id: "22222222-2222-4222-8222-222222222222",
        key: "/aug096/unrelated",
        embedding_text: "entirely different topic about garden hoses",
      }),
    ].join("\n"),
  );
  return nsPath;
}

/**
 * Age the namespace STALE the way production was found (judge finding (a)):
 * build a real sidecar, then backdate its meta indexedAt so
 * indexFreshness() reports "stale" (source mtime > indexedAt) and the next
 * ensureFreshIndex — warm-up's or a request's — must rebuild.
 */
function buildThenStaleIndex(nsPath: string): void {
  const metaPath = path.join(nsPath, ".search", "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta.indexedAt = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(metaPath, JSON.stringify(meta));
}

/** Read meta.json indexedAt (null when absent). */
function indexedAtOf(nsPath: string): string | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(nsPath, ".search", "meta.json"), "utf8"),
    ).indexedAt;
  } catch {
    return null;
  }
}

function sidecarHasTmpStaging(nsPath: string): boolean {
  const dir = path.join(nsPath, ".search");
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((f) => f.includes("tmp"));
}

function dbMtimeMs(nsPath: string): number | null {
  try {
    return fs.statSync(path.join(nsPath, ".search", "fts.duckdb")).mtimeMs;
  } catch {
    return null;
  }
}

/** Minimal JSON GET against an already-bound port (mirrors retr002 helper). */
function httpGet(
  port: number,
  p: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method: "GET",
        headers: { Host: "localhost" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("AUG-096 namespace warm-up", () => {
  beforeEach(() => {
    delete process.env.DUCKBRAIN_WARM_NAMESPACES;
    delete process.env[WARM_BUDGET_ENV];
    delete process.env[WARM_PER_NAMESPACE_TIMEOUT_ENV];
    delete process.env[WARM_CONCURRENCY_ENV];
    mocks.queryMemoriesOverride = undefined;
  });

  afterEach(async () => {
    delete process.env.DUCKBRAIN_WARM_NAMESPACES;
    delete process.env[WARM_BUDGET_ENV];
    delete process.env[WARM_PER_NAMESPACE_TIMEOUT_ENV];
    delete process.env[WARM_CONCURRENCY_ENV];
    mocks.queryMemoriesOverride = undefined;
    vi.restoreAllMocks();
    await closeAllConnections();
  });

  it("warms every manifest namespace without any HTTP request (connection + first scan)", async () => {
    const dataNs = createDataNamespace("waraug-data");
    const emptyNs = createEmptyNamespace("waraug-empty");
    // Drop any pre-existing connection for these names (shared per-worker cache).
    await closeAllConnections();

    const results = await startNamespaceWarmup();

    // The manifest namespaces we created are represented and warmed. The
    // bare directory (no manifest.json) is NOT enumerated (rework: manifest
    // enumeration is primary).
    const byName = new Map(results.map((r) => [r.namespace, r]));
    expect(byName.get("waraug-data")?.warmed).toBe(true);
    expect(byName.has("waraug-empty")).toBe(false);
    // The data namespace paid the real first scan (JSONL existed).
    expect(byName.get("waraug-data")?.scanned).toBe(true);

    // EVERY namespace the manifest enumeration lists right now holds a
    // singleton connection — i.e. getSingletonConnection was hit per
    // namespace with zero requests.
    const expected = listNamespaces(resolveNamespacesPath());
    expect(expected.length).toBeGreaterThan(0);
    expect(getConnectionCount()).toBe(expected.length);
    for (const name of expected) {
      expect(getConnectionAge(path.join(resolveNamespacesPath(), name))).not.toBeNull();
    }

    // Timings are real numbers on every row.
    for (const r of results) {
      expect(typeof r.warmMs).toBe("number");
      expect(r.warmMs).toBeGreaterThanOrEqual(0);
    }
    expect(dataNs).toBeTruthy();
    expect(emptyNs).toBeTruthy();
  });

  it("warmNamespace on a data namespace actually scans rows (limit-1 page over real JSONL)", async () => {
    const nsPath = createDataNamespace("waraug-scan");
    const result = await warmNamespace(nsPath);
    expect(result.warmed).toBe(true);
    expect(result.scanned).toBe(true);
    expect(result.error).toBeUndefined();
    expect(getConnectionAge(nsPath)).not.toBeNull();
  });

  it("a failing namespace does not throw and other namespaces still warm (failed one evicted)", async () => {
    const brokenPath = createDataNamespace("waraug-broken");
    const healthyPath = createDataNamespace("waraug-healthy");
    await closeAllConnections();

    mocks.queryMemoriesOverride = (db, partitionPaths) =>
      String(partitionPaths?.[0]).includes("waraug-broken")
        ? Promise.reject(new Error("boom: forced warm-up failure"))
        : // Call the REAL queryMemories captured by the factory — a dynamic
          // import() of the mocked module id would resolve to the mock and
          // recurse into this very override forever (measured: 2GB heap OOM
          // in the vitest fork).
          Promise.resolve(
            mocks.actualQueryMemories!(
              db,
              partitionPaths,
              { limit: 1 } as never,
            ),
          );

    const consoleErrors: string[] = [];
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        consoleErrors.push(args.map(String).join(" "));
      });

    // Must resolve — never reject — despite the forced failure.
    const results = await startNamespaceWarmup();

    const byName = new Map(results.map((r) => [r.namespace, r]));
    expect(byName.get("waraug-broken")?.warmed).toBe(false);
    expect(byName.get("waraug-broken")?.error).toContain("boom");
    expect(byName.get("waraug-healthy")?.warmed).toBe(true);
    expect(byName.get("waraug-healthy")?.scanned).toBe(true);

    // The failed namespace's half-open connection was evicted so the first
    // REAL request starts clean; the healthy one is warm.
    expect(getConnectionAge(brokenPath)).toBeNull();
    expect(getConnectionAge(healthyPath)).not.toBeNull();

    // Failure surfaced as a warning line, summary still emitted.
    expect(
      consoleErrors.some((line) => line.includes("waraug-broken") && line.includes("skipped")),
    ).toBe(true);
    expect(errSpy.mock.calls.some((args) => String(args[0]).includes("Namespace warm-up"))).toBe(
      true,
    );
  });

  it("DUCKBRAIN_WARM_NAMESPACES=0 disables the warm-up (no connections created)", async () => {
    createDataNamespace("waraug-guarded");
    await closeAllConnections();

    process.env.DUCKBRAIN_WARM_NAMESPACES = "0";
    expect(isNamespaceWarmupEnabled()).toBe(false);

    const results = await startNamespaceWarmup();
    expect(results).toEqual([]);
    expect(getConnectionCount()).toBe(0);
  });

  it("env guard parsing: 'false'/'FALSE' disable, unset/''/'1' enable", () => {
    delete process.env.DUCKBRAIN_WARM_NAMESPACES;
    expect(isNamespaceWarmupEnabled()).toBe(true);
    for (const enabled of ["", "1", "true", "yes"]) {
      process.env.DUCKBRAIN_WARM_NAMESPACES = enabled;
      expect(isNamespaceWarmupEnabled()).toBe(true);
    }
    for (const disabled of ["0", "false", "FALSE", "False"]) {
      process.env.DUCKBRAIN_WARM_NAMESPACES = disabled;
      expect(isNamespaceWarmupEnabled()).toBe(false);
    }
    delete process.env.DUCKBRAIN_WARM_NAMESPACES;
  });

  it("DF-1013-02: an unparseable manifest is a warm-up FAILURE (warmed:false, error, evicted)", async () => {
    const nsPath = createEmptyNamespace("waraug-corrupt");
    fs.writeFileSync(path.join(nsPath, "manifest.json"), "not json {{");
    const result = await warmNamespace(nsPath);
    expect(result.warmed).toBe(false);
    expect(result.scanned).toBe(false);
    expect(result.error).toContain("manifest.json is corrupt");
    // The half-open connection was evicted so the first REAL request
    // starts clean (same contract as any other warm-up failure).
    expect(getConnectionAge(nsPath)).toBeNull();
  });

  it("DF-1013-02: a corrupt-manifest namespace logs one skipped line and counts in the skipped total", async () => {
    createDataNamespace("waraug-fine");
    createEmptyNamespace("broken-ns");
    fs.writeFileSync(
      path.join(resolveNamespacesPath(), "broken-ns", "manifest.json"),
      "not json {{",
    );
    await closeAllConnections();

    const consoleErrors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    });

    const results = await startNamespaceWarmup();
    const byName = new Map(results.map((r) => [r.namespace, r]));
    expect(byName.get("broken-ns")?.warmed).toBe(false);
    expect(byName.get("waraug-fine")?.warmed).toBe(true);

    // Exactly ONE individual failure-warning line, in the documented
    // 'failed in Nms and was skipped' format, naming the namespace.
    const failureLines = consoleErrors.filter(
      (line) =>
        line.includes("'broken-ns'") &&
        line.includes("failed in") &&
        line.includes("skipped"),
    );
    expect(failureLines).toHaveLength(1);

    // The summary line counts it in the skipped total (count derived from
    // results — the shared root may hold other failing namespaces).
    const failureCount = results.filter((r) => !r.warmed).length;
    const summary = consoleErrors.find(
      (line) =>
        line.includes(`${failureCount} skipped`) &&
        /broken-ns=\d+ms SKIPPED/.test(line),
    );
    expect(summary).toBeTruthy();
  });

  it("warmManifestNamespaces tolerates enumeration failure (returns [] — never throws)", async () => {
    // Point the census at an unreadable/nonexistent root via the documented
    // runtime-only override; resolveNamespacesPath honors it (BUG-037 knob).
    const prev = process.env.DUCKBRAIN_NAMESPACES_PATH;
    process.env.DUCKBRAIN_NAMESPACES_PATH = path.join(
      os.tmpdir(),
      `waraug-missing-root-${process.pid}-${Date.now()}`,
    );
    try {
      const results = await warmManifestNamespaces();
      expect(results).toEqual([]);
    } finally {
      if (prev === undefined) {
        delete process.env.DUCKBRAIN_NAMESPACES_PATH;
      } else {
        process.env.DUCKBRAIN_NAMESPACES_PATH = prev;
      }
    }
  });

  it("logNamespaceWarmup emits one summary line with per-ns timings", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    logNamespaceWarmup([
      { namespace: "a", namespacePath: "/x/a", warmed: true, warmMs: 12, scanned: true },
      { namespace: "b", namespacePath: "/x/b", warmed: true, warmMs: 3, scanned: false },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2 namespace(s) warmed");
    expect(lines[0]).toContain("a=12ms scanned");
    expect(lines[0]).toContain("b=3ms connection-only");
    expect(lines[0]).toContain("15ms total");
    expect(spy).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // AUG-096 rework (attempt 2): the search leg
  // -------------------------------------------------------------------------

  it("warmNamespace builds a missing sidecar and opens the embedding cache", async () => {
    const nsPath = createSearchableNamespace("waraug-search-build");
    await closeAllConnections();

    expect(fs.existsSync(path.join(nsPath, ".search", "fts.duckdb"))).toBe(false);

    const result = await warmNamespace(nsPath);

    expect(result.warmed).toBe(true);
    expect(result.scanned).toBe(true);
    expect(result.searchFreshness).toBe("missing");
    expect(result.searchRebuilt).toBe(true);
    expect(result.searchSkipReason).toBeUndefined();
    expect(fs.existsSync(path.join(nsPath, ".search", "fts.duckdb"))).toBe(true);
    expect(result.embeddingCacheReady).toBe(true);
    expect(fs.existsSync(path.join(nsPath, EMBEDDING_CACHE_DIR))).toBe(true);
    // The sidecar is fresh as of NOW: warm-up, not a later request, built it.
    const at = Date.parse(indexedAtOf(nsPath)!);
    expect(Number.isFinite(at)).toBe(true);
    expect(Math.abs(Date.now() - at)).toBeLessThan(60_000);
  });

  it("SCOPED ?q= E2E: after warm-up the first request hits an already-fresh index (no read-path rebuild)", async () => {
    const nsName = "waraug-e2e";
    const nsPath = createSearchableNamespace(nsName);
    await closeAllConnections();

    // Make the sidecar STALE the way production was found: index exists but
    // predates the newest source write (judge finding (a): jsonl mtime >
    // indexedAt on the live default namespace).
    await rebuildNamespaceIndex(nsPath);
    buildThenStaleIndex(nsPath);
    expect(indexedAtOf(nsPath)).not.toBeNull();
    expect(autoBuildCount(nsPath)).toBe(0);

    // No embedding provider is guaranteed in this test process — the
    // semantic leg degrades (or uses a local provider); the KEYWORD leg and
    // its ensureFreshIndex call are the surface under test and run for real.
    const warm = await warmNamespace(nsPath);
    expect(warm.warmed).toBe(true);
    expect(warm.searchRebuilt).toBe(true);
    const metaAfterWarm = indexedAtOf(nsPath)!;
    const dbAfterWarm = dbMtimeMs(nsPath)!;
    expect(dbAfterWarm).not.toBeNull();
    expect(sidecarHasTmpStaging(nsPath)).toBe(false); // staging cleaned up
    // Warm-up's ensureFreshIndex counted exactly ONE read-path rebuild.
    const rebuildsAfterWarm = autoBuildCount(nsPath);
    expect(rebuildsAfterWarm).toBe(1);

    const app = createHttpServer({ authType: "none" });
    const server: Server = createServer(app);
    let port = 0;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
    try {
      const res = await httpGet(
        port,
        `/api/memories?namespace=${nsName}&q=${encodeURIComponent("gravitron calibration")}&limit=10`,
      );
      expect(res.status).toBe(200);
      expect(res.body?.total).toBeGreaterThanOrEqual(1);
      // Real recall: the gravitron memory came back through the (warm,
      // already-fresh) keyword leg.
      const texts = (res.body?.memories ?? []).map(
        (m: any) => `${m.key ?? ""} ${m.content ?? ""}`,
      );
      expect(texts.join(" ")).toContain("gravitron");

      // THE acceptance: the ?q= path's ensureFreshIndex found the sidecar
      // FRESH — no additional read-path rebuild counted for this namespace,
      // the meta indexedAt warm-up wrote is untouched, fts.duckdb was not
      // rewritten, and no rows.tmp.jsonl staging was created by the request.
      expect(autoBuildCount(nsPath)).toBe(rebuildsAfterWarm);
      expect(indexedAtOf(nsPath)).toBe(metaAfterWarm);
      expect(dbMtimeMs(nsPath)).toBe(dbAfterWarm);
      expect(sidecarHasTmpStaging(nsPath)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("warm-up enumerates MANIFEST namespaces and skips dirs without manifest.json", async () => {
    createDataNamespace("waraug-manifested");
    createEmptyNamespace("waraug-bare");
    await closeAllConnections();

    const results = await startNamespaceWarmup();
    const byName = new Map(results.map((r) => [r.namespace, r]));

    // Manifest namespace: present and warmed.
    expect(byName.get("waraug-manifested")?.warmed).toBe(true);
    // Bare directory (no manifest.json): NOT enumerated by the primary
    // source — even though censusOnDiskNamespaces lists it.
    expect(byName.has("waraug-bare")).toBe(false);
    expect(censusOnDiskNamespaces(resolveNamespacesPath()).has("waraug-bare")).toBe(true);
    // Every enumerated row resolves to a directory that really carries a
    // manifest, and the enumeration equals listNamespaces (sorted).
    for (const r of results) {
      expect(fs.existsSync(path.join(r.namespacePath, "manifest.json"))).toBe(true);
    }
    const expected = listNamespaces(resolveNamespacesPath());
    expect(expected.length).toBeGreaterThan(0);
    expect(results.map((r) => r.namespace)).toEqual(expected);
  });

  it("census fallback: manifest-empty root still warms every on-disk dir", async () => {
    // Bare dir with data but NO manifest (the fallback's target shape):
    // warm-up must still connect+scan it when the manifest enumeration
    // comes up empty.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "waraug-fallback-"));
    const nsPath = path.join(root, "bare");
    fs.mkdirSync(nsPath, { recursive: true });
    fs.writeFileSync(
      path.join(nsPath, "0001.jsonl"),
      memoryRow({ key: "/bare/row" }) + "\n",
    );

    const prev = process.env.DUCKBRAIN_NAMESPACES_PATH;
    process.env.DUCKBRAIN_NAMESPACES_PATH = root;
    try {
      const results = await warmManifestNamespaces();
      expect(results.map((r) => r.namespace)).toEqual(["bare"]);
      expect(results[0].warmed).toBe(true);
      // No manifest → no partitionPaths → the connection leg cannot scan
      // (attempt-1 semantics preserved). The SEARCH leg still warms from
      // the on-disk sources: ensureFreshIndex sees real *.jsonl files and
      // builds the sidecar.
      expect(results[0].scanned).toBe(false);
      expect(results[0].searchRebuilt).toBe(true);
      expect(fs.existsSync(path.join(nsPath, ".search", "fts.duckdb"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
      else process.env.DUCKBRAIN_NAMESPACES_PATH = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("budget knob: DUCKBRAIN_WARM_BUDGET_MS=1 leaves later namespaces unstarted (reported, not silently dropped)", async () => {
    const first = createDataNamespace("waraug-budget-a");
    const second = createDataNamespace("waraug-budget-b");
    await closeAllConnections();
    process.env[WARM_BUDGET_ENV] = "1";

    vi.spyOn(console, "error").mockImplementation(() => {});

    const results = await startNamespaceWarmup();

    // With a 1ms budget the pool cannot start everything: namespaces
    // dequeued after the deadline are reported as budget-exhausted — never
    // silently dropped. (Each real warm takes >> 1ms, so at most the first
    // dequeued namespaces start.)
    const exhausted = results.filter((r) =>
      String(r.error).includes("budget exhausted"),
    );
    expect(exhausted.length).toBeGreaterThanOrEqual(1);
    for (const r of exhausted) {
      expect(r.warmed).toBe(false);
    }
    // Budget knob documented default is 300s.
    expect(DEFAULT_WARM_BUDGET_MS).toBe(300_000);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
  });

  it("per-namespace timeout knob: a hung warm is reported after the bound without failing the pass", async () => {
    const slow = createDataNamespace("waraug-slow");
    const quick = createDataNamespace("waraug-quick");
    await closeAllConnections();
    // The bound must sit ABOVE a healthy warm (fts extension load +
    // DuckDB init can take a few hundred ms in a fresh worker) and BELOW
    // the never-settling promise the slow namespace hangs on.
    process.env[WARM_PER_NAMESPACE_TIMEOUT_ENV] = "1500";

    mocks.queryMemoriesOverride = (db, partitionPaths, filters) =>
      String(partitionPaths?.[0]).includes("waraug-slow")
        ? new Promise(() => {}) // never settles
        : Promise.resolve(
            mocks.actualQueryMemories!(db, partitionPaths, filters),
          );

    const results = await startNamespaceWarmup();
    const byName = new Map(results.map((r) => [r.namespace, r]));

    expect(byName.get("waraug-slow")?.warmed).toBe(false);
    expect(String(byName.get("waraug-slow")?.error)).toContain("timed out after 1500ms");
    expect(byName.get("waraug-quick")?.warmed).toBe(true);
    expect(byName.get("waraug-quick")?.scanned).toBe(true);
    expect(slow).toBeTruthy();
    expect(quick).toBeTruthy();
  }, 30_000);

  it("concurrency knob is honored (never more than DUCKBRAIN_WARM_CONCURRENCY in flight)", async () => {
    const names = [
      "waraug-conc-a",
      "waraug-conc-b",
      "waraug-conc-c",
      "waraug-conc-d",
      "waraug-conc-e",
      "waraug-conc-f",
    ];
    for (const n of names) createDataNamespace(n);
    await closeAllConnections();
    process.env[WARM_CONCURRENCY_ENV] = "2";

    let inFlight = 0;
    let peak = 0;
    mocks.queryMemoriesOverride = (db, partitionPaths, filters) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const done = mocks.actualQueryMemories!(db, partitionPaths, filters);
      return Promise.resolve(done).finally(() => {
        inFlight -= 1;
      });
    };

    const results = await startNamespaceWarmup();
    expect(
      results.filter((r) => r.namespace.startsWith("waraug-conc")).length,
    ).toBe(names.length);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThanOrEqual(1);
  });
});
