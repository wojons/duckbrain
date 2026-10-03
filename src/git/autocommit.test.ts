import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import {
  commitNamespaceWithParams,
  drainAsyncCommits,
  flushAllCommits,
  flushNamespaceCommit,
  resolveGitBinary,
  selectPushRemote,
  buildPushCommand,
  GIT_BINARY_UNRESOLVED,
  type BatchingParams,
} from "./autocommit";

function makeTempNamespace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-autocommit-test-"));
}

/**
 * Pre-initialize a git repo in a temp namespace so the batching code path
 * (second-and-later writes) is exercised, rather than the DOGFOOD-005
 * first-write path that always commits immediately when .git is missing.
 */
function initGitRepo(dir: string): void {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.local"', {
    cwd: dir,
    stdio: "pipe",
  });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
}

function commitCount(dir: string): number {
  try {
    return parseInt(
      execSync("git rev-list --count HEAD", { cwd: dir, stdio: "pipe" })
        .toString()
        .trim(),
      10,
    );
  } catch {
    return 0;
  }
}

function writeRecord(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content, "utf8");
}

const params30: BatchingParams = {
  maxLines: 100,
  maxSeconds: 30,
  enabled: true,
};

/** One commit per write — forces the commit path without a debounce window. */
const noBatching: BatchingParams = {
  maxLines: 100,
  maxSeconds: 30,
  enabled: false,
};

/** Join every recorded console call of a spy for substring assertions. */
function outputOf(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls
    .map((call) => call.map((arg) => String(arg)).join(" "))
    .join("\n");
}

describe("autocommit batching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces a burst of writes into one commit", async () => {
    const ns = makeTempNamespace();
    initGitRepo(ns);
    try {
      writeRecord(ns, "a.txt", "one");
      commitNamespaceWithParams(ns, "chore: test", params30);
      writeRecord(ns, "b.txt", "two");
      commitNamespaceWithParams(ns, "chore: test", params30);
      writeRecord(ns, "c.txt", "three");
      commitNamespaceWithParams(ns, "chore: test", params30);

      // Nothing committed yet — window still open.
      expect(commitCount(ns)).toBe(0);

      vi.advanceTimersByTime(30_000);
      // OPS-006: the fired window now commits ASYNCHRONOUSLY (off the event
      // loop) — wait for the in-flight chain before reading the history.
      await drainAsyncCommits();
      expect(commitCount(ns)).toBe(1);

      // All three files landed in the single commit.
      const files = execSync("git ls-tree -r --name-only HEAD", {
        cwd: ns,
        stdio: "pipe",
      })
        .toString()
        .trim()
        .split("\n")
        .sort();
      expect(files).toEqual(["a.txt", "b.txt", "c.txt"]);
    } finally {
      fs.rmSync(ns, { recursive: true, force: true });
    }
  });

  it("commits immediately when the line threshold is hit", async () => {
    const ns = makeTempNamespace();
    initGitRepo(ns);
    try {
      const tight: BatchingParams = {
        maxLines: 2,
        maxSeconds: 30,
        enabled: true,
      };
      writeRecord(ns, "a.txt", "one");
      commitNamespaceWithParams(ns, "chore: test", tight);
      expect(commitCount(ns)).toBe(0);

      writeRecord(ns, "b.txt", "two");
      // 2 calls >= maxLines 2 → flush now. OPS-006: the flush is async, so
      // await the promise this call returns (the chain promise).
      await commitNamespaceWithParams(ns, "chore: test", tight);
      expect(commitCount(ns)).toBe(1);
    } finally {
      fs.rmSync(ns, { recursive: true, force: true });
    }
  });

  it("commits per write when batching is disabled", async () => {
    const ns = makeTempNamespace();
    try {
      const immediate: BatchingParams = {
        maxLines: 100,
        maxSeconds: 30,
        enabled: false,
      };
      writeRecord(ns, "a.txt", "one");
      // OPS-006: batching-disabled writes still commit one-per-write, but the
      // commit happens off the event loop — await each triggered chain.
      await commitNamespaceWithParams(ns, "chore: test", immediate);
      writeRecord(ns, "b.txt", "two");
      await commitNamespaceWithParams(ns, "chore: test", immediate);
      expect(commitCount(ns)).toBe(2);
    } finally {
      fs.rmSync(ns, { recursive: true, force: true });
    }
  });

  it("flushNamespaceCommit commits pending changes immediately", () => {
    const ns = makeTempNamespace();
    initGitRepo(ns);
    try {
      writeRecord(ns, "a.txt", "one");
      commitNamespaceWithParams(ns, "chore: test", params30);
      expect(commitCount(ns)).toBe(0);

      flushNamespaceCommit(ns);
      expect(commitCount(ns)).toBe(1);

      // Flushing again with nothing pending is a no-op.
      flushAllCommits();
      expect(commitCount(ns)).toBe(1);
    } finally {
      fs.rmSync(ns, { recursive: true, force: true });
    }
  });
});

