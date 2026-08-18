/**
 * RETR-004 Regression Tests: memory-as-of via the MCP recall tool.
 *
 * Guards src/mcp/tools/recall.ts end-to-end against a REAL git-backed
 * namespace (per-namespace repo under the DUCKBRAIN_NAMESPACES_PATH temp
 * root — the same layout the daemon auto-committer maintains):
 *   - ACCEPTANCE: create memory → commit → create memory → commit;
 *     recall as_of=<first commit> returns EXACTLY the first row, while
 *     current-state recall returns both
 *   - date resolution (nearest commit at-or-before) through the tool
 *   - invalid refs surface as a clean error payload (no throw)
 *   - as_of cannot be combined with query/contains
 *   - limit=0 count-only, empty manifest at ref, no-git namespace
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { recallTool } from "./recall";

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const NS = path.join(NS_ROOT, "recall-retr004");
const PARTITION = path.join(NS, "concept", "2026-07");
const JSONL = path.join(PARTITION, "current.jsonl");
const MANIFEST = path.join(NS, "manifest.json");

const D1 = "2026-07-01T10:00:00Z";
const D2 = "2026-08-01T10:00:00Z";

function git(dir: string, args: string, env?: Record<string, string>): string {
  return execSync(`git ${args}`, {
    cwd: dir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  })
    .toString()
    .trim();
}

function commitAll(msg: string, date: string): string {
  git(NS, "add -A");
  git(NS, `commit -qm "${msg}"`, {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return git(NS, "rev-parse HEAD");
}

function mem(id: string, key: string, timestamp: string, text: string): string {
  return JSON.stringify({
    id,
    key,
    domain: "concept",
    timestamp,
    author: "test@example.com",
    action: "add",
    embedding_text: text,
    attributes: {},
  });
}

let sha1: string;
let sha2: string;

beforeAll(() => {
  fs.mkdirSync(PARTITION, { recursive: true });
  git(NS, "init -q");
  git(NS, 'config user.email "test@example.com"');
  git(NS, 'config user.name "Test"');

  // Commit 1: the first memory.
  fs.writeFileSync(
    JSONL,
    mem(
      "asof-1",
      "/asof/first",
      "2026-07-01T08:00:00.000Z",
      "the first memory",
    ) + "\n",
  );
  fs.writeFileSync(
    MANIFEST,
    JSON.stringify({
      partitions: ["concept/2026-07"],
      lastUpdated: new Date().toISOString(),
    }),
  );
  sha1 = commitAll("first memory", D1);

  // Commit 2: the second memory (appended to the same partition chunk).
  fs.writeFileSync(
    JSONL,
    mem(
      "asof-1",
      "/asof/first",
      "2026-07-01T08:00:00.000Z",
      "the first memory",
    ) +
      "\n" +
      mem(
        "asof-2",
        "/asof/second",
        "2026-07-20T08:00:00.000Z",
        "the second memory",
      ) +
      "\n",
  );
  sha2 = commitAll("second memory", D2);
});

afterAll(() => {
  fs.rmSync(NS, { recursive: true, force: true });
});

describe("RETR-004: memory-as-of — MCP recall tool", () => {
  it("ACCEPTANCE: as_of=<first commit> returns exactly the first row; current recall returns both", async () => {
    const atFirst = await recallTool({
      asOf: sha1,
      namespace: "recall-retr004",
      limit: 50,
    });
    expect(atFirst.error).toBeUndefined();
    expect(atFirst.count).toBe(1);
    expect(atFirst.total).toBe(1);
    expect(atFirst.memories.map((m) => m.id)).toEqual(["asof-1"]);
    expect(atFirst.memories[0].embedding_text).toBe("the first memory");

    const now = await recallTool({
      namespace: "recall-retr004",
      limit: 50,
    });
    expect(now.error).toBeUndefined();
    expect(now.total).toBe(2);
    expect(now.memories.map((m) => m.id).sort()).toEqual(["asof-1", "asof-2"]);
  });

  it("resolves a date to the nearest commit at-or-before it", async () => {
    const mid = await recallTool({
      asOf: "2026-07-15",
      namespace: "recall-retr004",
      limit: 50,
    });
    expect(mid.error).toBeUndefined();
    expect(mid.total).toBe(1);
    expect(mid.memories[0].id).toBe("asof-1");

    const afterBoth = await recallTool({
      asOf: "2026-09-01",
      namespace: "recall-retr004",
      limit: 50,
    });
    expect(afterBoth.total).toBe(2);
  });

  it("accepts a direct commit ref (short hash)", async () => {
    const result = await recallTool({
      asOf: sha2.slice(0, 8),
      namespace: "recall-retr004",
      limit: 50,
    });
    expect(result.error).toBeUndefined();
    expect(result.total).toBe(2);
  });

  it("returns a clean error payload for an invalid ref, not a crash", async () => {
    const result = await recallTool({
      asOf: "not-a-ref",
      namespace: "recall-retr004",
    });
    expect(result.memories).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.error).toMatch(/Invalid as-of value/);
  });

  it("rejects as_of combined with query or contains", async () => {
    const withQuery = await recallTool({
      asOf: sha1,
      query: "first",
      namespace: "recall-retr004",
    });
    expect(withQuery.error).toMatch(/as_of cannot be combined/);

    const withContains = await recallTool({
      asOf: sha1,
      contains: "first",
      namespace: "recall-retr004",
    });
    expect(withContains.error).toMatch(/as_of cannot be combined/);
  });

  it("reports a clean error for a namespace with no git history", async () => {
    const plain = path.join(NS_ROOT, "recall-retr004-nogit");
    fs.mkdirSync(plain, { recursive: true });
    try {
      const result = await recallTool({
        asOf: "HEAD",
        namespace: "recall-retr004-nogit",
      });
      expect(result.memories).toEqual([]);
      expect(result.error).toMatch(/not a git repository/);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it("limit=0 returns a count-only result", async () => {
    const result = await recallTool({
      asOf: sha2,
      namespace: "recall-retr004",
      limit: 0,
    });
    expect(result.memories).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.total).toBe(2);
  });

  it("returns empty for a ref whose manifest lists no partitions", async () => {
    const emptyNs = path.join(NS_ROOT, "recall-retr004-empty");
    fs.mkdirSync(emptyNs, { recursive: true });
    try {
      git(emptyNs, "init -q");
      git(emptyNs, 'config user.email "test@example.com"');
      git(emptyNs, 'config user.name "Test"');
      fs.writeFileSync(
        path.join(emptyNs, "manifest.json"),
        JSON.stringify({
          partitions: [],
          lastUpdated: new Date().toISOString(),
        }),
      );
      const sha = commitIn(emptyNs, "empty ns", D1);

      const result = await recallTool({
        asOf: sha,
        namespace: "recall-retr004-empty",
        limit: 50,
      });
      expect(result.error).toBeUndefined();
      expect(result.memories).toEqual([]);
      expect(result.total).toBe(0);
    } finally {
      fs.rmSync(emptyNs, { recursive: true, force: true });
    }
  });

  it("reports a clean error when the namespace had no manifest at the ref", async () => {
    // A repo whose first commit has no manifest.json: the namespace did not
    // exist at that point in history.
    const noManifestNs = path.join(NS_ROOT, "recall-retr004-nomanifest");
    fs.mkdirSync(noManifestNs, { recursive: true });
    try {
      git(noManifestNs, "init -q");
      git(noManifestNs, 'config user.email "test@example.com"');
      git(noManifestNs, 'config user.name "Test"');
      fs.writeFileSync(path.join(noManifestNs, ".gitkeep"), "", "utf-8");
      const sha = commitIn(noManifestNs, "no manifest", D1);

      const result = await recallTool({
        asOf: sha,
        namespace: "recall-retr004-nomanifest",
        limit: 50,
      });
      expect(result.memories).toEqual([]);
      expect(result.error).toMatch(/has no manifest at ref/);
    } finally {
      fs.rmSync(noManifestNs, { recursive: true, force: true });
    }
  });
});

/** Commit in an arbitrary namespace dir (helper for ad-hoc fixtures). */
function commitIn(dir: string, msg: string, date: string): string {
  git(dir, "add -A");
  git(dir, `commit -qm "${msg}"`, {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return git(dir, "rev-parse HEAD");
}
