/**
 * AUG-096: per-namespace DuckDB connection warm-up at HTTP daemon startup.
 *
 * Covers the three contracted behaviors:
 *   1. warm-up creates singleton connections for every on-disk census
 *      namespace WITHOUT any HTTP request (and pays the first JSONL scan
 *      when the manifest lists data);
 *   2. a namespace that fails to warm neither throws nor blocks the others
 *      (skipped + evicted, reported on the result and in the log line);
 *   3. DUCKBRAIN_WARM_NAMESPACES=0 disables the whole pass.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
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
} from "./namespace-warmup";
import {
  getConnectionAge,
  getConnectionCount,
  closeAllConnections,
} from "../duckdb/connection";
import { censusOnDiskNamespaces } from "../namespaces/census";
import { resolveNamespacesPath } from "../config/index";

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

/** Create an EMPTY namespace (directory only — still a census row). */
function createEmptyNamespace(name: string): string {
  const nsPath = path.join(resolveNamespacesPath(), name);
  fs.mkdirSync(nsPath, { recursive: true });
  return nsPath;
}

describe("AUG-096 namespace warm-up", () => {
  beforeEach(() => {
    delete process.env.DUCKBRAIN_WARM_NAMESPACES;
    mocks.queryMemoriesOverride = undefined;
  });

  afterEach(async () => {
    delete process.env.DUCKBRAIN_WARM_NAMESPACES;
    mocks.queryMemoriesOverride = undefined;
    vi.restoreAllMocks();
    await closeAllConnections();
  });

  it("warms every census namespace without any HTTP request (connection + first scan)", async () => {
    const dataNs = createDataNamespace("waraug-data");
    const emptyNs = createEmptyNamespace("waraug-empty");
    // Drop any pre-existing connection for these names (shared per-worker cache).
    await closeAllConnections();

    const results = await startNamespaceWarmup();

    // The census namespaces we created are represented and warmed.
    const byName = new Map(results.map((r) => [r.namespace, r]));
    expect(byName.get("waraug-data")?.warmed).toBe(true);
    expect(byName.get("waraug-empty")?.warmed).toBe(true);
    // The data namespace paid the real first scan (JSONL existed); the empty
    // one stopped after the connection (nothing to scan).
    expect(byName.get("waraug-data")?.scanned).toBe(true);
    expect(byName.get("waraug-empty")?.scanned).toBe(false);

    // EVERY namespace the census enumerates right now holds a singleton
    // connection — i.e. getSingletonConnection was hit per namespace with
    // zero requests.
    const census = censusOnDiskNamespaces(resolveNamespacesPath());
    expect(census.size).toBeGreaterThan(0);
    expect(getConnectionCount()).toBe(census.size);
    for (const [, nsPath] of census) {
      expect(getConnectionAge(nsPath)).not.toBeNull();
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

  it("a corrupted manifest degrades to connection-only warm-up (no throw)", async () => {
    const nsPath = createEmptyNamespace("waraug-corrupt");
    fs.writeFileSync(path.join(nsPath, "manifest.json"), "{not json at all");
    const result = await warmNamespace(nsPath);
    expect(result.warmed).toBe(true);
    expect(result.scanned).toBe(false);
    expect(getConnectionAge(nsPath)).not.toBeNull();
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
});
