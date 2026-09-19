/**
 * OPS-006 — namespace auto-commit/push must never block the event loop.
 *
 * The live daemon stalls its `/health` handler while a namespace commit +
 * git-remote-s3 push runs, because `immediateCommit()` spawned `git` through
 * `execSync` (six of them) and `pushNamespace()` did the same for
 * `git push` — the whole bundle/pack-objects run held the JS thread.
 *
 * The proof in this file is behavioural, not structural:
 *
 *  1. the synchronous child-process primitives (`execSync` / `spawnSync`) are
 *     patched to STALL the event loop for 1500ms whenever product code calls
 *     them, and a heartbeat timer on the SAME loop must keep firing (<250ms
 *     gaps) while the namespace commit+push path runs. Pre-fix the write path
 *     calls `execSync`, so the heartbeat gap is >=1500ms. Post-fix the write
 *     path never touches a sync primitive, so it stays small.
 *  2. the tripwire counter also proves criterion 2 directly: no serving-path
 *     branch (first-write git-init, debounced timer, line-cap flush,
 *     batching-disabled) increments it.
 *  3. a scratch namespace whose remote is a LOCAL BARE repo proves the commit
 *     AND the ref advance survive the rewrite (AUTOPUSH-001 parity).
 *  4. a spawned, short-lived real CLI process (`node bin/duckbrain.js
 *     remember …`) proves the DOGFOOD-005 contract still holds across a
 *     process boundary: commit + push happen before the process exits.
 *
 * Hermetic: every namespace lives in `os.tmpdir()`, remotes are local bare
 * repos, nothing here touches S3 or the network. Git calls made by the TESTS
 * use `execFileSync` (never the patched `execSync`) so the tripwire counts
 * product-code calls only.
 */
import { describe, it, expect, vi } from "vitest";
import { execFileSync, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Process-spawning suite: file-scoped budgets (see src/search/* for the
// convention). Global budgets are deliberately untouched.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/** Stall duration the patched sync primitive burns on its first call. */
const SYNC_STALL_MS = 1500;
/** Upper bound a heartbeat gap may reach while the commit+push path runs. */
const HEARTBEAT_BUDGET_MS = 250;
/** Heartbeat sampling cadence. */
const HEARTBEAT_INTERVAL_MS = 50;

/**
 * Tripwire recorder. `vi.hoisted` so the `vi.mock` factory below (which vitest
 * hoists above the imports) can reach it.
 */
const rec = vi.hoisted(() => ({
  /** Number of synchronous child-process spawns product code performed. */
  syncCalls: 0,
  /** Every async `execFile` product code performed (file, argv, options). */
  execFileCalls: [] as { argv: string[]; cwd: string; timeoutMs?: number }[],
}));

/**
 * Patch the SYNC child-process primitives to stall the loop, and record the
 * async ones. Everything else stays the real module (the test file's own
 * `execFileSync`/`spawn` imports resolve to the real implementations).
 */
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();

  /** Burn the event loop for SYNC_STALL_MS — exactly what execSync does. */
  const stall = (): void => {
    const end = Date.now() + SYNC_STALL_MS;
    while (Date.now() < end) {
      /* intentionally busy: a synchronous primitive blocks, it does not yield */
    }
  };

  const recordSyncSpawn = (): void => {
    rec.syncCalls += 1;
    // Stall on the first call only: one blocked loop is all the proof needs,
    // and it keeps a RED run from taking 6 × 1500ms.
    if (rec.syncCalls === 1) stall();
  };

  return {
    ...actual,
    execSync: (...args: unknown[]) => {
      recordSyncSpawn();
      return (actual.execSync as (...a: unknown[]) => unknown)(...args);
    },
    spawnSync: (...args: unknown[]) => {
      recordSyncSpawn();
      return (actual.spawnSync as (...a: unknown[]) => unknown)(...args);
    },
    execFile: (...args: unknown[]) => {
      const [, argv, options] = args as [
        string,
        string[],
        { cwd?: string; timeout?: number } | undefined,
      ];
      rec.execFileCalls.push({
        argv: Array.isArray(argv) ? argv : [],
        cwd: options?.cwd ?? "",
        timeoutMs: options?.timeout,
      });
      return (actual.execFile as (...a: unknown[]) => unknown)(...args);
    },
  };
});

