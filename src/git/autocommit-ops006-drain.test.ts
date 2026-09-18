/**
 * OPS-006 — shutdown drain semantics for in-flight async git work.
 *
 * The daemon's graceful shutdown waits for async commits/pushes it already
 * spawned (`drainAsyncCommits`), because a commit that is in flight when
 * SIGTERM arrives has nothing else to finish it (the debounce timers are
 * unref'd and the write path never blocks). The wait must be BOTH:
 *
 *  - real: it returns only after the work it saw in flight has settled; and
 *  - bounded: an exhausted budget returns immediately (with a warning) rather
 *    than hanging shutdown — the JSONL record is already durable, git history
 *    is best-effort.
 *
 * This file covers the new drain API specifically (the RED/GREEN event-loop
 * proof for the commit path lives in autocommit-ops006.test.ts). Hermetic:
 * scratch namespaces under os.tmpdir(), no remotes, no network.
 */
import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  commitNamespaceWithParams,
  drainAsyncCommits,
  type BatchingParams,
} from "./autocommit";

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const NO_BATCHING: BatchingParams = {
  maxLines: 100,
  maxSeconds: 30,
  enabled: false,
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
}

function commitCount(dir: string): number {
  try {
    return parseInt(git(dir, "rev-list", "--count", "HEAD").trim(), 10);
  } catch {
    return 0;
  }
}

describe("OPS-006: bounded drain of in-flight async git work", () => {
  it("waits for the in-flight commit instead of returning immediately", async () => {
    const ns = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-ops006-drain-"),
    );
    fs.writeFileSync(path.join(ns, "drain.jsonl"), '{"k":"v"}\n', "utf8");

    // Fire the first-write commit and deliberately do NOT await it: the drain
    // is the only thing that can observe it.
    void commitNamespaceWithParams(ns, "chore: ops006 drain", NO_BATCHING);
    await drainAsyncCommits(10_000);

    // The drain returned only once the commit it tracked had landed.
    expect(commitCount(ns)).toBeGreaterThanOrEqual(1);
    expect(git(ns, "ls-tree", "-r", "--name-only", "HEAD")).toContain(
      "drain.jsonl",
    );
  });

  it("returns instead of hanging when the drain budget is already exhausted", async () => {
    const ns = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-ops006-budget-"),
    );
    fs.writeFileSync(path.join(ns, "budget.jsonl"), '{"k":"v"}\n', "utf8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      void commitNamespaceWithParams(ns, "chore: ops006 budget", NO_BATCHING);
      const started = Date.now();
      await drainAsyncCommits(0);
      const elapsed = Date.now() - started;

      // Bounded: a zero budget returns at once (the work is still in flight or
      // already done — either way the drain must not wait for it).
      expect(elapsed).toBeLessThan(100);
      const output = warn.mock.calls
        .map((call) => call.map((arg) => String(arg)).join(" "))
        .join("\n");
      expect(output).toContain("Shutdown drain budget");
    } finally {
      warn.mockRestore();
      // Let the still-running chain settle so it cannot leak into the next test.
      await drainAsyncCommits(10_000);
    }

    // A fresh (unbounded-budget) drain returns immediately when idle.
    const idleStarted = Date.now();
    await drainAsyncCommits(10_000);
    expect(Date.now() - idleStarted).toBeLessThan(100);
  });
});
