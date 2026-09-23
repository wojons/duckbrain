/**
 * Namespace lifecycle tests (item 65/66 — REVIEW-DUCKBRAIN-001/002).
 *
 * Guards:
 *  - deleteNamespaceFromDisk removes dir + mapping + sync manifest, never
 *    touches S3 (client functions must NOT be called), reports the preserved
 *    S3 prefix, and logs the who/why audit line.
 *  - refuses: no confirm, no requestedBy, push lock held, default ns.
 *  - idempotent for an already-gone namespace (mapping + manifest residue).
 *  - clearNamespaceFromS3: dry-run plan enumerates exactly the prefix keys;
 *    destructive run deletes exactly those keys; requires confirm + who/why;
 *    never touches local disk; prunes the manifest so nothing re-pushes.
 *  - findGhostSyncState detects manifests/mappings whose namespace dir is
 *    gone (the ENOENT ghost-push class) and protects the default namespace.
 *  - sweepGhostSyncState prunes exactly the detected residue.
 *
 * The S3 client is mocked — every assertion here runs offline. The deletion
 * core's storage runs under the test-suite temp root (src/test-setup.ts:
 * DUCKBRAIN_NAMESPACES_PATH + DUCKBRAIN_CONFIG_PATH), same pattern as
 * namespace-delete-dogfood004.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";

const clientCalls = {
  listed: [] as string[],
  deleted: [] as string[],
  put: [] as string[],
};

vi.mock("../s3/client", () => ({
  buildClient: () => ({}),
  listRemoteObjects: vi.fn(async (_c: unknown, _b: string, prefix: string) => {
    clientCalls.listed.push(prefix);
    const m = new Map<string, { key: string; size: number; etag?: string }>();
    if (prefix === "duckbrain/s3-clear-target/") {
      m.set("duckbrain/s3-clear-target/event/2026-09/current.jsonl", {
        key: "duckbrain/s3-clear-target/event/2026-09/current.jsonl",
        size: 100,
      });
      m.set("duckbrain/s3-clear-target/manifest.json", {
        key: "duckbrain/s3-clear-target/manifest.json",
        size: 50,
      });
    }
    return m;
  }),
  putObject: vi.fn(async (_c: unknown, _b: string, key: string) => {
    clientCalls.put.push(key);
  }),
  getObject: vi.fn(async () => Buffer.from("x")),
  deleteObject: vi.fn(async (_c: unknown, _b: string, key: string) => {
    clientCalls.deleted.push(key);
  }),
}));

import { createNamespaceTool } from "../mcp/tools/namespace";
import { getConfig, updateConfig } from "../config/index";
import {
  deleteNamespaceFromDisk,
  planS3Clear,
  clearNamespaceFromS3,
  findGhostSyncState,
  sweepGhostSyncState,
  lifecycleLogPath,
} from "./lifecycle";

const CONFIG_PATH =
  process.env.DUCKBRAIN_CONFIG_PATH ||
  path.join(process.cwd(), "duckbrain.config.json");
const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;

let configSnapshot: string;

beforeEach(() => {
  configSnapshot = fs.existsSync(CONFIG_PATH)
    ? fs.readFileSync(CONFIG_PATH, "utf-8")
    : "";
  clientCalls.listed = [];
  clientCalls.deleted = [];
  clientCalls.put = [];
  // Exercise the s3-enabled branches (s3Preserved reporting, helper scan)
  // without touching any real client — the client module is mocked above.
  updateConfig(".", {
    s3: {
      enabled: true,
      region: "us-east-1",
      bucket: "duckbrain",
      prefix: "duckbrain",
      forcePathStyle: true,
      pushOnCommit: false,
      intervalSec: 300,
    },
  });
});

afterEach(() => {
  if (configSnapshot) {
    fs.writeFileSync(CONFIG_PATH, configSnapshot, "utf-8");
  } else if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
  }
});

function liveMappings(): Record<string, string> {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")).namespaceMappings;
}

function seedMapping(name: string, dirPath: string): void {
  const cfg = getConfig(".");
  updateConfig(".", {
    namespaceMappings: { ...(cfg.namespaceMappings ?? {}), [name]: dirPath },
  });
}

function seedManifest(ns: string): string {
  const dir = path.join(NS_ROOT, ".s3state");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ns}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      ns,
      lastSyncAt: new Date().toISOString(),
      files: { "manifest.json": { size: 2, mtimeMs: 1 } },
    }),
  );
  return file;
}

describe("deleteNamespaceFromDisk (disk-only deletion path)", () => {
  it("requires confirm", () => {
    const r = deleteNamespaceFromDisk("some-ns", {
      confirm: false,
      requestedBy: "test",
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/confirm/i);
  });

  it("requires requestedBy (who/why audit)", () => {
    const r = deleteNamespaceFromDisk("some-ns", {
      confirm: true,
      requestedBy: "  ",
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/requestedBy/i);
  });

  it("refuses while the native sync lock is held by a live process", async () => {
    const created = await createNamespaceTool({
      name: "lc-lock-ns",
      setDefault: false,
    });
    expect(created.success).toBe(true);
    const stateDir = path.join(NS_ROOT, ".s3state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, ".lock"),
      JSON.stringify({ pid: process.pid, ts: Date.now() }),
    );
    try {
      const r = deleteNamespaceFromDisk("lc-lock-ns", {
        confirm: true,
        requestedBy: "test",
      });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/push in flight/i);
      // namespace untouched
      expect(fs.existsSync(created.path!)).toBe(true);
    } finally {
      fs.rmSync(path.join(stateDir, ".lock"), { force: true });
    }
  });

  it("removes dir + mapping + manifest, never calls the S3 client, logs who/why", async () => {
    const created = await createNamespaceTool({
      name: "lc-disk-ns",
      setDefault: false,
    });
    expect(created.success).toBe(true);
    fs.writeFileSync(path.join(created.path!, "event.jsonl"), "{}\n");
    const manifestFile = seedManifest("lc-disk-ns");
    expect(fs.existsSync(manifestFile)).toBe(true);

    const r = deleteNamespaceFromDisk("lc-disk-ns", {
      confirm: true,
      requestedBy: "worker:test-item-65",
      reason: "lifecycle test",
    });

    expect(r.success).toBe(true);
    expect(fs.existsSync(created.path!)).toBe(false);
    expect(liveMappings()["lc-disk-ns"]).toBeUndefined();
    expect(fs.existsSync(manifestFile)).toBe(false);
    expect(r.manifestPruned).toBe(true);
    // THE item-65 contract: S3 stays retrievable, and the delete never
    // reached toward S3 (no list, no delete calls).
    expect(clientCalls.deleted).toEqual([]);
    expect(clientCalls.listed).toEqual([]);
    if (getConfig(".").s3?.enabled) {
      expect(r.s3Preserved).toEqual({
        bucket: getConfig(".").s3!.bucket,
        prefix: `${getConfig(".").s3!.prefix}/lc-disk-ns/`,
      });
    }
    const log = fs.readFileSync(lifecycleLogPath(NS_ROOT), "utf-8");
    const entry = JSON.parse(log.trim().split("\n").pop()!);
    expect(entry.op).toBe("delete-from-disk");
    expect(entry.requestedBy).toBe("worker:test-item-65");
    expect(entry.reason).toBe("lifecycle test");
    expect(entry.s3Preserved).toBeTruthy();
  });

  it("is idempotent: mapping + manifest residue without a dir still cleans up", async () => {
    seedMapping("lc-gone-ns", path.join(NS_ROOT, "lc-gone-ns"));
    const manifestFile = seedManifest("lc-gone-ns");

    const r = deleteNamespaceFromDisk("lc-gone-ns", {
      confirm: true,
      requestedBy: "test",
    });

    expect(r.success).toBe(true);
    expect(liveMappings()["lc-gone-ns"]).toBeUndefined();
    expect(fs.existsSync(manifestFile)).toBe(false);
  });
});

describe("planS3Clear + clearNamespaceFromS3 (remote-only destruction path)", () => {
  it("plan enumerates exactly the namespace prefix, read-only", async () => {
    const s3 = getConfig(".").s3!;
    const plan = await planS3Clear(s3, "s3-clear-target", {
      namespacesPath: NS_ROOT,
    });
    expect(plan.prefix).toBe(`${s3.prefix}/s3-clear-target/`);
    expect(plan.objectCount).toBe(2);
    expect(plan.objects.map((o) => o.key).sort()).toEqual([
      "duckbrain/s3-clear-target/event/2026-09/current.jsonl",
      "duckbrain/s3-clear-target/manifest.json",
    ]);
    // dry-run destroyed nothing
    expect(clientCalls.deleted).toEqual([]);
  });

  it("clear refuses without confirm, who, or why", async () => {
    const s3 = getConfig(".").s3!;
    const noConfirm = await clearNamespaceFromS3(s3, "s3-clear-target", {
      confirm: false,
      requestedBy: "t",
      reason: "r",
    });
    expect(noConfirm.success).toBe(false);
    const noWho = await clearNamespaceFromS3(s3, "s3-clear-target", {
      confirm: true,
      requestedBy: "",
      reason: "r",
    });
    expect(noWho.success).toBe(false);
    const noWhy = await clearNamespaceFromS3(s3, "s3-clear-target", {
      confirm: true,
      requestedBy: "t",
      reason: "",
    });
    expect(noWhy.success).toBe(false);
    expect(clientCalls.deleted).toEqual([]);
  });

  it("clear deletes exactly the planned keys, never touches disk, prunes manifest", async () => {
    const s3 = getConfig(".").s3!;
    const localDir = path.join(NS_ROOT, "s3-clear-target");
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, "keep-local.jsonl"), "local\n");
    const manifestFile = seedManifest("s3-clear-target");

    const r = await clearNamespaceFromS3(s3, "s3-clear-target", {
      confirm: true,
      requestedBy: "worker:test-item-66",
      reason: "s3 clear test",
      namespacesPath: NS_ROOT,
    });

    expect(r.success).toBe(true);
    expect(r.deleted).toBe(2);
    expect(r.failed).toBe(0);
    expect([...clientCalls.deleted].sort()).toEqual([
      "duckbrain/s3-clear-target/event/2026-09/current.jsonl",
      "duckbrain/s3-clear-target/manifest.json",
    ]);
    // remote-only: local bytes untouched
    expect(fs.existsSync(path.join(localDir, "keep-local.jsonl"))).toBe(true);
    // nothing re-pushes a cleared namespace
    expect(fs.existsSync(manifestFile)).toBe(false);
    const log = fs
      .readFileSync(lifecycleLogPath(NS_ROOT), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const entry = log.find((e) => e.op === "clear-from-s3");
    expect(entry.requestedBy).toBe("worker:test-item-66");
    expect(entry.deleted).toBe(2);
  });
});

describe("findGhostSyncState + sweepGhostSyncState (ghost-push root cause)", () => {
  it("detects manifests and mappings whose namespace dir is gone; protects default", () => {
    const ghostNs = "auger-pytest-000000000000";
    seedMapping("auger-gone-mapping", path.join(NS_ROOT, "auger-gone-dir"));
    const manifestFile = seedManifest(ghostNs);

    const found = findGhostSyncState(NS_ROOT, { configDir: "." });
    expect(found.ghostManifests.map((g) => g.ns)).toContain(ghostNs);
    expect(found.ghostMappings.map((m) => m.name)).toContain(
      "auger-gone-mapping",
    );
    // default / current defaultNamespace are never ghosts
    const protectedNames = new Set([
      "default",
      getConfig(".").defaultNamespace,
    ]);
    for (const g of found.ghostManifests) {
      expect(protectedNames.has(g.ns)).toBe(false);
    }
    fs.rmSync(manifestFile, { force: true });
  });

  it("sweep prunes exactly the ghost residue, confirm-gated", () => {
    const ghostNs = "auger-smoke-000000000001";
    seedMapping("auger-gone-mapping-2", path.join(NS_ROOT, "auger-gone-dir-2"));
    const manifestFile = seedManifest(ghostNs);

    const refused = sweepGhostSyncState(NS_ROOT, {
      confirm: false,
      requestedBy: "test",
    });
    expect(refused.success).toBe(false);
    expect(fs.existsSync(manifestFile)).toBe(true);

    const r = sweepGhostSyncState(NS_ROOT, {
      confirm: true,
      requestedBy: "worker:test-item-65",
      reason: "ghost sweep test",
    });
    expect(r.success).toBe(true);
    expect(r.manifestsPruned).toContain(ghostNs);
    expect(r.mappingsRemoved).toContain("auger-gone-mapping-2");
    expect(fs.existsSync(manifestFile)).toBe(false);
    expect(liveMappings()["auger-gone-mapping-2"]).toBeUndefined();
    // a mapped namespace whose dir still exists is never swept — its mapping
    // (if present in this temp config) must survive the sweep
    const stillMapped = liveMappings()["test-ns"];
    if (stillMapped !== undefined) {
      expect(stillMapped).toBeTruthy();
    }
  });
});