import { commitNamespaceWithParams, type BatchingParams } from "./autocommit";

const BIN_PATH = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");

/** Git helper for the TESTS (product calls never go through execFileSync). */
function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
}

/**
 * PUSH-001: the autopush hook is config-gated now (default = zero pushes).
 * These tests exercise the push machinery itself, so they flip the GAP-022
 * temp config to an enabled autopush block for the duration of the callback
 * and restore it afterwards.
 */
function withAutopushEnabled<T>(fn: () => T | Promise<T>): Promise<T> {
  const cfgPath =
    process.env.DUCKBRAIN_CONFIG_PATH ||
    path.join(process.cwd(), "duckbrain.config.json");
  const snapshot = fs.existsSync(cfgPath)
    ? fs.readFileSync(cfgPath, "utf-8")
    : null;
  const base = snapshot ? JSON.parse(snapshot) : {};
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      ...base,
      s3: { enabled: true, pushOnCommit: true, intervalSec: 300 },
    }),
  );
  // Await even fire-and-forget promises so the async commit+push (chained on
  // asyncChains) runs BEFORE the config is restored — the gate reads config
  // at push time, not at call time.
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (snapshot !== null) fs.writeFileSync(cfgPath, snapshot);
      else fs.unlinkSync(cfgPath);
    });
}

function params(over: Partial<BatchingParams> = {}): BatchingParams {
  return { maxLines: 100, maxSeconds: 30, enabled: true, ...over };
}

function scratchDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` holds or the deadline passes. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  return predicate();
}

function commitCount(dir: string): number {
  try {
    return parseInt(git(dir, "rev-list", "--count", "HEAD").trim(), 10);
  } catch {
    return 0;
  }
}

function initRepo(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "ops006@test.local");
  git(dir, "config", "user.name", "OPS-006 Test");
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "chore: init namespace");
}

function makeBare(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "--bare", "-q");
}

describe("OPS-006: the serving path never blocks the event loop on git", () => {
  it("keeps a heartbeat firing while the first-write commit+push runs (criterion 1)", async () => {
    // No .git → the first-write path: git init + identity + add + commit +
    // push all run.
    const ns = scratchDir("duckbrain-ops006-heartbeat-");
    const syncBefore = rec.syncCalls;
    const gaps: number[] = [];
    let last = Date.now();

    const heartbeat = setInterval(() => {
      const now = Date.now();
      gaps.push(now - last);
      last = now;
    }, HEARTBEAT_INTERVAL_MS);

    try {
      fs.writeFileSync(path.join(ns, "current.jsonl"), '{"k":"v"}\n', "utf8");
      await commitNamespaceWithParams(ns, "chore: ops006 heartbeat", params());
      // A stalled loop cannot run the heartbeat DURING the stall: the overdue
      // tick only lands once the loop is free, so let one beat pass before
      // reading the gaps (this is what makes the pre-fix failure visible).
      await delay(4 * HEARTBEAT_INTERVAL_MS);
    } finally {
      clearInterval(heartbeat);
    }

    expect(gaps.length).toBeGreaterThan(3);
    const maxGap = Math.max(...gaps);
    // Pre-fix: the loop was held for the entire git run (>= 1500ms).
    expect(maxGap).toBeLessThan(HEARTBEAT_BUDGET_MS);
    // Criterion 2 for this branch: no synchronous spawn was reachable.
    expect(rec.syncCalls - syncBefore).toBe(0);

    // …and the work genuinely happened, so the timing assertion is not vacuous.
    expect(commitCount(ns)).toBeGreaterThanOrEqual(1);
    expect(git(ns, "ls-tree", "-r", "--name-only", "HEAD")).toContain(
      "current.jsonl",
    );
  });

  it("schedules async work from every serving-path branch (criterion 2)", async () => {
    const batching = params({ maxLines: 2, maxSeconds: 0.05 });

    // (a) First write to a namespace with no .git — DOGFOOD-005 git-init path.
    const fresh = scratchDir("duckbrain-ops006-branch-first-");
    fs.writeFileSync(path.join(fresh, "a.jsonl"), "{}\n", "utf8");
    let before = rec.syncCalls;
    await commitNamespaceWithParams(
      fresh,
      "chore: ops006 first write",
      params(),
    );
    expect(commitCount(fresh)).toBeGreaterThanOrEqual(1);
    expect(rec.syncCalls - before).toBe(0);

    // (b) Debounced timer branch: the window fires the commit off the loop.
    const debounced = scratchDir("duckbrain-ops006-branch-window-");
    initRepo(debounced);
    const windowBaseline = commitCount(debounced);
    before = rec.syncCalls;
    fs.writeFileSync(path.join(debounced, "b.jsonl"), "{}\n", "utf8");
    await commitNamespaceWithParams(
      debounced,
      "chore: ops006 window",
      batching,
    );
    expect(
      await waitFor(() => commitCount(debounced) > windowBaseline, 10_000),
    ).toBe(true);
    expect(rec.syncCalls - before).toBe(0);

    // (c) Line-cap flush branch: the write that trips maxLines commits now.
    const capped = scratchDir("duckbrain-ops006-branch-cap-");
    initRepo(capped);
    const capBaseline = commitCount(capped);
    before = rec.syncCalls;
    await commitNamespaceWithParams(capped, "chore: ops006 cap 1", batching);
    fs.writeFileSync(path.join(capped, "c.jsonl"), "{}\n", "utf8");
    await commitNamespaceWithParams(capped, "chore: ops006 cap 2", batching);
    expect(commitCount(capped)).toBe(capBaseline + 1);
    expect(rec.syncCalls - before).toBe(0);

    // (d) Batching disabled branch: one commit per write, still async.
    const unbatched = scratchDir("duckbrain-ops006-branch-nobatch-");
    before = rec.syncCalls;
    fs.writeFileSync(path.join(unbatched, "d.jsonl"), "{}\n", "utf8");
    await commitNamespaceWithParams(
      unbatched,
      "chore: ops006 no batching",
      params({ enabled: false }),
    );
    expect(commitCount(unbatched)).toBeGreaterThanOrEqual(1);
    expect(rec.syncCalls - before).toBe(0);
  });

  it("commits AND advances the bare remote's ref (criterion 3, AUTOPUSH-001)", async () => {
    const ns = scratchDir("duckbrain-ops006-push-");
    initRepo(ns);
    const upstream = path.join(
      scratchDir("duckbrain-ops006-upstream-"),
      "s3daily.git",
    );
    const decoy = path.join(
      scratchDir("duckbrain-ops006-decoy-"),
      "origin.git",
    );
    makeBare(upstream);
    makeBare(decoy);
    git(ns, "remote", "add", "origin", decoy);
    git(ns, "remote", "add", "s3daily", upstream);
    fs.writeFileSync(path.join(ns, "push.jsonl"), '{"k":"pushed"}\n', "utf8");

    // enabled:false → the serving-path async commit+push runs per write, and
    // the returned promise settles only once commit AND push are done.
    // PUSH-001: the push is config-gated, so the s3 block is enabled here.
    await withAutopushEnabled(() =>
      commitNamespaceWithParams(
        ns,
        "chore: ops006 push parity",
        params({ enabled: false }),
      ),
    );

    const head = git(ns, "rev-parse", "HEAD").trim();
    const branch = git(ns, "rev-parse", "--abbrev-ref", "HEAD").trim();
    expect(git(ns, "ls-tree", "-r", "--name-only", "HEAD")).toContain(
      "push.jsonl",
    );
    // The canonical remote (preferred by selectPushRemote) advanced to HEAD.
    expect(git(upstream, "rev-parse", `refs/heads/${branch}`).trim()).toBe(
      head,
    );
    // …and the non-canonical remote was left untouched.
    expect(() => git(decoy, "rev-parse", `refs/heads/${branch}`)).toThrow();
  });

  it("logs and swallows a failing push, and keeps the push bounded (criterion 5)", async () => {
    const ns = scratchDir("duckbrain-ops006-failsafe-");
    initRepo(ns);
    const missing = path.join(
      scratchDir("duckbrain-ops006-missing-"),
      "gone.git",
    );
    git(ns, "remote", "add", "s3daily", missing);
    fs.writeFileSync(path.join(ns, "fail.jsonl"), '{"k":"x"}\n', "utf8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Must not reject: the write path never throws on git failure.
      // PUSH-001: the push is config-gated, so the s3 block is enabled here.
      await withAutopushEnabled(() =>
        commitNamespaceWithParams(
          ns,
          "chore: ops006 fail-safe",
          params({ enabled: false }),
        ),
      );
      const output = warn.mock.calls
        .map((call) => call.map((arg) => String(arg)).join(" "))
        .join("\n");
      expect(output).toContain("Push warning");

      // The record's history survived the failed push.
      expect(commitCount(ns)).toBeGreaterThanOrEqual(2);
      expect(git(ns, "ls-tree", "-r", "--name-only", "HEAD")).toContain(
        "fail.jsonl",
      );

      // The push itself was bounded (<= 30s) and never unbounded.
      const pushCall = rec.execFileCalls.find((call) =>
        call.argv.includes("push"),
      );
      expect(pushCall).toBeDefined();
      expect(pushCall!.argv).toContain("--set-upstream");
      expect(pushCall!.timeoutMs).toBe(30_000);
      expect(pushCall!.timeoutMs!).toBeLessThanOrEqual(30_000);
    } finally {
      warn.mockRestore();
    }
  });
});

/** Spawn the real CLI and capture stdout/stderr until exit or timeout. */
function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 45_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      env,
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("OPS-006: short-lived CLI processes still commit and push (criterion 4)", () => {
  it("a `remember` run leaves the commit AND the pushed ref behind after exit", async () => {
    const root = scratchDir("duckbrain-ops006-cli-");
    const nsRoot = path.join(root, "namespaces");
    fs.mkdirSync(nsRoot, { recursive: true });

    // (1) Existing namespace with a local bare remote → the write is
    //     debounced, so the exit-time flush is what must commit + push.
    const nsName = "ops006-cli-push";
    const ns = path.join(nsRoot, nsName);
    fs.mkdirSync(ns, { recursive: true });
    initRepo(ns);
    const upstream = path.join(root, "upstream.git");
    makeBare(upstream);
    git(ns, "remote", "add", "s3daily", upstream);

    // (2) Namespace that does not exist yet → first-write git-init path, which
    //     is async now: the process must not exit before it lands.
    const freshName = "ops006-cli-fresh";
    const fresh = path.join(nsRoot, freshName);

    const configPath = path.join(root, "duckbrain.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        namespacesPath: nsRoot,
        // Keep batching ON with the production window: the CLI cannot wait 30s
        // for the timer, so its exit flush is what has to do the work.
        gitBatching: { enabled: true, maxLines: 100, maxSeconds: 30 },
        // PUSH-001: the exit-flush push is config-gated; enable it so this
        // test keeps proving the commit AND pushed-ref parity contract.
        s3: { enabled: true, pushOnCommit: true, intervalSec: 300 },
      }),
      "utf-8",
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DUCKBRAIN_CONFIG_PATH: configPath,
      DUCKBRAIN_NAMESPACES_PATH: nsRoot,
      DUCKBRAIN_DATA_DIR: root,
      NO_COLOR: "1",
    };
    delete env.DUCKBRAIN_DURABILITY_MODE;

    const first = await runCli(
      [
        "remember",
        "/ops006/push",
        "--domain=raw_note",
        `--namespace=${nsName}`,
        "--content=ops006 cli parity",
      ],
      env,
    );
    expect(first.stderr).not.toContain("Failed to remember");
    expect(first.code).toBe(0);

    // The record is committed AND the bare remote's ref advanced — after the
    // process is gone.
    const branch = git(ns, "rev-parse", "--abbrev-ref", "HEAD").trim();
    const head = git(ns, "rev-parse", "HEAD").trim();
    expect(commitCount(ns)).toBeGreaterThanOrEqual(2);
    expect(git(upstream, "rev-parse", `refs/heads/${branch}`).trim()).toBe(
      head,
    );

    const second = await runCli(
      [
        "remember",
        "/ops006/fresh",
        "--domain=raw_note",
        `--namespace=${freshName}`,
        "--content=ops006 cli first write",
      ],
      env,
    );
    expect(second.code).toBe(0);

    // The implicit namespace was git-inited and committed by the time the
    // process exited (the async first-write kept the loop alive until done).
    expect(fs.existsSync(path.join(fresh, ".git"))).toBe(true);
    expect(commitCount(fresh)).toBeGreaterThanOrEqual(1);
  });
});
