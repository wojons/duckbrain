/**
 * DF-0925-02 — SUPA-5 data/audit commit pairing.
 *
 * Root cause (live incident, ns repo /tmp/db-df0925/ns/df0925-feed): commit
 * 4fa4042 contained a write's data row (raw_note) but its accepted audit
 * (change) record only landed in the NEXT commit 34ae769 ~30s later — a
 * committed write was invisible to feed subscribers for up to 30s and the
 * committed ref permanently violated SUPA-5's "data append + accepted audit
 * row in the SAME namespace flush" requirement.
 *
 * Mechanism: the commit path (`asyncCommit`: `git add -A` → diff --cached →
 * commit) ran WITHOUT the namespace write lock, so a serializer flush could
 * append its data rows and `_audit/` records while the `git add -A`
 * subprocess was enumerating the worktree — the staged snapshot straddled
 * the burst and committed data without its audit.
 *
 * Fix under test: the stage→commit sequence now fences on the SAME
 * `.duckbrain-write/<ns>.lock` file the flush holds (namespaceWriter.flushOnce).
 *
 * Deterministic control (per the board row: "may force interleaving via the
 * afterLockAcquired seam or equivalent deterministic control"): a real
 * NamespaceWriter flush is suspended INSIDE afterLockAcquired — i.e. while it
 * holds the namespace write lock, before any append — and the REAL commit
 * path attempts to commit pre-seeded uncommitted worktree content at that
 * moment. Pre-fix the commit lands unfenced mid-flush; post-fix it cannot
 * take the lock, defers, and every commit that eventually lands carries
 * complete data+audit pairs.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createMemory, type MemoryType } from "../schema/memory";
import {
  acquireNamespaceWriteLock,
  namespaceWriteLockPath,
  releaseNamespaceWriteLock,
} from "../serialization/lock";
import { NamespaceWriter } from "../serialization/namespaceWriter";
import type { WriteInput } from "../serialization/types";
import {
  commitNamespaceWithParams,
  drainAsyncCommits,
  flushNamespaceCommit,
  waitForNamespaceCommit,
  type BatchingParams,
} from "./autocommit";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-df092502-"));
  roots.push(root);
  return root;
}

const roots: string[] = [];

function initGitRepo(nsPath: string): void {
  execSync("git init", { cwd: nsPath, stdio: "pipe" });
  execSync('git config user.email "test@test.local"', {
    cwd: nsPath,
    stdio: "pipe",
  });
  execSync('git config user.name "Test"', { cwd: nsPath, stdio: "pipe" });
}

function memory(index: number): MemoryType {
  return createMemory({
    key: `/df092502/${index}`,
    domain: "concept",
    author: "test@example.com",
    embedding_text: `record ${index}`,
  });
}

function input(record: MemoryType): WriteInput {
  return {
    ns: "alpha",
    table: "memories",
    op: "insert",
    record,
    principal: undefined,
    targetPath: "concept/2026-09/current.jsonl",
    partitionPath: "concept/2026-09/",
  };
}

/** Poll until the predicate holds (real timers, bounded). */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  what = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function commitCount(nsPath: string): number {
  try {
    return parseInt(
      execSync("git rev-list --count HEAD", { cwd: nsPath, stdio: "pipe" })
        .toString()
        .trim(),
      10,
    );
  } catch {
    return 0;
  }
}

