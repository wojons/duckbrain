/**
 * RETR-006 Regression Tests: attribute filters via the MCP recall tool.
 *
 * Guards src/mcp/tools/recall.ts end-to-end against a real seeded namespace
 * (same pattern as recall-timerange-retr003.test.ts):
 *   - attr on the list path returns ONLY rows whose attributes match,
 *     with a matching total
 *   - attr ANDs with keyPrefix/domain (intersection semantics)
 *   - attr + contains (keyword path, real rebuilt FTS sidecar) intersects
 *   - attr + as-of (real git-backed namespace) intersects — the in-memory
 *     mirror in src/git/asof.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { recallTool } from "./recall";
import { rebuildNamespaceIndex } from "../../search/index";

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const NS = path.join(NS_ROOT, "recall-retr006");
const PARTITION = path.join(NS, "config", "2026-08");
const JSONL = path.join(PARTITION, "current.jsonl");
const MANIFEST = path.join(NS, "manifest.json");

function mem(
  id: string,
  key: string,
  text: string,
  attributes: Record<string, unknown>,
  domain: string = "config",
): string {
  return JSON.stringify({
    id,
    key,
    domain,
    timestamp: "2026-08-01T00:00:00.000Z",
    author: "test@example.com",
    action: "add",
    embedding_text: text,
    attributes,
  });
}

const ROWS = [
  mem("x1", "/attr/config/one", "alpha config", {
    domain: "config",
    tick: 403,
    note: "plain",
  }),
  mem("x2", "/attr/config/two", "beta config", {
    domain: "config",
    tick: 402,
  }),
  mem(
    "x3",
    "/attr/msg/one",
    "alpha message",
    { domain: "message", tick: 403 },
    "message",
  ),
  mem("x4", "/attr/noattr", "gamma", { env: "prod" }),
];

beforeAll(() => {
  fs.mkdirSync(PARTITION, { recursive: true });
  fs.writeFileSync(JSONL, ROWS.join("\n") + "\n");
  fs.writeFileSync(
    MANIFEST,
    JSON.stringify({
      partitions: ["config/2026-08"],
      lastUpdated: new Date().toISOString(),
    }),
  );
});

afterAll(() => {
  fs.rmSync(NS, { recursive: true, force: true });
});

describe("RETR-006: attribute filters — MCP recall tool (list path)", () => {
  it("attr.domain=config returns only matching rows with a matching total", async () => {
    const result = await recallTool({
      namespace: "recall-retr006",
      attr: { domain: "config" },
      limit: 50,
    });

    expect(result.error).toBeUndefined();
    const ids = result.memories.map((m) => m.id).sort();
    expect(ids).toEqual(["x1", "x2"]);
    expect(result.total).toBe(2);
  });

  it("attr.tick=403 matches numeric values and ANDs multiple pairs", async () => {
    const result = await recallTool({
      namespace: "recall-retr006",
      attr: { domain: "config", tick: "403" },
      limit: 50,
    });

    expect(result.error).toBeUndefined();
    expect(result.memories.map((m) => m.id)).toEqual(["x1"]);
    expect(result.total).toBe(1);
  });

  it("combines with keyPrefix and domain — intersection semantics", async () => {
    const byPrefix = await recallTool({
      namespace: "recall-retr006",
      keyPrefix: "/attr/config/",
      attr: { tick: "403" },
      limit: 50,
    });
    expect(byPrefix.error).toBeUndefined();
    expect(byPrefix.memories.map((m) => m.id)).toEqual(["x1"]);
    expect(byPrefix.total).toBe(1);

    const byDomain = await recallTool({
      namespace: "recall-retr006",
      domain: "config",
      attr: { domain: "config" },
      limit: 50,
    });
    expect(byDomain.error).toBeUndefined();
    expect(byDomain.memories.map((m) => m.id).sort()).toEqual(["x1", "x2"]);
    expect(byDomain.total).toBe(2);
  });

  it("a missing attribute key matches nothing", async () => {
    const result = await recallTool({
      namespace: "recall-retr006",
      attr: { env: "staging" },
      limit: 50,
    });
    expect(result.error).toBeUndefined();
    expect(result.memories).toEqual([]);
    expect(result.total).toBe(0);
  });
});

describe("RETR-006: attribute filters — keyword (contains=) path", () => {
  beforeAll(async () => {
    await rebuildNamespaceIndex(NS);
  });

  it("attr intersects with contains= (real FTS sidecar)", async () => {
    const result = await recallTool({
      contains: "alpha",
      namespace: "recall-retr006",
      attr: { domain: "config" },
      limit: 50,
    });

    expect(result.error).toBeUndefined();
    // x1 matches "alpha" AND domain=config; x3 matches "alpha" but its
    // attributes are {domain: "message"} — excluded by the attr condition.
    const ids = result.memories.map((m) => m.id).sort();
    expect(ids).toEqual(["x1"]);
    expect(result.total).toBe(1);
  });

  it("keeps unfiltered keyword results unchanged", async () => {
    const result = await recallTool({
      contains: "alpha",
      namespace: "recall-retr006",
      limit: 50,
    });

    expect(result.error).toBeUndefined();
    const ids = result.memories.map((m) => m.id).sort();
    expect(ids).toEqual(["x1", "x3"]);
  });
});

describe("RETR-006: attribute filters — as-of path (git namespace)", () => {
  const ASOF_NS = path.join(NS_ROOT, "recall-retr006-asof");
  const ASOF_PARTITION = path.join(ASOF_NS, "config", "2026-07");
  const ASOF_JSONL = path.join(ASOF_PARTITION, "current.jsonl");
  const ASOF_MANIFEST = path.join(ASOF_NS, "manifest.json");

  function git(
    dir: string,
    args: string,
    env?: Record<string, string>,
  ): string {
    return execSync(`git ${args}`, {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    })
      .toString()
      .trim();
  }

  let sha1: string;

  beforeAll(() => {
    fs.mkdirSync(ASOF_PARTITION, { recursive: true });
    git(ASOF_NS, "init -q");
    git(ASOF_NS, 'config user.email "test@example.com"');
    git(ASOF_NS, 'config user.name "Test"');

    // Commit 1: one config row + one message row.
    fs.writeFileSync(
      ASOF_JSONL,
      mem("as1", "/asof/config", "cfg row", { domain: "config" }) +
        "\n" +
        mem("as2", "/asof/msg", "msg row", { domain: "message" }, "message") +
        "\n",
    );
    fs.writeFileSync(
      ASOF_MANIFEST,
      JSON.stringify({
        partitions: ["config/2026-07"],
        lastUpdated: new Date().toISOString(),
      }),
    );
    git(ASOF_NS, "add -A");
    git(ASOF_NS, 'commit -qm "first"', {
      GIT_AUTHOR_DATE: "2026-07-01T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-07-01T10:00:00Z",
    });
    sha1 = git(ASOF_NS, "rev-parse HEAD");

    // Commit 2: adds another config row.
    fs.writeFileSync(
      ASOF_JSONL,
      mem("as1", "/asof/config", "cfg row", { domain: "config" }) +
        "\n" +
        mem("as2", "/asof/msg", "msg row", { domain: "message" }, "message") +
        "\n" +
        mem("as3", "/asof/config2", "cfg row 2", { domain: "config" }) +
        "\n",
    );
    git(ASOF_NS, "add -A");
    git(ASOF_NS, 'commit -qm "second"', {
      GIT_AUTHOR_DATE: "2026-07-02T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-07-02T10:00:00Z",
    });
  });

  afterAll(() => {
    fs.rmSync(ASOF_NS, { recursive: true, force: true });
  });

  it("attr intersects with as_of — only rows matching at that ref", async () => {
    const atFirst = await recallTool({
      namespace: "recall-retr006-asof",
      asOf: sha1,
      attr: { domain: "config" },
      limit: 50,
    });
    expect(atFirst.error).toBeUndefined();
    expect(atFirst.memories.map((m) => m.id).sort()).toEqual(["as1"]);
    expect(atFirst.total).toBe(1);

    const atHead = await recallTool({
      namespace: "recall-retr006-asof",
      asOf: "HEAD",
      attr: { domain: "config" },
      limit: 50,
    });
    expect(atHead.error).toBeUndefined();
    expect(atHead.memories.map((m) => m.id).sort()).toEqual(["as1", "as3"]);
    expect(atHead.total).toBe(2);
  });
});