describe("deferred-commit failure classification (AUTOCOMMIT-ENOENT-001)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * The measured defect: a client creates an ephemeral namespace, writes, and
   * DELETES it inside the batching window (the auger pytest suite does this
   * ~370x/day). The debounced timer then fired on a directory that no longer
   * existed and the spawn failed with `spawn git ENOENT` — the same errno Node
   * reports for a missing BINARY — so the log blamed git. The deferred commit
   * must now skip, say what actually happened, and never emit the ENOENT
   * warning.
   */
  it("skips a deferred commit whose namespace was removed and says so", async () => {
    const ns = makeTempNamespace();
    initGitRepo(ns);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeRecord(ns, "a.jsonl", "one");
      commitNamespaceWithParams(ns, "chore: test", params30);
      // Nothing committed yet — window still open…
      expect(commitCount(ns)).toBe(0);
      // …and the client removes its namespace before the timer fires.
      fs.rmSync(ns, { recursive: true, force: true });
      expect(fs.existsSync(ns)).toBe(false);

      vi.advanceTimersByTime(30_000);
      await drainAsyncCommits();

      // Asserted on the log TEXT, not merely the absence of a crash: the
      // distinct, accurate, info-level message naming the namespace.
      expect(outputOf(info)).toContain(
        `[Git] Namespace removed before deferred commit; skipping ${ns}`,
      );
      // The false-positive warning (and its ENOENT wording) is gone entirely.
      expect(outputOf(warn)).not.toContain("ENOENT");
      expect(outputOf(warn)).not.toContain("Auto-commit warning");
    } finally {
      info.mockRestore();
      warn.mockRestore();
      fs.rmSync(ns, { recursive: true, force: true });
    }
  });

  /**
   * The duplicated second site: the synchronous exit-flush path spawns git
   * through `execSync` with the same cwd, so a window flushed after the
   * namespace was deleted failed identically. An 'exit' handler must never
   * throw, and it must report the removed namespace rather than a spawn error.
   */
  it("skips the exit-flush commit for a namespace removed inside the window", () => {
    const ns = makeTempNamespace();
    initGitRepo(ns);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeRecord(ns, "a.jsonl", "one");
      commitNamespaceWithParams(ns, "chore: test", params30);
      fs.rmSync(ns, { recursive: true, force: true });

      expect(() => flushNamespaceCommit(ns)).not.toThrow();
      expect(outputOf(info)).toContain(
        `[Git] Namespace removed before exit-flush commit; skipping ${ns}`,
      );
      expect(outputOf(warn)).not.toContain("ENOENT");
      expect(outputOf(warn)).not.toContain("Auto-commit warning");
    } finally {
      info.mockRestore();
      warn.mockRestore();
      fs.rmSync(ns, { recursive: true, force: true });
    }
  });

  /**
   * The case the old warning could not be told apart from the deleted-cwd
   * race: a LIVE namespace whose git genuinely cannot be spawned. The warning
   * must name the resolved git binary and the cwd.
   */
  it("names the resolved git binary and cwd when a live namespace cannot spawn git", async () => {
    const ns = makeTempNamespace();
    initGitRepo(ns);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const originalPath = process.env.PATH;
    const emptyPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-no-git-"),
    );
    try {
      writeRecord(ns, "a.jsonl", "one");
      // GENUINE git-unavailable: the namespace directory is still on disk (the
      // pre-spawn check passes), but nothing named `git` is on PATH.
      process.env.PATH = emptyPath;

      await commitNamespaceWithParams(ns, "chore: test", noBatching);

      const output = outputOf(warn);
      expect(output).toContain("[Git] Auto-commit warning");
      expect(output).toContain(`cwd=${ns}`);
      expect(output).toContain(`git=${GIT_BINARY_UNRESOLVED}`);
      // The namespace is untouched and commit-free — nothing was skipped here,
      // the spawn itself failed.
      expect(commitCount(ns)).toBe(0);
    } finally {
      process.env.PATH = originalPath;
      warn.mockRestore();
      fs.rmSync(emptyPath, { recursive: true, force: true });
      fs.rmSync(ns, { recursive: true, force: true });
    }
  });

  it("resolves the git binary from PATH and reports an unresolved PATH", () => {
    const resolved = resolveGitBinary();
    expect(resolved).not.toBe(GIT_BINARY_UNRESOLVED);
    expect(fs.existsSync(resolved)).toBe(true);
    expect(path.basename(resolved)).toMatch(/^git(\.exe|\.cmd|\.bat)?$/);

    const emptyPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-no-git-"),
    );
    try {
      expect(resolveGitBinary({ PATH: emptyPath })).toBe(GIT_BINARY_UNRESOLVED);
      expect(resolveGitBinary({ PATH: "" })).toBe(GIT_BINARY_UNRESOLVED);
    } finally {
      fs.rmSync(emptyPath, { recursive: true, force: true });
    }
  });
});

describe("pushNamespace remote/branch resolution (AUTOPUSH-001)", () => {
  it("selects s3daily when present among remotes", () => {
    expect(selectPushRemote("s3daily")).toBe("s3daily");
    expect(selectPushRemote("origin\ns3daily")).toBe("s3daily");
    expect(selectPushRemote("s3daily\nbackup")).toBe("s3daily");
  });

  it("falls back to the first remote when s3daily is absent", () => {
    expect(selectPushRemote("origin")).toBe("origin");
    expect(selectPushRemote("upstream\norigin")).toBe("upstream");
  });

  it("returns null for an empty remote list", () => {
    expect(selectPushRemote("")).toBeNull();
    expect(selectPushRemote("   \n  ")).toBeNull();
  });

  it("builds an explicit push command that sets upstream", () => {
    expect(buildPushCommand("s3daily", "master")).toBe(
      "git push --set-upstream s3daily master",
    );
    expect(buildPushCommand("origin", "feat/native-s3")).toBe(
      "git push --set-upstream origin feat/native-s3",
    );
  });
});