/** File content at a commit (`git show <sha>:<relPath>`), or "" when absent. */
function showFile(nsPath: string, sha: string, relPath: string): string {
  try {
    return execSync(`git show ${sha}:${relPath}`, {
      cwd: nsPath,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  } catch {
    return "";
  }
}

function commitShas(nsPath: string): string[] {
  if (commitCount(nsPath) === 0) return [];
  return execSync("git log --reverse --format=%H", {
    cwd: nsPath,
    stdio: "pipe",
  })
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
}

function parentOf(nsPath: string, sha: string): string {
  return execSync(`git rev-parse ${sha}^`, {
    cwd: nsPath,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

interface PairCensus {
  commits: number;
  /** data ids whose accepted change record is NOT in the same commit. */
  unpairedData: string[];
  totalDataIds: number;
  totalAuditIds: number;
}

/**
 * SUPA-5 pair census over the whole history: for EVERY commit, the data rows
 * it introduces must have their accepted change records introduced by the
 * SAME commit ("every commit's _audit delta covers exactly its data delta" —
 * AC-1). Sweeps make an audit delta LARGER than its data delta legal; a data
 * delta that outruns the audit delta is the incident signature.
 */
function pairCensus(nsPath: string): PairCensus {
  const shas = commitShas(nsPath);
  const idsAt = (sha: string): Set<string> => {
    const lines = showFile(nsPath, sha, "concept/2026-09/current.jsonl")
      .split("\n")
      .filter((line) => line.trim() !== "");
    return new Set(
      lines
        .map((line) => {
          try {
            return JSON.parse(line).id as string | undefined;
          } catch {
            return undefined;
          }
        })
        .filter((id): id is string => typeof id === "string"),
    );
  };
  const auditIdsAt = (sha: string): Set<string> => {
    const lines = showFile(nsPath, sha, "_audit/current.jsonl")
      .split("\n")
      .filter((line) => line.trim() !== "");
    return new Set(
      lines
        .map((line) => {
          try {
            const entry = JSON.parse(line);
            return entry.outcome === "accepted" &&
              entry.key &&
              typeof entry.key.id === "string"
              ? (entry.key.id as string)
              : undefined;
          } catch {
            return undefined;
          }
        })
        .filter((id): id is string => typeof id === "string"),
    );
  };
  const unpairedData: string[] = [];
  let totalDataIds = 0;
  let totalAuditIds = 0;
  for (const sha of shas) {
    // The root commit (first in --reverse order) has no parent — its whole
    // tree IS the delta.
    const parent = sha !== shas[0] ? parentOf(nsPath, sha) : null;
    const dataBefore = parent ? idsAt(parent) : new Set<string>();
    const auditBefore = parent ? auditIdsAt(parent) : new Set<string>();
    const dataDelta = [...idsAt(sha)].filter((id) => !dataBefore.has(id));
    const auditDelta = new Set(
      [...auditIdsAt(sha)].filter((id) => !auditBefore.has(id)),
    );
    totalDataIds += dataDelta.length;
    totalAuditIds += auditDelta.size;
    for (const id of dataDelta) {
      if (!auditDelta.has(id)) unpairedData.push(id);
    }
  }
  return { commits: shas.length, unpairedData, totalDataIds, totalAuditIds };
}

const flushParams: BatchingParams = {
  maxLines: 100,
  maxSeconds: 60,
  enabled: false,
};

afterEach(async () => {
  await drainAsyncCommits();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 1. the fencing regression (deterministic RED control) ────────────────────

describe("DF-0925-02 commit fencing", () => {
  it("creates no commit while a serializer flush holds the namespace write lock", async () => {
    const root = makeRoot();
    const nsPath = path.join(root, "alpha");
    fs.mkdirSync(nsPath, { recursive: true });
    initGitRepo(nsPath);

    // Uncommitted paired worktree content (data + its audit record), present
    // BEFORE the flush starts — exactly the state a mid-flush `git add -A`
    // would sweep into an unfenced commit.
    const record = JSON.stringify({ id: "/preseed/1", key: "/preseed/1" });
    const audit = JSON.stringify({
      ts: new Date().toISOString(),
      ns: "alpha",
      table: "memories",
      op: "insert",
      principal: null,
      outcome: "accepted",
      seq: 1,
      key: { id: "/preseed/1" },
    });
    fs.mkdirSync(path.join(nsPath, "concept/2026-09"), { recursive: true });
    fs.mkdirSync(path.join(nsPath, "_audit"), { recursive: true });
    fs.writeFileSync(
      path.join(nsPath, "concept/2026-09/current.jsonl"),
      record + "\n",
    );
    fs.writeFileSync(path.join(nsPath, "_audit/current.jsonl"), audit + "\n");

    const seamPath = path.join(root, "seam");
    const goPath = path.join(root, "go");
    const writer = new NamespaceWriter("alpha", {
      namespacesPath: root,
      autoFlush: false,
      // Hold the namespace write lock across the parent's commit attempt:
      // the seam runs after acquireNamespaceWriteLock succeeded and before
      // any data/audit append (the established acceptance-test seam).
      afterLockAcquired: async () => {
        fs.writeFileSync(seamPath, "seam");
        await waitFor(() => fs.existsSync(goPath), 10_000, "go signal");
      },
      // The flush's own commit scheduling routes through the REAL commit path
      // under test (production wiring: default is commitNamespace).
      scheduleCommit: (p) => {
        void commitNamespaceWithParams(p, "chore: flush commit", flushParams);
      },
    });

    const pending = writer.enqueue(input(memory(1)));
    const flushPromise = writer.flush(); // NOT awaited: it suspends at the seam

    await waitFor(() => fs.existsSync(seamPath), 5_000, "seam");
    // Belt and braces: the lock the flush holds is the SAME file the commit
    // path must fence on.
    expect(fs.existsSync(namespaceWriteLockPath(root, "alpha"))).toBe(true);

    // The commit under test attempts to run WHILE the lock is held.
    await commitNamespaceWithParams(
      nsPath,
      "chore: DF-0925-02 mid-flush commit attempt",
      flushParams,
    );
    await waitForNamespaceCommit(nsPath);

    const midLockCommits = commitCount(nsPath);
    // THE REGRESSION: pre-fix the commit path staged and committed unfenced
    // while the flush held the lock (incident signature: a commit snapshot
    // taken mid-flush can contain data rows whose audit is still unstaged).
    // Post-fix the commit defers (busy lock) and nothing lands mid-flush.
    expect(midLockCommits).toBe(0);

    // Release the flush; its own commit must carry the complete pair.
    fs.writeFileSync(goPath, "go");
    expect(await pending).toMatchObject({ ok: true, seq: 1 });
    await flushPromise;
    await waitForNamespaceCommit(nsPath);
    await drainAsyncCommits();

    const census = pairCensus(nsPath);
    expect(census.commits).toBeGreaterThanOrEqual(1);
    expect(census.unpairedData).toEqual([]);
    // The flush's data row and its accepted change record both committed.
    const headTree = showFile(
      nsPath,
      commitShas(nsPath).at(-1) as string,
      "concept/2026-09/current.jsonl",
    );
    expect(headTree).toContain("/df092502/1");
  });

  it("exit-path flush skips (and does not throw) while the lock is busy, commits once it is free", async () => {
    const root = makeRoot();
    const nsPath = path.join(root, "alpha");
    fs.mkdirSync(nsPath, { recursive: true });
    initGitRepo(nsPath);

    fs.mkdirSync(path.join(nsPath, "concept/2026-09"), { recursive: true });
    fs.mkdirSync(path.join(nsPath, "_audit"), { recursive: true });
    fs.writeFileSync(
      path.join(nsPath, "concept/2026-09/current.jsonl"),
      JSON.stringify({ id: "/exit/1", key: "/exit/1" }) + "\n",
    );
    fs.writeFileSync(
      path.join(nsPath, "_audit/current.jsonl"),
      JSON.stringify({
        ts: new Date().toISOString(),
        ns: "alpha",
        table: "memories",
        op: "insert",
        principal: null,
        outcome: "accepted",
        seq: 1,
        key: { id: "/exit/1" },
      }) + "\n",
    );

    // Open a debounce window, then occupy the lock the way a concurrent
    // flush/DDL would.
    await commitNamespaceWithParams(nsPath, "chore: exit-path window", {
      maxLines: 100,
      maxSeconds: 60,
      enabled: true,
    });
    const lock = acquireNamespaceWriteLock(root, "alpha");
    expect(lock).not.toBeNull();
    try {
      // Must not throw and must not commit (an exit handler always returns).
      // The busy skip consumes this debounce window (documented best-effort
      // behavior — the next write's sweep covers the remainder).
      expect(() => flushNamespaceCommit(nsPath)).not.toThrow();
      expect(commitCount(nsPath)).toBe(0);
    } finally {
      releaseNamespaceWriteLock(lock);
    }

    // Lock released: a fresh window + exit-path flush lands the (paired)
    // commit.
    await commitNamespaceWithParams(nsPath, "chore: exit-path window", {
      maxLines: 100,
      maxSeconds: 60,
      enabled: true,
    });
    expect(() => flushNamespaceCommit(nsPath)).not.toThrow();
    expect(commitCount(nsPath)).toBe(1);
    const census = pairCensus(nsPath);
    expect(census.unpairedData).toEqual([]);
  });
});

// ── 2. AC-1 burst battery ────────────────────────────────────────────────────

describe("DF-0925-02 AC-1 burst pairing", () => {
  it("30 writes at 25 writes/s: every commit's audit delta covers its data delta", async () => {
    const root = makeRoot();
    const nsPath = path.join(root, "alpha");
    fs.mkdirSync(nsPath, { recursive: true });
    initGitRepo(nsPath);

    // Line cap 10: the 30-write burst produces multiple commit flushes, so
    // the invariant is checked across several commits, not one.
    const writer = new NamespaceWriter("alpha", {
      namespacesPath: root,
      scheduleCommit: (p) => {
        void commitNamespaceWithParams(p, "chore: burst commit", {
          maxLines: 10,
          maxSeconds: 60,
          enabled: true,
        });
      },
    });

    const pending: Promise<unknown>[] = [];
    for (let i = 1; i <= 30; i += 1) {
      pending.push(writer.enqueue(input(memory(i))));
      await new Promise((resolve) => setTimeout(resolve, 40)); // 25 writes/s
    }
    const results = await Promise.all(pending);
    expect(results).toHaveLength(30);
    expect(results.every((row) => (row as { ok: boolean }).ok)).toBe(true);

    // Flush the trailing debounce window and drain every commit chain.
    await waitForNamespaceCommit(nsPath);
    await drainAsyncCommits();

    const census = pairCensus(nsPath);
    // Multiple commits prove the burst crossed several commit boundaries.
    expect(census.commits).toBeGreaterThanOrEqual(3);
    expect(census.totalDataIds).toBe(30);
    expect(census.totalAuditIds).toBe(30);
    expect(census.unpairedData).toEqual([]);
  });
});
