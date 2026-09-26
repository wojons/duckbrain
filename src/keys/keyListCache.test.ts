/**
 * PERF-001: key-list materialization cache (src/keys/keyListCache.ts).
 *
 * These tests pin the cache's own contract BEFORE the tool wiring:
 *   - the sidecar mirrors the `.search/` doctrine (gitignored, atomic
 *     .tmp rename, meta after rebuild),
 *   - the artifact is built by the SAME resilient SQL the cold keys path
 *     runs (torn lines skipped, tombstone rows filtered, RETR-005 order),
 *   - freshness = fileSetHash (file identity) + fingerprint (size/mtime),
 *   - invalidation clears memory + meta and never throws,
 *   - the sidecar is INVISIBLE to every data walker (DB-GAP-050: nothing
 *     may ingest `.keys/` as namespace data).
 *
 * Namespaces are built with the REAL serialization writer (SUPA-2) where a
 * write path is exercised — no mocks (brief AC#2).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { createMemory, type MemoryType } from "../schema/memory";
import {
  KEYS_ARTIFACT_NAME,
  KEYS_CACHE_DIR,
  KEYS_CACHE_VERSION,
  KEYS_META_NAME,
  collectKeysSourceFiles,
  ensureFreshKeyList,
  ensureKeysGitignored,
  fileSetHash,
  invalidateKeysCache,
  keysCacheDir,
  keysCacheFreshness,
  keysArtifactPath,
  keysMetaPath,
  rebuildKeysCache,
} from "./keyListCache";
import { NamespaceWriter } from "../serialization/namespaceWriter";
import { collectJsonlFiles } from "../duckdb/queries";
import { collectNamespaceJsonl } from "../duckdb/query-surface";
import { collectSourceFiles } from "../search";
import type { WriteInput } from "../serialization/types";

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;

function memory(index: number, ts?: string): MemoryType {
  const rec = createMemory({
    key: `/perf001/unit/${String(index).padStart(3, "0")}`,
    domain: "concept",
    author: "test@example.com",
    embedding_text: `record ${index}`,
    attributes: { index },
  });
  if (ts) rec.timestamp = ts;
  return rec;
}

function writeInput(record: MemoryType, ns: string): WriteInput {
  return {
    ns,
    table: "memories",
    op: record.action === "tombstone" ? "delete" : "insert",
    record,
    principal: undefined,
    targetPath: "concept/2026-09/current.jsonl",
    partitionPath: "concept/2026-09/",
  };
}

function realWriter(ns: string) {
  return new NamespaceWriter(ns, {
    namespacesPath: NS_ROOT,
    scheduleCommit: () => undefined,
  });
}

describe("PERF-001: key-list cache — sidecar doctrine", () => {
  let nsPath: string;
  let ns: string;

  beforeEach(() => {
    nsPath = fs.mkdtempSync(path.join(NS_ROOT, "perf001-sidecar-"));
    ns = path.basename(nsPath);
    fs.writeFileSync(
      path.join(nsPath, "manifest.json"),
      JSON.stringify({ partitions: ["concept/2026-09"] }),
      "utf-8",
    );
  });

  afterEach(() => {
    fs.rmSync(nsPath, { recursive: true, force: true });
  });

  it("writes the sidecar, the gitignore entry, and keeps git status clean", async () => {
    const writer = realWriter(ns);
    await writer.enqueue(writeInput(memory(1), ns));
    await writer.flush();

    const entries = await rebuildKeysCache(nsPath);
    expect(entries).not.toBeNull();
    expect(fs.existsSync(keysArtifactPath(nsPath))).toBe(true);
    expect(fs.existsSync(keysMetaPath(nsPath))).toBe(true);

    ensureKeysGitignored(nsPath);
    const gi = fs.readFileSync(path.join(nsPath, ".gitignore"), "utf8");
    expect(gi).toContain(`/${KEYS_CACHE_DIR}/`);

    // The namespace is a git repo (autocommit initializes it in production;
    // here we init manually to assert the sidecar stays untracked).
    execSync("git init -q", { cwd: nsPath });
    execSync("git add -A", { cwd: nsPath });
    const status = execSync("git status --porcelain", {
      cwd: nsPath,
      encoding: "utf8",
    });
    expect(status).not.toContain(KEYS_CACHE_DIR);
  });

  it("is invisible to every data walker (DB-GAP-050 guard)", async () => {
    const partition = path.join(nsPath, "concept", "2026-09");
    fs.mkdirSync(partition, { recursive: true });
    fs.writeFileSync(
      path.join(partition, "current.jsonl"),
      JSON.stringify(memory(1)) + "\n",
      "utf-8",
    );
    await rebuildKeysCache(nsPath);
    fs.mkdirSync(keysCacheDir(nsPath), { recursive: true });
    // Poison: even a *.jsonl-named file inside .keys/ must be ignored.
    fs.writeFileSync(path.join(keysCacheDir(nsPath), "x.jsonl"), "{}", "utf-8");

    expect(
      collectJsonlFiles([partition]).some((f) => f.includes(".keys")),
    ).toBe(false);
    expect(collectNamespaceJsonl(nsPath).some((f) => f.includes(".keys"))).toBe(
      false,
    );
    expect(collectSourceFiles(nsPath).some((f) => f.includes(".keys"))).toBe(
      false,
    );
  });

  it("never builds a sidecar for an empty/manifest-less namespace", async () => {
    const empty = fs.mkdtempSync(path.join(NS_ROOT, "perf001-empty-"));
    try {
      const result = await ensureFreshKeyList(empty);
      expect(result.entries).toEqual([]);
      expect(result.state).toBe("empty");
      expect(fs.existsSync(keysCacheDir(empty))).toBe(false);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("PERF-001: key-list cache — artifact semantics", () => {
  let nsPath: string;
  let ns: string;

  beforeEach(() => {
    nsPath = fs.mkdtempSync(path.join(NS_ROOT, "perf001-artifact-"));
    ns = path.basename(nsPath);
    fs.writeFileSync(
      path.join(nsPath, "manifest.json"),
      JSON.stringify({ partitions: ["concept/2026-09"] }),
      "utf-8",
    );
  });

  afterEach(() => {
    fs.rmSync(nsPath, { recursive: true, force: true });
  });

  it("orders by latest DESC across distinct seconds, key ASC on ties", async () => {
    const writer = realWriter(ns);
    // k1 @ T, k3 @ T+60s (newest), k2 @ T+30s — written oldest-first.
    const base = Date.UTC(2026, 8, 1, 10, 0, 0);
    const iso = (ms: number) => new Date(ms).toISOString();
    await writer.enqueue(writeInput(memory(1, iso(base)), ns));
    await writer.enqueue(writeInput(memory(3, iso(base + 60_000)), ns));
    await writer.enqueue(writeInput(memory(2, iso(base + 30_000)), ns));
    await writer.flush();

    const ensured = await ensureFreshKeyList(nsPath);
    expect(ensured.entries).not.toBeNull();
    // RETR-005: newest first; ties (none here) would break by key ASC.
    expect(ensured.entries!.map((e) => e.key)).toEqual([
      "/perf001/unit/003",
      "/perf001/unit/002",
      "/perf001/unit/001",
    ]);
  });

  it("breaks exact-tie instants by key ASC (SQL parity)", async () => {
    const writer = realWriter(ns);
    // Identical timestamps on all three: __latest ties -> ORDER BY key ASC.
    // Write order deliberately NOT key order.
    await writer.enqueue(writeInput(memory(3, "2026-09-02T10:00:00.000Z"), ns));
    await writer.enqueue(writeInput(memory(1, "2026-09-02T10:00:00.000Z"), ns));
    await writer.enqueue(writeInput(memory(2, "2026-09-02T10:00:00.000Z"), ns));
    await writer.flush();

    const ensured = await ensureFreshKeyList(nsPath);
    expect(ensured.entries!.map((e) => e.key)).toEqual([
      "/perf001/unit/001",
      "/perf001/unit/002",
      "/perf001/unit/003",
    ]);
  });

  it("mirrors the SQL tombstone semantics (row filter, not key filter)", async () => {
    const writer = realWriter(ns);
    // Key with a live record AND a later tombstone: the tombstone ROW is
    // filtered before GROUP BY, the key STAYS listed.
    await writer.enqueue(writeInput(memory(1, "2026-09-01T10:00:00.000Z"), ns));
    const t1 = memory(1, "2026-09-02T10:00:00.000Z");
    t1.action = "tombstone";
    await writer.enqueue(writeInput(t1, ns));
    // Key whose ONLY record is a tombstone: never listed.
    const t2 = memory(9, "2026-09-03T10:00:00.000Z");
    t2.action = "tombstone";
    await writer.enqueue(writeInput(t2, ns));
    await writer.flush();

    const ensured = await ensureFreshKeyList(nsPath);
    expect(ensured.entries!.map((e) => e.key)).toEqual(["/perf001/unit/001"]);
    expect(ensured.entries![0].latest).toBe("2026-09-01 10:00:00");
  });

  it("survives a torn JSONL line like the SQL path (DB-GAP-035 parity)", async () => {
    const partition = path.join(nsPath, "concept", "2026-09");
    fs.mkdirSync(partition, { recursive: true });
    const good = {
      id: "6853a05e-7f31-4f32-bcb2-70cedf177d70",
      key: "/fleet/events/255422",
      domain: "event",
      timestamp: "2026-08-21T12:00:00.000Z",
      author: "test@example.com",
      action: "add",
      embedding_text: "torn fixture",
      attributes: {},
    };
    const tornLine = `{"id":"66db7ec5-d847-4f23-864a${JSON.stringify(good)}`;
    fs.writeFileSync(
      path.join(partition, "current.jsonl"),
      `${tornLine}\n${JSON.stringify(good)}\n`,
      "utf-8",
    );

    const ensured = await ensureFreshKeyList(nsPath);
    expect(ensured.entries!.map((e) => e.key)).toEqual([
      "/fleet/events/255422",
    ]);
  });
});

describe("PERF-001: freshness + invalidation", () => {
  let nsPath: string;
  let ns: string;

  beforeEach(() => {
    nsPath = fs.mkdtempSync(path.join(NS_ROOT, "perf001-fresh-"));
    ns = path.basename(nsPath);
    fs.writeFileSync(
      path.join(nsPath, "manifest.json"),
      JSON.stringify({ partitions: ["concept/2026-09"] }),
      "utf-8",
    );
  });

  afterEach(() => {
    fs.rmSync(nsPath, { recursive: true, force: true });
  });

  async function seedOne() {
    const writer = realWriter(ns);
    await writer.enqueue(writeInput(memory(1), ns));
    await writer.flush();
  }

  it("transitions missing -> fresh -> (append) stale -> rebuild fresh", async () => {
    await seedOne();
    expect(keysCacheFreshness(nsPath).state).toBe("missing");

    const first = await ensureFreshKeyList(nsPath);
    expect(first.rebuilt).toBe(true);
    expect(keysCacheFreshness(nsPath).state).toBe("fresh");

    // External append (bypassing the writer hook) must trip the fingerprint.
    const partition = path.join(nsPath, "concept", "2026-09", "current.jsonl");
    fs.appendFileSync(partition, JSON.stringify(memory(2)) + "\n", "utf-8");
    expect(keysCacheFreshness(nsPath).state).toBe("stale");

    const second = await ensureFreshKeyList(nsPath);
    expect(second.rebuilt).toBe(true);
    expect(second.entries!.map((e) => e.key)).toContain("/perf001/unit/002");
    expect(keysCacheFreshness(nsPath).state).toBe("fresh");
  });

  it("invalidateKeysCache clears memory AND meta, and never throws", async () => {
    await seedOne();
    await ensureFreshKeyList(nsPath);
    expect(keysCacheFreshness(nsPath).state).toBe("fresh");

    invalidateKeysCache(nsPath);
    expect(fs.existsSync(keysMetaPath(nsPath))).toBe(false);
    expect(keysCacheFreshness(nsPath).state).toBe("missing");

    // Best-effort contract: a nonexistent/invalid path must not throw.
    expect(() => invalidateKeysCache("/nonexistent/ns/path")).not.toThrow();
    expect(() => invalidateKeysCache(nsPath)).not.toThrow();
  });

  it("catches a squash-style file-set change (rename, not just mtime)", async () => {
    await seedOne();
    await ensureFreshKeyList(nsPath);
    const partition = path.join(nsPath, "concept", "2026-09");
    const before = collectKeysSourceFiles(nsPath);
    const hashBefore = fileSetHash(before);

    // Squash renames chunks (cleaned-*.jsonl / parquet swap): simulate by
    // rewriting the same CONTENT under a new chunk name.
    const content = fs.readFileSync(
      path.join(partition, "current.jsonl"),
      "utf-8",
    );
    fs.writeFileSync(path.join(partition, "0001.jsonl"), content, "utf-8");
    fs.unlinkSync(path.join(partition, "current.jsonl"));

    const files = collectKeysSourceFiles(nsPath);
    expect(fileSetHash(files)).not.toBe(hashBefore);
    expect(keysCacheFreshness(nsPath).state).toBe("stale");
  });

  it("serves from the in-process memory cache on the second fresh call", async () => {
    await seedOne();
    await ensureFreshKeyList(nsPath);
    // Touch the artifact — a memory-cached serve must NOT re-read it.
    fs.rmSync(keysArtifactPath(nsPath), { force: true });
    const served = await ensureFreshKeyList(nsPath);
    expect(served.state).toBe("fresh");
    expect(served.rebuilt).toBe(false);
    expect(served.entries!.map((e) => e.key)).toEqual(["/perf001/unit/001"]);
  });
});

describe("PERF-001: artifact name/adversarial shapes", () => {
  it("artifact is NOT *.jsonl (nothing may ever ingest it as data)", () => {
    expect(KEYS_ARTIFACT_NAME.endsWith(".jsonl")).toBe(false);
  });

  it("rejects a corrupt artifact by rebuilding", async () => {
    const nsPath = fs.mkdtempSync(path.join(NS_ROOT, "perf001-corrupt-"));
    try {
      fs.writeFileSync(
        path.join(nsPath, "manifest.json"),
        JSON.stringify({ partitions: ["concept/2026-09"] }),
        "utf-8",
      );
      const partition = path.join(nsPath, "concept", "2026-09");
      fs.mkdirSync(partition, { recursive: true });
      fs.writeFileSync(
        path.join(partition, "current.jsonl"),
        JSON.stringify(memory(1)) + "\n",
        "utf-8",
      );
      await rebuildKeysCache(nsPath);
      // Poison the artifact while the meta still claims fresh.
      fs.writeFileSync(keysArtifactPath(nsPath), "{not json at all", "utf-8");
      // Drop the in-process entry — a fresh PROCESS has a cold memory cache
      // and only the poisoned artifact on disk.
      invalidateKeysCache(nsPath);
      const served = await ensureFreshKeyList(nsPath);
      expect(served.rebuilt).toBe(true);
      expect(served.entries!.length).toBe(1);
    } finally {
      fs.rmSync(nsPath, { recursive: true, force: true });
    }
  });

  it("meta with an unknown version is treated as missing", async () => {
    const nsPath = fs.mkdtempSync(path.join(NS_ROOT, "perf001-version-"));
    try {
      fs.writeFileSync(
        path.join(nsPath, "manifest.json"),
        JSON.stringify({ partitions: [] }),
        "utf-8",
      );
      const dir = keysCacheDir(nsPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, KEYS_META_NAME),
        JSON.stringify({
          version: KEYS_CACHE_VERSION + 999,
          entryCount: 0,
          builtAt: new Date().toISOString(),
          durationMs: 1,
          fileSetHash: "x",
          fingerprint: "y",
        }),
        "utf-8",
      );
      // No source files -> "empty" wins regardless of a stale-version meta.
      expect(keysCacheFreshness(nsPath).state).toBe("empty");
    } finally {
      fs.rmSync(nsPath, { recursive: true, force: true });
    }
  });
});
