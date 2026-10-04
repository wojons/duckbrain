/**
 * S3-GIT-007 — per-namespace sync deadline.
 *
 * A namespace whose push never resolves (SDK call stuck in epoll) used to hang
 * the whole `sync all` pass until the cron watchdog SIGTERM'd the process ~2h
 * later; the next run then cleared the stale lock and repeated. These tests
 * prove the deadline rejects, the timed-out namespace is skipped by the
 * sync-all loop, and the overall call still returns.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Stub the S3 wire: listRemoteObjects resolves (deltas are computable), but
// putObject NEVER resolves for keys under the "hung" namespace — reproducing
// the epoll hang — while uploads to other namespaces succeed.
vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return {
    ...actual,
    buildClient: () => ({}) as import("@aws-sdk/client-s3").S3Client,
    listRemoteObjects: async (_c: unknown, _b: string, prefix: string) =>
      new Map([[prefix + "stub.jsonl", { key: prefix + "stub.jsonl", size: 3 }]]),
    putObject: async (_c: unknown, _b: string, key: string): Promise<void> => {
      if (key.includes("/hung/")) {
        await new Promise<void>(() => {}); // never resolves — the hang
      }
    },
    getObject: async () => Buffer.alloc(0),
  };
});

import { syncAllNamespaces, namespaceDeadlineSeconds } from "./sync";
import { DEFAULT_S3_CONFIG, type S3Config } from "./config";
import fs from "fs";
import os from "os";
import path from "path";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-s3git007-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.S3_SYNC_NAMESPACE_DEADLINE_S;
});

function cfg(): S3Config {
  return { ...DEFAULT_S3_CONFIG, enabled: true };
}

describe("namespaceDeadlineSeconds", () => {
  it("defaults to 300s", () => {
    expect(namespaceDeadlineSeconds()).toBe(300);
  });

  it("honours S3_SYNC_NAMESPACE_DEADLINE_S", () => {
    process.env.S3_SYNC_NAMESPACE_DEADLINE_S = "7";
    expect(namespaceDeadlineSeconds()).toBe(7);
  });

  it("falls back to the default on garbage or non-positive values", () => {
    process.env.S3_SYNC_NAMESPACE_DEADLINE_S = "abc";
    expect(namespaceDeadlineSeconds()).toBe(300);
    process.env.S3_SYNC_NAMESPACE_DEADLINE_S = "0";
    expect(namespaceDeadlineSeconds()).toBe(300);
    process.env.S3_SYNC_NAMESPACE_DEADLINE_S = "-5";
    expect(namespaceDeadlineSeconds()).toBe(300);
  });
});

describe("syncAllNamespaces per-namespace deadline (S3-GIT-007)", () => {
  it("times out a hung namespace, skips it, completes the rest, and returns", async () => {
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    fs.mkdirSync(path.join(tmp, "namespaces", "good"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "namespaces", "hung"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "namespaces", "good", "a.jsonl"), "{}\n");
    fs.writeFileSync(path.join(tmp, "namespaces", "hung", "b.jsonl"), "{}\n");
    process.env.S3_SYNC_NAMESPACE_DEADLINE_S = "1";

    const nsPath = path.join(tmp, "namespaces");
    const stats = await syncAllNamespaces(cfg(), nsPath, "push");

    // hung ns was skipped (no stats) after its deadline; good ns completed.
    expect(stats.map((s) => s.ns)).toEqual(["good"]);
    expect(stats[0].uploaded).toBe(1);
    const warnings = warn.mock.calls.map((c) => String(c[0]));
    expect(
      warnings.some((s) => /sync hung timed out after 1s \(S3-GIT-007\)/.test(s)),
    ).toBe(true);
    // the deadline rejection flows into the existing per-ns try/catch
    expect(
      warnings.some((s) => /sync hung failed: sync deadline exceeded/.test(s)),
    ).toBe(true);
    warn.mockRestore();
  }, 15000);
});
