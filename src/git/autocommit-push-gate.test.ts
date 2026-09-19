/**
 * PUSH-001 — gated S3 autopush: the commit-flush push hook must honor
 * s3.enabled + s3.pushOnCommit (default = zero pushes), coalesce per
 * namespace (intervalSec floor + single-flight), and skip when HEAD is
 * unchanged since the last successful push.
 *
 * Hermetic by construction: every test uses a temp working repo with a
 * `file://` bare remote (a real git transport, no network, no AWS, no
 * git-remote-s3). Push-invocation counting is done by a post-receive hook
 * on the bare remote that appends HEAD to a log file — git runs the hook
 * for us, so no git-protocol stub is needed (a hand-rolled protocol stub
 * deadlocks on the binary packfile stream; see the PUSH-001 worker tick).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import {
  flushNamespaceCommit,
  evaluatePushGate,
  pushGateStates,
  pushNamespace,
  commitNamespace,
} from "./autocommit";
import { DEFAULT_S3_CONFIG, type S3Config } from "../s3/config";

/** Make a per-test copy of the default (disabled) s3 config block. */
function s3cfg(over: Partial<S3Config> = {}): S3Config {
  return { ...DEFAULT_S3_CONFIG, ...over };
}

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

let tmp: string;
let nsDir: string;
let barePath: string;
let hookLog: string;
let cfgPath: string;
let cfgSnapshot: string | null;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-pushgate-"));
  nsDir = path.join(tmp, "ns");
  barePath = path.join(tmp, "bare.git");
  hookLog = path.join(tmp, "pushes.log");
  fs.mkdirSync(nsDir, { recursive: true });

  // Snapshot the GAP-022 temp config; tests that flip the autopush gate
  // restore it so nothing leaks into sibling tests.
  cfgPath =
    process.env.DUCKBRAIN_CONFIG_PATH ||
    path.join(process.cwd(), "duckbrain.config.json");
  cfgSnapshot = fs.existsSync(cfgPath)
    ? fs.readFileSync(cfgPath, "utf-8")
    : null;

  execSync(`git init -q -b master "${nsDir}"`);
  git("config user.email test@example.com", nsDir);
  git('config user.name "Push Gate Test"', nsDir);

  execSync(`git init -q --bare "${barePath}"`);
  git("config user.email test@example.com", barePath);
  git('config user.name "Push Gate Test"', barePath);
  // post-receive hook = push-invocation counter (runs server-side on every
  // successful push; appends the pushed new-tip to the log).
  const hook = path.join(barePath, "hooks", "post-receive");
  fs.writeFileSync(
    hook,
    `#!/bin/sh\nwhile read _old new _ref; do echo "$new" >> '${hookLog}'; done\n`,
  );
  fs.chmodSync(hook, 0o755);

  // First commit in the working repo.
  fs.writeFileSync(path.join(nsDir, "data.jsonl"), "{}\n");
  git("add -A", nsDir);
  git("commit -q -m init", nsDir);

  pushGateStates.clear();
});

afterEach(() => {
  if (cfgSnapshot !== null) fs.writeFileSync(cfgPath, cfgSnapshot);
  else if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
  fs.rmSync(tmp, { recursive: true, force: true });
  pushGateStates.clear();
});

function pushCount(): number {
  if (!fs.existsSync(hookLog)) return 0;
  return fs
    .readFileSync(hookLog, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "").length;
}

function head(): string {
  return git("rev-parse HEAD", nsDir);
}

/** Point the GAP-022 temp config at an autopush-enabled s3 block. */
function enableAutopush(intervalSec = 300): void {
  const cfgPath =
    process.env.DUCKBRAIN_CONFIG_PATH ||
    path.join(process.cwd(), "duckbrain.config.json");
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ s3: { enabled: true, pushOnCommit: true, intervalSec } }),
  );
}

describe("PUSH-001 evaluatePushGate (pure decision)", () => {
  const state = () => ({ lastAttemptAt: 0 });
  const NOW = 1_000_000;

  it("blocks when s3 is disabled (default config)", () => {
    expect(evaluatePushGate(s3cfg(), state(), NOW)).toBe(false);
    expect(evaluatePushGate(undefined, state(), NOW)).toBe(false);
  });

  it("blocks when pushOnCommit is off even if enabled", () => {
    expect(evaluatePushGate(s3cfg({ enabled: true }), state(), NOW)).toBe(
      false,
    );
  });

  it("allows enabled+pushOnCommit with no prior attempt", () => {
    expect(
      evaluatePushGate(
        s3cfg({ enabled: true, pushOnCommit: true }),
        state(),
        NOW,
      ),
    ).toBe(true);
  });

  it("blocks inside the intervalSec floor, allows at/past it", () => {
    const cfg = s3cfg({ enabled: true, pushOnCommit: true, intervalSec: 300 });
    expect(evaluatePushGate(cfg, { lastAttemptAt: NOW - 299_999 }, NOW)).toBe(
      false,
    );
    expect(evaluatePushGate(cfg, { lastAttemptAt: NOW - 300_000 }, NOW)).toBe(
      true,
    );
  });

  it("intervalSec <= 0 disables the coalescing floor", () => {
    const cfg = s3cfg({ enabled: true, pushOnCommit: true, intervalSec: 0 });
    expect(evaluatePushGate(cfg, { lastAttemptAt: NOW }, NOW)).toBe(true);
  });
});

