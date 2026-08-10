/**
 * Offline unit tests for the native S3 sync engine (no network, no AWS).
 * Covers: local walking + exclusions, delta computation, manifest round-trip,
 * and the cross-process lock.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  walkLocal,
  computeDeltas,
  remoteKeyFor,
  acquireLock,
  releaseLock,
} from "./sync";
import {
  loadManifest,
  saveManifest,
  makeManifest,
  type S3SyncManifest,
} from "./manifest";
import { DEFAULT_S3_CONFIG, type S3Config } from "./config";

let tmp: string;
let nsDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-s3-test-"));
  nsDir = path.join(tmp, "namespaces", "testns");
  fs.mkdirSync(path.join(nsDir, "event", "2026-08"), { recursive: true });
  fs.mkdirSync(path.join(nsDir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(nsDir, ".embeddings"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const p = path.join(nsDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

function cfg(): S3Config {
  return { ...DEFAULT_S3_CONFIG, enabled: true };
}

describe("walkLocal", () => {
  it("includes JSONL/manifest files and excludes .git, caches, and index files", () => {
    write("event/2026-08/current.jsonl", "a\nb\n");
    write("manifest.json", "{}");
    write("duckdb.db", "binary");
    write("event/2026-08/old.parquet", "binary");
    write(".git/HEAD", "ref");
    write(".embeddings/vec.bin", "x");

    const files = walkLocal(nsDir);
    const rels = [...files.keys()].sort();
    expect(rels).toEqual(["event/2026-08/current.jsonl", "manifest.json"]);
  });

  it("records size and mtime", () => {
    write("config/2026-08/current.jsonl", "hello");
    const files = walkLocal(nsDir);
    const f = files.get("config/2026-08/current.jsonl");
    expect(f?.size).toBe(5);
    expect(f?.mtimeMs).toBeGreaterThan(0);
  });
});

describe("computeDeltas", () => {
  it("uploads new and changed files, skips unchanged ones", () => {
    write("a.jsonl", "1");
    write("b.jsonl", "22");
    const local = walkLocal(nsDir);
    const remote = new Map([
      [
        remoteKeyFor(cfg(), "testns", "b.jsonl"),
        { key: remoteKeyFor(cfg(), "testns", "b.jsonl"), size: 2 },
      ],
    ]);
    const manifest: S3SyncManifest = {
      version: 1,
      ns: "testns",
      lastSyncAt: new Date().toISOString(),
      files: {
        "b.jsonl": { size: 2, mtimeMs: local.get("b.jsonl")!.mtimeMs },
      },
    };

    const d = computeDeltas(cfg(), "testns", local, remote, manifest);
    expect(d.toUpload.map((f) => f.relPath)).toEqual(["a.jsonl"]);
    expect(d.skipped).toBe(1);
  });

  it("downloads remote files missing or different locally", () => {
    write("local-only.jsonl", "x");
    const local = walkLocal(nsDir);
    const remote = new Map([
      [
        remoteKeyFor(cfg(), "testns", "remote-new.jsonl"),
        { key: "x", size: 3 },
      ],
      [
        remoteKeyFor(cfg(), "testns", "local-only.jsonl"),
        { key: "y", size: 999 },
      ],
    ]);

    const d = computeDeltas(cfg(), "testns", local, remote, null);
    const downloads = d.toDownload.map((i) => i.relPath).sort();
    expect(downloads).toEqual(["local-only.jsonl", "remote-new.jsonl"]);
  });

  it("does not download files that match locally", () => {
    write("same.jsonl", "12345");
    const local = walkLocal(nsDir);
    const remote = new Map([
      [remoteKeyFor(cfg(), "testns", "same.jsonl"), { key: "z", size: 5 }],
    ]);
    const d = computeDeltas(cfg(), "testns", local, remote, null);
    expect(d.toDownload).toHaveLength(0);
  });
});

describe("manifest round-trip", () => {
  it("saves and loads manifests from the state dir", () => {
    const manifest = makeManifest("testns", {
      "a.jsonl": { size: 1, mtimeMs: 123 },
    });
    saveManifest(manifest, path.join(tmp, "namespaces"));
    const loaded = loadManifest(path.join(tmp, "namespaces"), "testns");
    expect(loaded).not.toBeNull();
    expect(loaded!.files["a.jsonl"]).toEqual({ size: 1, mtimeMs: 123 });
    expect(loaded!.lastSyncAt).toBe(manifest.lastSyncAt);
  });

  it("returns null for missing manifests", () => {
    expect(loadManifest(path.join(tmp, "namespaces"), "ghost")).toBeNull();
  });
});

describe("sync lock", () => {
  it("prevents concurrent syncs and expires stale locks", () => {
    const nsRoot = path.join(tmp, "namespaces");
    const lock1 = acquireLock(nsRoot);
    expect(lock1).not.toBeNull();
    expect(acquireLock(nsRoot)).toBeNull();

    // Simulate a stale lock (age > 10 min)
    releaseLock(lock1);
    const stale = acquireLock(nsRoot)!;
    const stalePath = stale.path;
    const data = JSON.parse(fs.readFileSync(stalePath, "utf-8"));
    data.ts = Date.now() - 11 * 60 * 1000;
    fs.writeFileSync(stalePath, JSON.stringify(data));
    const lock2 = acquireLock(nsRoot);
    expect(lock2).not.toBeNull();
    releaseLock(lock2);
  });
});
