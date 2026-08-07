import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import {
  commitNamespaceWithParams,
  flushAllCommits,
  flushNamespaceCommit,
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

describe("autocommit batching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces a burst of writes into one commit", () => {
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

  it("commits immediately when the line threshold is hit", () => {
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
      commitNamespaceWithParams(ns, "chore: test", tight);
      // 2 calls >= maxLines 2 → immediate commit.
      expect(commitCount(ns)).toBe(1);
    } finally {
      fs.rmSync(ns, { recursive: true, force: true });
    }
  });

  it("commits per write when batching is disabled", () => {
    const ns = makeTempNamespace();
    try {
      const immediate: BatchingParams = {
        maxLines: 100,
        maxSeconds: 30,
        enabled: false,
      };
      writeRecord(ns, "a.txt", "one");
      commitNamespaceWithParams(ns, "chore: test", immediate);
      writeRecord(ns, "b.txt", "two");
      commitNamespaceWithParams(ns, "chore: test", immediate);
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