describe("PUSH-001 pushNamespace (sync exit path, real git via file:// remote)", () => {
  function wireRemote(): void {
    git(`remote add s3daily "${barePath}"`, nsDir);
  }

  it("AC-a: pushOnCommit=false (default) → zero pushes", () => {
    wireRemote();
    pushNamespace(nsDir);
    expect(pushCount()).toBe(0);
  });

  it("AC-b/c: gate on → first call pushes; immediate re-commit skips", () => {
    wireRemote();
    enableAutopush();
    pushGateStates.set(nsDir, {
      lastAttemptAt: 0,
      lastPushedHead: null,
      inFlight: null,
    });
    pushNamespace(nsDir);
    expect(pushCount()).toBe(1);

    // New commit inside the interval floor → skipped (no second push).
    fs.writeFileSync(path.join(nsDir, "data.jsonl"), '{"a":1}\n');
    git("add -A", nsDir);
    git("commit -q -m second", nsDir);
    pushNamespace(nsDir);
    expect(pushCount()).toBe(1);
  });

  it("AC-d: after the interval with a new HEAD → pushes again", () => {
    wireRemote();
    enableAutopush();
    pushGateStates.set(nsDir, {
      lastAttemptAt: 0,
      lastPushedHead: null,
      inFlight: null,
    });
    pushNamespace(nsDir);
    expect(pushCount()).toBe(1);

    // New HEAD + elapsed interval → second push.
    fs.writeFileSync(path.join(nsDir, "data.jsonl"), '{"b":2}\n');
    git("add -A", nsDir);
    git("commit -q -m third", nsDir);
    pushGateStates.get(nsDir)!.lastAttemptAt = Date.now() - 301_000;
    pushNamespace(nsDir);
    expect(pushCount()).toBe(2);

    // Same HEAD after the interval → skipped (skip-unchanged).
    pushGateStates.get(nsDir)!.lastAttemptAt = Date.now() - 301_000;
    pushNamespace(nsDir);
    expect(pushCount()).toBe(2);
  });

  it("failed push leaves lastPushedHead null → retry allowed at next gate-open", () => {
    wireRemote();
    enableAutopush();
    pushGateStates.set(nsDir, {
      lastAttemptAt: 0,
      lastPushedHead: null,
      inFlight: null,
    });
    pushNamespace(nsDir);
    expect(pushCount()).toBe(1);

    // Point the remote at a non-repo dir: push fails, nothing recorded.
    git(`remote set-url s3daily "${tmp}/not-a-repo"`, nsDir);
    fs.writeFileSync(path.join(nsDir, "data.jsonl"), '{"c":3}\n');
    git("add -A", nsDir);
    git("commit -q -m fourth", nsDir);
    pushGateStates.get(nsDir)!.lastAttemptAt = Date.now() - 301_000;
    pushNamespace(nsDir); // must swallow the failure (never throw)
    expect(pushCount()).toBe(1);
    expect(pushGateStates.get(nsDir)!.lastPushedHead).not.toBe(head());

    // Restore the good remote → the same HEAD pushes now (retry allowed).
    git(`remote set-url s3daily "${barePath}"`, nsDir);
    pushGateStates.get(nsDir)!.lastAttemptAt = Date.now() - 301_000;
    pushNamespace(nsDir);
    expect(pushCount()).toBe(2);
    expect(pushGateStates.get(nsDir)!.lastPushedHead).toBe(head());
  });

  it("no remote → silent no-op even with the gate fully open", () => {
    pushGateStates.set(nsDir, {
      lastAttemptAt: 0,
      lastPushedHead: null,
      inFlight: null,
    });
    pushNamespace(nsDir);
    expect(pushCount()).toBe(0);
  });
});

describe("PUSH-001 commitNamespace + exit-flush (serving-path integration)", () => {
  it("default config → commit flush performs zero pushes", () => {
    wireRemoteHelper();
    commitNamespace(nsDir, "test flush");
    flushNamespaceCommit(nsDir);
    expect(pushCount()).toBe(0);
  });

  it("gate fully open → commit flush pushes through the file:// remote", () => {
    wireRemoteHelper();
    enableAutopush();
    pushGateStates.set(nsDir, {
      lastAttemptAt: 0,
      lastPushedHead: null,
      inFlight: null,
    });
    commitNamespace(nsDir, "test flush gated");
    flushNamespaceCommit(nsDir);
    expect(pushCount()).toBe(1);
    // A second flush at the same HEAD inside the interval → still one push.
    fs.writeFileSync(path.join(nsDir, "data.jsonl"), '{"z":9}\n');
    git("add -A", nsDir);
    git("commit -q -m fifth", nsDir);
    flushNamespaceCommit(nsDir);
    expect(pushCount()).toBe(1);
  });
});

/** Shared wiring for the commit-flush tests (hoisted single definition). */
function wireRemoteHelper(): void {
  git(`remote add s3daily "${barePath}"`, nsDir);
}
