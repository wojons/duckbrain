/**
 * S3-DEADLINE-001 — the per-namespace deadline must scale with the work.
 *
 * Measured against Hetzner hel1 (BACKUP-RESTORE-PROOF-001): 0.53 s/object
 * sequential. A fixed 300 s wall-clock cap therefore aborted every namespace
 * above ~560 objects (chat-archive died at 570 of 617), and six LIVE
 * namespaces sit far above that line — their nightly backup could never
 * complete under shipped defaults.
 *
 * These tests pin the two halves of the fix:
 *  - the total allowance is DERIVED from the object count (budget), and
 *  - the watchdog measures STALL (no object completed within the window),
 *    so an honest slow run finishes while a genuinely stuck transfer (the
 *    S3-GIT-007 epoll hang, a black-holed endpoint) still aborts, nonzero,
 *    naming the namespace.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

/** In-flight accounting for the mocked wire, reset per test. */
const wire = {
  inFlight: 0,
  maxInFlight: 0,
  delayMs: 0,
  putCalls: 0,
};

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return {
    ...actual,
    buildClient: () => ({}) as import("@aws-sdk/client-s3").S3Client,
    // Empty listing: every local file is a delta, so `total` == file count.
    listRemoteObjects: async () => new Map(),
    putObject: async (_c: unknown, _b: string, key: string): Promise<string> => {
      wire.putCalls++;
      wire.inFlight++;
      wire.maxInFlight = Math.max(wire.maxInFlight, wire.inFlight);
      try {
        if (key.includes("/stuck/")) {
          await new Promise<void>(() => {}); // never settles — the hang
        }
        if (wire.delayMs > 0) {
          await new Promise((r) => setTimeout(r, wire.delayMs));
        }
        return '"0".repeat(32)';
      } finally {
        wire.inFlight--;
      }
    },
    getObject: async () => Buffer.alloc(0),
  };
});

import {
  syncNamespace,
  syncDeadlineBudgetSeconds,
  syncConcurrency,
  MEASURED_SECONDS_PER_OBJECT,
} from "./sync";
import { DEFAULT_S3_CONFIG, type S3Config } from "./config";
import fs from "fs";
import os from "os";
import path from "path";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-s3deadline001-"));
  wire.inFlight = 0;
  wire.maxInFlight = 0;
  wire.delayMs = 0;
  wire.putCalls = 0;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.S3_SYNC_NAMESPACE_DEADLINE_S;
  delete process.env.S3_SYNC_CONCURRENCY;
});

function cfg(): S3Config {
  return { ...DEFAULT_S3_CONFIG, enabled: true };
}

function mkNamespace(ns: string, files: number): string {
  const root = path.join(tmp, "namespaces");
  const dir = path.join(root, ns);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < files; i++) {
    fs.writeFileSync(path.join(dir, `f${i}.jsonl`), `{"i":${i}}\n`);
  }
  return root;
}

describe("syncDeadlineBudgetSeconds (work-derived allowance)", () => {
  it("keeps the stall window as the floor for an empty or tiny namespace", () => {
    expect(syncDeadlineBudgetSeconds(0)).toBe(300);
    expect(syncDeadlineBudgetSeconds(1)).toBeGreaterThanOrEqual(300);
  });

  it("covers chat-archive (617 objects) at the measured per-object cost", () => {
    const budget = syncDeadlineBudgetSeconds(617);
    // The old fixed cap: 300s. The measured serial work alone is 617*0.53 = 327s.
    expect(budget).toBeGreaterThan(617 * MEASURED_SECONDS_PER_OBJECT);
    expect(budget).toBeGreaterThan(300);
    // ...and it scales, it is not a second constant.
    expect(syncDeadlineBudgetSeconds(258_672)).toBeGreaterThan(
      syncDeadlineBudgetSeconds(49_631),
    );
    expect(syncDeadlineBudgetSeconds(49_631)).toBeGreaterThan(budget);
  });

  it("honours an explicit stall window as the floor", () => {
    expect(syncDeadlineBudgetSeconds(10, 42)).toBeGreaterThanOrEqual(42);
  });
});

describe("syncConcurrency", () => {
  it("defaults to 8 and clamps overrides to 1..32", () => {
    expect(syncConcurrency()).toBe(8);
    process.env.S3_SYNC_CONCURRENCY = "3";
    expect(syncConcurrency()).toBe(3);
    process.env.S3_SYNC_CONCURRENCY = "0";
    expect(syncConcurrency()).toBe(8);
    process.env.S3_SYNC_CONCURRENCY = "999";
    expect(syncConcurrency()).toBe(32);
  });
});

describe("deadline behaviour (S3-GIT-007 protection, work-derived size)", () => {
  it("finishes a namespace whose TOTAL time exceeds the stall window while every object completes inside it", async () => {
    // FALSIFIER for the pre-fix engine: 40 objects x 60 ms serial = 2.4 s of
    // work against a 1 s deadline. The old wall-clock race aborted at 1 s
    // with "sync deadline exceeded after 1s"; the stall window only aborts
    // when NO object completes within it, so this run must succeed.
    process.env.S3_SYNC_NAMESPACE_DEADLINE_S = "1";
    process.env.S3_SYNC_CONCURRENCY = "1"; // serial: isolate the deadline rule from the pool
    wire.delayMs = 60;
    const nsPath = mkNamespace("slow", 40);

    const stats = await syncNamespace(cfg(), "slow", nsPath, "push");

    expect(stats?.uploaded).toBe(40);
    // 40 data objects + 1 checksum ledger object (S3-PULL-INTEGRITY-001: the
    // push publishes `.s3state/checksums.json`; it is metadata, so it does not
    // increment `uploaded`).
    expect(wire.putCalls).toBe(41);
    expect(stats?.durationMs).toBeGreaterThan(1000); // exceeded the old cap
  }, 20000);

  it("still aborts a genuinely stuck namespace, and names it", async () => {
    process.env.S3_SYNC_NAMESPACE_DEADLINE_S = "1";
    const nsPath = mkNamespace("stuck", 1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      syncNamespace(cfg(), "stuck", nsPath, "push"),
    ).rejects.toThrow(/sync deadline exceeded after 1s for namespace stuck/);

    const warnings = warn.mock.calls.map((c) => String(c[0]));
    expect(
      warnings.some((s) => /sync stuck timed out after 1s \(S3-GIT-007\)/.test(s)),
    ).toBe(true);
    warn.mockRestore();
  }, 20000);

  it("reports a black-holed transfer as a stall with the progress it reached", async () => {
    process.env.S3_SYNC_NAMESPACE_DEADLINE_S = "1";
    const nsPath = mkNamespace("stuck", 3);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const err = await syncNamespace(cfg(), "stuck", nsPath, "push").catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/no progress for 1s/);
    warn.mockRestore();
  }, 20000);
});

describe("bounded concurrency", () => {
  it("keeps several transfers in flight but never more than the configured width", async () => {
    process.env.S3_SYNC_CONCURRENCY = "4";
    wire.delayMs = 40;
    const nsPath = mkNamespace("pool", 24);

    const start = Date.now();
    const stats = await syncNamespace(cfg(), "pool", nsPath, "push");
    const elapsed = Date.now() - start;

    expect(stats?.uploaded).toBe(24);
    expect(wire.maxInFlight).toBeGreaterThan(1); // actually parallel
    expect(wire.maxInFlight).toBeLessThanOrEqual(4); // bounded
    // 24 x 40 ms serial = 960 ms; 4-wide should be well under that.
    expect(elapsed).toBeLessThan(900);
  }, 20000);
});
