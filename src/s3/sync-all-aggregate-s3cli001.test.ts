/**
 * S3-CLI-001 — `sync all` must report an AGGREGATE and exit nonzero when any
 * namespace fails.
 *
 * Regression shape (measured): syncAllNamespaces caught every per-namespace
 * error with a single console.warn and returned only its successes, so
 * `duckbrain s3 sync all` printed "[S3] push complete: N namespaces …" and
 * exited 0 after a PARTIAL push/pull. Scripts and cron jobs treated that as a
 * clean backup.
 *
 * These tests drive the REAL sync engine (no ./sync mock) against an in-memory
 * S3 wire whose putObject never resolves for `hung*` namespaces — the same
 * epoll-hang shape as S3-GIT-007 — so a per-namespace failure is produced by
 * production code paths, not by a stubbed aggregate:
 *   1. all namespaces succeed   → attempted/succeeded/failed = N/N/0
 *   2. one namespace fails      → N/N-1/1 + the failure names namespace + error
 *   3. several namespaces fail  → every failure is listed, count is exact
 *   4. the CLI (`s3Sync all`)   → prints the aggregate summary, lists the
 *                                 failed namespace, exits 1
 *
 * Isolation: no network/AWS SDK (./client mocked), DUCKBRAIN_* env snapshotted
 * and restored, temp dirs only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { syncAllNamespacesResult } from "./sync";
import { s3Sync } from "./cli";
import { DEFAULT_S3_CONFIG, type S3Config } from "./config";

// In-memory wire. `putObject` never resolves for keys under a `hung*`
// namespace — syncNamespace's deadline turns that into the per-namespace
// failure the aggregate must carry.
vi.mock("./client", () => ({
  buildClient: () => ({}) as import("@aws-sdk/client-s3").S3Client,
  listRemoteObjects: async (_c: unknown, _b: string, prefix: string) =>
    new Map([[prefix + "stub.jsonl", { key: prefix + "stub.jsonl", size: 3 }]]),
  putObject: async (_c: unknown, _b: string, key: string): Promise<void> => {
    if (/\/hung[^/]*\//.test(key)) {
      await new Promise<void>(() => {}); // never resolves — the hang
    }
  },
  getObject: async () => Buffer.alloc(0),
  deleteObject: async () => {},
}));

const ENV_KEYS = [
  "DUCKBRAIN_CONFIG_PATH",
  "DUCKBRAIN_NAMESPACES_PATH",
  "S3_SYNC_NAMESPACE_DEADLINE_S",
] as const;

let tmp: string;
let nsRoot: string;
let envSnapshot: Record<string, string | undefined>;

function cfg(): S3Config {
  return { ...DEFAULT_S3_CONFIG, enabled: true, bucket: "duckbrain", prefix: "duckbrain" };
}

/** Create a namespace dir with one syncable file. */
function seedNamespace(ns: string): void {
  const dir = path.join(nsRoot, ns);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "rows.jsonl"), "{}\n", "utf-8");
}

/** Write an enabled-s3 config and point the CLI's resolvers at this test. */
function writeConfig(): void {
  const cfgFile = path.join(tmp, "duckbrain.config.json");
  fs.writeFileSync(
    cfgFile,
    JSON.stringify(
      {
        s3: {
          ...DEFAULT_S3_CONFIG,
          enabled: true,
          bucket: "duckbrain",
          prefix: "duckbrain",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  process.env.DUCKBRAIN_CONFIG_PATH = cfgFile;
  process.env.DUCKBRAIN_NAMESPACES_PATH = nsRoot;
}

function captureConsole(): { logs: string[]; errors: string[]; warnings: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map((x) => String(x)).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map((x) => String(x)).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    warnings.push(a.map((x) => String(x)).join(" "));
  });
  return { logs, errors, warnings };
}

beforeEach(() => {
  envSnapshot = Object.fromEntries(
    ENV_KEYS.map((k) => [k, process.env[k]]),
  ) as Record<string, string | undefined>;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s3cli001-"));
  nsRoot = path.join(tmp, "namespaces");
  fs.mkdirSync(nsRoot, { recursive: true });
  process.env.S3_SYNC_NAMESPACE_DEADLINE_S = "1";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = envSnapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("syncAllNamespacesResult — aggregate outcome (S3-CLI-001)", () => {
  it("all namespaces succeed: attempted = succeeded, failed = 0", async () => {
    seedNamespace("alpha");
    seedNamespace("beta");

    const result = await syncAllNamespacesResult(cfg(), nsRoot, "push");

    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.stats.map((s) => s.ns).sort()).toEqual(["alpha", "beta"]);
  }, 20000);

  it("one namespace fails: failure captures its namespace and error", async () => {
    seedNamespace("good");
    seedNamespace("hung");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await syncAllNamespacesResult(cfg(), nsRoot, "push");

    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].namespace).toBe("hung");
    expect(result.failures[0].error).toMatch(/sync deadline exceeded/);
    // The surviving namespace is still reported — one failure never aborts
    // the rest of the pass.
    expect(result.stats.map((s) => s.ns)).toEqual(["good"]);
    // The pre-existing loud warn stays.
    expect(
      warn.mock.calls.map((c) => String(c[0])).some((s) => /sync hung failed/.test(s)),
    ).toBe(true);
  }, 20000);

  it("several namespaces fail: every failure is listed and counted", async () => {
    seedNamespace("good");
    seedNamespace("hung1");
    seedNamespace("hung2");

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await syncAllNamespacesResult(cfg(), nsRoot, "push");

    expect(result.attempted).toBe(3);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.failures.map((f) => f.namespace).sort()).toEqual([
      "hung1",
      "hung2",
    ]);
    for (const failure of result.failures) {
      expect(failure.error).toMatch(/sync deadline exceeded/);
    }
    expect(result.attempted).toBe(result.succeeded + result.failed);
  }, 20000);
});

describe("s3Sync all — CLI reports the aggregate and exits nonzero (S3-CLI-001)", () => {
  it("prints attempted/succeeded/failed, lists the failure, exits 1", async () => {
    writeConfig();
    seedNamespace("good");
    seedNamespace("hung");
    const cap = captureConsole();
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => code as never) as never);

    await s3Sync(".", "all", "push");

    const stdout = cap.logs.join("\n");
    expect(stdout).toContain("Sync complete: 2 attempted, 1 succeeded, 1 failed");
    // The legacy per-pass line is preserved for existing consumers.
    expect(stdout).toContain("[S3] push complete: 1 namespaces");

    const stderr = cap.errors.join("\n");
    expect(stderr).toContain("Failed namespaces (1):");
    expect(stderr).toContain("hung: ");
    expect(stderr).toMatch(/hung: .*sync deadline exceeded/);

    expect(exitSpy).toHaveBeenCalledWith(1);
  }, 20000);

  it("all namespaces succeed: summary says 0 failed and the process does NOT exit", async () => {
    writeConfig();
    seedNamespace("alpha");
    seedNamespace("beta");
    const cap = captureConsole();
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => code as never) as never);

    await s3Sync(".", "all", "push");

    expect(cap.logs.join("\n")).toContain(
      "Sync complete: 2 attempted, 2 succeeded, 0 failed",
    );
    expect(cap.errors.join("\n")).not.toContain("Failed namespaces");
    expect(exitSpy).not.toHaveBeenCalled();
  }, 20000);
});
