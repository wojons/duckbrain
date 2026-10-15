/**
 * S3-GIT-008 — content-identity deltas + failed-PUT manifest integrity.
 *
 * Two data-integrity bugs, both reproduced here as failing tests FIRST:
 *
 *  1. computeDeltas() decided upload/skip from size+mtimeMs alone. Two
 *     different payloads with identical size and mtime were never detected in
 *     either direction: push left stale remote bytes, pull never repaired
 *     same-length local corruption. Fix: sha256 content identity (manifest),
 *     md5 ETag as a HINT only (multipart ETags — containing '-' — are NEVER
 *     treated as content checksums), byte comparison as the arbiter.
 *  2. pushNamespace() saved a manifest covering every walked file even when
 *     its PUT threw — recording failed objects as synchronized so the next
 *     pass skipped them forever. Fix: the saved manifest is built ONLY from
 *     successfully uploaded files merged with previously-synced unchanged
 *     entries; failed PUTs stay out and are retried next pass.
 *
 * Isolation: the ./client module is mocked with an in-memory object store —
 * no network, no AWS SDK.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { S3Client } from "@aws-sdk/client-s3";
import type { RemoteObject } from "./client";
import {
  walkLocal,
  computeDeltas,
  remoteKeyFor,
  pushNamespace,
  pullNamespace,
} from "./sync";
import {
  loadManifest,
  saveManifest,
  makeManifest,
  type S3SyncManifest,
} from "./manifest";
import { DEFAULT_S3_CONFIG, type S3Config } from "./config";

const sha256 = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");
const md5 = (s: string): string =>
  createHash("md5").update(s, "utf8").digest("hex");

/** Two distinct 10-byte payloads — same length, different content. */
const A10 = "AAAAAAAAAA";
const B10 = "BBBBBBBBBB";

/** In-memory object store shared by the ./client mock (mutable per test). */
const fake = vi.hoisted(() => {
  const FAKE_CLIENT = { __fakeS3Client: true } as unknown;
  const objects = new Map<
    string,
    { size: number; body: Buffer; etag?: string }
  >();
  /** Keys whose PUT must reject (stubbed provider failure). */
  const putFailKeys = new Set<string>();
  /** Keys whose NEXT GET must reject once (stubbed provider failure). */
  const getFailKeys = new Set<string>();
  return { FAKE_CLIENT, objects, putFailKeys, getFailKeys };
});

vi.mock("./client", () => ({
  buildClient: (): S3Client => fake.FAKE_CLIENT as S3Client,
  listRemoteObjects: async (
    _client: S3Client,
    _bucket: string,
    prefix: string,
  ): Promise<Map<string, RemoteObject>> => {
    const out = new Map<string, RemoteObject>();
    for (const [key, obj] of fake.objects) {
      if (key.startsWith(prefix))
        out.set(key, { key, size: obj.size, etag: obj.etag });
    }
    return out;
  },
  getObject: async (
    _client: S3Client,
    _bucket: string,
    key: string,
  ): Promise<Buffer> => {
    if (fake.getFailKeys.has(key)) {
      fake.getFailKeys.delete(key); // fail ONCE, then heal
      throw new Error(`stubbed GET failure: ${key}`);
    }
    const obj = fake.objects.get(key);
    if (!obj) throw new Error(`NoSuchKey: ${key}`);
    return obj.body;
  },
  putObject: async (
    _client: S3Client,
    _bucket: string,
    key: string,
    body: Buffer,
  ): Promise<string | undefined> => {
    if (fake.putFailKeys.has(key)) {
      throw new Error(`stubbed PUT failure: ${key}`);
    }
    fake.objects.set(key, { size: body.length, body });
    return undefined;
  },
  deleteObject: async (): Promise<void> => {},
}));

let tmp: string;
let nsDir: string;
let nsRoot: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-s3git008-"));
  nsRoot = path.join(tmp, "namespaces");
  nsDir = path.join(nsRoot, "testns");
  fs.mkdirSync(nsDir, { recursive: true });
  fake.objects.clear();
  fake.putFailKeys.clear();
  fake.getFailKeys.clear();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function write(rel: string, content: string): void {
  const p = path.join(nsDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

/** Overwrite a file's bytes WITHOUT changing its mtime (in-place corruption). */
function corruptInPlace(rel: string, content: string): void {
  const p = path.join(nsDir, rel);
  const before = fs.statSync(p);
  fs.writeFileSync(p, content, "utf8");
  fs.utimesSync(p, before.atime, before.mtime);
}

function cfg(): S3Config {
  return {
    ...DEFAULT_S3_CONFIG,
    enabled: true,
    bucket: "duckbrain",
    prefix: "duckbrain",
  };
}

function remoteMap(
  rel: string,
  size: number,
  etag?: string,
): Map<string, RemoteObject> {
  const key = remoteKeyFor(cfg(), "testns", rel);
  return new Map([[key, { key, size, etag }]]);
}

/** Read every syncable local file's bytes into the contents map. */
function readContents(local: Map<string, { relPath: string }>): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const relPath of local.keys()) {
    out.set(relPath, fs.readFileSync(path.join(nsDir, relPath)));
  }
  return out;
}

describe("computeDeltas content identity (S3-GIT-008)", () => {
  it("BUG 1 — same size + same mtime but different content is uploaded (push)", () => {
    // Local bytes are B, but the manifest (from the last sync) says the file
    // held A. Size (10) and mtime are identical — only the hash can tell.
    write("a.jsonl", B10);
    const local = walkLocal(nsDir);
    const contents = readContents(local);
    const mtime = local.get("a.jsonl")!.mtimeMs;
    const manifest: S3SyncManifest = makeManifest("testns", {
      "a.jsonl": { size: 10, mtimeMs: mtime, sha256: sha256(A10) },
    });
    // Remote holds an object of the same length with NO usable ETag.
    const remote = remoteMap("a.jsonl", 10);

    const d = computeDeltas(cfg(), "testns", local, remote, manifest, contents);

    expect(d.toUpload.map((f) => f.relPath)).toEqual(["a.jsonl"]);
    expect(d.skipped).toBe(0);
  });

  it("matching content identity (manifest sha256) is skipped even with unknown remote identity", () => {
    write("a.jsonl", B10);
    const local = walkLocal(nsDir);
    const contents = readContents(local);
    const mtime = local.get("a.jsonl")!.mtimeMs;
    const manifest: S3SyncManifest = makeManifest("testns", {
      "a.jsonl": { size: 10, mtimeMs: mtime, sha256: sha256(B10) },
    });
    const remote = remoteMap("a.jsonl", 10);

    const d = computeDeltas(cfg(), "testns", local, remote, manifest, contents);

    expect(d.toUpload).toHaveLength(0);
    expect(d.skipped).toBe(1);
  });

  it("BUG 1 — same length + same mtime local corruption is repaired by push (upload)", () => {
    // The file was corrupted IN PLACE after the last sync: same 10 bytes,
    // preserved mtime — the classic unreproducible-with-size+mtime case.
    write("a.jsonl", A10);
    const local = walkLocal(nsDir);
    const mtime = local.get("a.jsonl")!.mtimeMs;
    corruptInPlace("a.jsonl", B10);
    const localAfter = walkLocal(nsDir);
    localAfter.get("a.jsonl")!.mtimeMs = mtime; // simulate preserved mtime
    const contents = readContents(localAfter);
    const manifest: S3SyncManifest = makeManifest("testns", {
      "a.jsonl": { size: 10, mtimeMs: mtime, sha256: sha256(A10) },
    });
    const remote = remoteMap("a.jsonl", 10);

    const d = computeDeltas(
      cfg(),
      "testns",
      localAfter,
      remote,
      manifest,
      contents,
    );

    expect(d.toUpload.map((f) => f.relPath)).toEqual(["a.jsonl"]);
  });

  it("BUG 1 — pull: same size, remote content differs from local (ETag md5 hint) is downloaded", () => {
    write("a.jsonl", A10);
    const local = walkLocal(nsDir);
    const contents = readContents(local);
    const manifest: S3SyncManifest = makeManifest("testns", {
      "a.jsonl": {
        size: 10,
        mtimeMs: local.get("a.jsonl")!.mtimeMs,
        sha256: sha256(A10),
      },
    });
    // Remote object: same length, md5 ETag proves DIFFERENT bytes.
    const remote = remoteMap("a.jsonl", 10, `"${md5(B10)}"`);

    const d = computeDeltas(cfg(), "testns", local, remote, manifest, contents);

    expect(d.toDownload.map((i) => i.relPath)).toEqual(["a.jsonl"]);
  });

  it("pull: remote md5 ETag equal to local content skips the download (quoted and unquoted)", () => {
    write("a.jsonl", A10);
    const local = walkLocal(nsDir);
    const contents = readContents(local);
    const manifest: S3SyncManifest = makeManifest("testns", {
      "a.jsonl": {
        size: 10,
        mtimeMs: local.get("a.jsonl")!.mtimeMs,
        sha256: sha256(A10),
      },
    });
    // Size intentionally divergent from the record to prove the ETag hint —
    // not size — drives the skip.
    for (const etag of [`"${md5(A10)}"`, md5(A10)]) {
      const remote = remoteMap("a.jsonl", 999, etag);
      const d = computeDeltas(
        cfg(),
        "testns",
        local,
        remote,
        manifest,
        contents,
      );
      expect(d.toDownload).toHaveLength(0);
    }
  });

  it("multipart ETag ('-') is NEVER trusted as a checksum — same-size divergent content downloads", () => {
    // A multipart upload's ETag is NOT the md5 of the object bytes. It must
    // be treated as unknown identity, forcing the conservative download.
    write("a.jsonl", A10);
    const local = walkLocal(nsDir);
    const contents = readContents(local);
    const manifest: S3SyncManifest = makeManifest("testns", {
      "a.jsonl": {
        size: 10,
        mtimeMs: local.get("a.jsonl")!.mtimeMs,
        sha256: sha256(A10),
      },
    });
    // Same length as local; a multipart ETag that happens to look like a
    // plausible checksum. Comparing it as md5 would wrongly skip the repair.
    const remote = remoteMap("a.jsonl", 10, `"d41d8cd98f00b204e9800998ecf8427e-4"`);

    const d = computeDeltas(cfg(), "testns", local, remote, manifest, contents);

    expect(d.toDownload.map((i) => i.relPath)).toEqual(["a.jsonl"]);
  });
});

describe("pushNamespace failed-PUT manifest integrity (S3-GIT-008)", () => {
  it("BUG 2 — a failed putObject is NOT recorded as synced; the next push retries it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    write("ok.jsonl", "ok-content\n");
    write("bad.jsonl", "bad-content\n");
    fake.putFailKeys.add(remoteKeyFor(cfg(), "testns", "bad.jsonl"));

    const first = await pushNamespace(cfg(), "testns", nsRoot);

    // Only ok.jsonl uploaded; bad.jsonl failed and must be invisible to the
    // saved manifest so the next pass retries it.
    expect(first.uploaded).toBe(1);
    const afterFirst = loadManifest(nsRoot, "testns");
    expect(afterFirst).not.toBeNull();
    expect(afterFirst!.files["ok.jsonl"]).toBeDefined();
    expect(afterFirst!.files["bad.jsonl"]).toBeUndefined();
    expect(
      fake.objects.has(remoteKeyFor(cfg(), "testns", "bad.jsonl")),
    ).toBe(false);

    // Provider recovers → next push retries EXACTLY the failed object.
    fake.putFailKeys.clear();
    const second = await pushNamespace(cfg(), "testns", nsRoot);
    expect(second.uploaded).toBe(1); // only bad.jsonl
    expect(second.skipped).toBe(1); // ok.jsonl unchanged+synced
    const afterSecond = loadManifest(nsRoot, "testns");
    expect(afterSecond!.files["bad.jsonl"]).toBeDefined();
    expect(
      fake.objects.get(remoteKeyFor(cfg(), "testns", "bad.jsonl"))?.body,
    ).toEqual(Buffer.from("bad-content\n"));
    expect(warn).toHaveBeenCalled();
  });

  it("successfully uploaded files are recorded with their sha256 content identity", async () => {
    write("ok.jsonl", "identity-bytes\n");

    await pushNamespace(cfg(), "testns", nsRoot);

    const manifest = loadManifest(nsRoot, "testns");
    expect(manifest!.files["ok.jsonl"].sha256).toBe(sha256("identity-bytes\n"));
  });
});

describe("pullNamespace same-length repair (S3-GIT-008)", () => {
  it("BUG 1 — a same-length remote update is downloaded and repairs local bytes", async () => {
    write("doc.jsonl", A10);
    // Remote holds the same number of bytes but different content, no ETag.
    fake.objects.set(remoteKeyFor(cfg(), "testns", "doc.jsonl"), {
      size: 10,
      body: Buffer.from(B10, "utf8"),
    });

    const stats = await pullNamespace(cfg(), "testns", nsRoot);

    expect(stats.downloaded).toBe(1);
    expect(fs.readFileSync(path.join(nsDir, "doc.jsonl"), "utf8")).toBe(B10);
    const manifest = loadManifest(nsRoot, "testns");
    expect(manifest!.files["doc.jsonl"].sha256).toBe(sha256(B10));
  });

  it("the pull after a repair is a no-op (manifest identity converges)", async () => {
    write("doc.jsonl", A10);
    fake.objects.set(remoteKeyFor(cfg(), "testns", "doc.jsonl"), {
      size: 10,
      body: Buffer.from(B10, "utf8"),
    });
    await pullNamespace(cfg(), "testns", nsRoot);

    const second = await pullNamespace(cfg(), "testns", nsRoot);

    expect(second.downloaded).toBe(0);
  });

  it("a rewritten multipart-ETag remote object is detected via the recorded ETag (version token) and repaired", async () => {
    // Pass 1: normal repair converges manifest and remote.
    write("doc.jsonl", A10);
    const key = remoteKeyFor(cfg(), "testns", "doc.jsonl");
    fake.objects.set(key, { size: 10, body: Buffer.from(A10, "utf8") });
    // ETag the server would have returned for the upload (a multipart one —
    // the shape that can NEVER be compared as a checksum).
    const multipartEtag = `"${md5(A10)}-3"`;
    fake.objects.get(key)!.etag = multipartEtag;
    await pullNamespace(cfg(), "testns", nsRoot);
    expect(loadManifest(nsRoot, "testns")!.files["doc.jsonl"].etag).toBe(
      multipartEtag,
    );

    // Pass 2: the object is REWRITTEN server-side (same length, new bytes,
    // new multipart ETag). No checksum comparison is possible — the recorded
    // ETag token is what detects the rewrite.
    fake.objects.set(key, { size: 10, body: Buffer.from(B10, "utf8") });
    fake.objects.get(key)!.etag = `"${md5(B10)}-3"`;

    const stats = await pullNamespace(cfg(), "testns", nsRoot);

    expect(stats.downloaded).toBe(1);
    expect(fs.readFileSync(path.join(nsDir, "doc.jsonl"), "utf8")).toBe(B10);
  });

  it("a failed getObject is not marked synced; the next pull retries it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const goodKey = remoteKeyFor(cfg(), "testns", "good.jsonl");
    const badKey = remoteKeyFor(cfg(), "testns", "bad.jsonl");
    fake.objects.set(goodKey, { size: 2, body: Buffer.from("ok", "utf8") });
    fake.objects.set(badKey, { size: 2, body: Buffer.from("no", "utf8") });
    fake.getFailKeys.add(badKey);

    const first = await pullNamespace(cfg(), "testns", nsRoot);
    expect(first.downloaded).toBe(1); // only good.jsonl
    const afterFirst = loadManifest(nsRoot, "testns")!;
    expect(afterFirst.files["good.jsonl"]).toBeDefined();
    expect(afterFirst.files["bad.jsonl"]).toBeUndefined();

    // Healed: the next pull retries the failed object.
    const second = await pullNamespace(cfg(), "testns", nsRoot);
    expect(second.downloaded).toBe(1); // bad.jsonl only
    expect(fs.readFileSync(path.join(nsDir, "bad.jsonl"), "utf8")).toBe("no");
    expect(loadManifest(nsRoot, "testns")!.files["bad.jsonl"]).toBeDefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe("manifest identity is never fabricated (S3-GIT-008)", () => {
  it("a pre-008 (metadata-only) entry skipped via authoritative md5 ETag is carried forward WITHOUT invented identity", async () => {
    write("legacy.jsonl", A10);
    const local = walkLocal(nsDir);
    // Pre-008 manifest: size+mtime recorded, no identity fields. The wire
    // shows a single-part md5 ETag matching the local bytes — the skip is
    // PROVEN, so the entry is carried forward exactly as it was.
    saveManifest(
      makeManifest("testns", {
        "legacy.jsonl": {
          size: 10,
          mtimeMs: local.get("legacy.jsonl")!.mtimeMs,
        },
      }),
      nsRoot,
    );
    fake.objects.set(remoteKeyFor(cfg(), "testns", "legacy.jsonl"), {
      size: 10,
      body: Buffer.from(A10, "utf8"),
      etag: `"${md5(A10)}"`,
    });

    const stats = await pushNamespace(cfg(), "testns", nsRoot);

    expect(stats.uploaded).toBe(0);
    expect(stats.skipped).toBe(1);
    const manifest = loadManifest(nsRoot, "testns")!;
    expect(manifest.files["legacy.jsonl"]).toBeDefined();
    expect(manifest.files["legacy.jsonl"].sha256).toBeUndefined(); // not fabricated
    expect(manifest.files["legacy.jsonl"].etag).toBeUndefined();
  });

  it("a pre-008 entry with no usable ETag is honestly re-uploaded ONCE and records the TRUE hash of the pushed bytes", async () => {
    write("migrate.jsonl", A10);
    const local = walkLocal(nsDir);
    saveManifest(
      makeManifest("testns", {
        "migrate.jsonl": {
          size: 10,
          mtimeMs: local.get("migrate.jsonl")!.mtimeMs,
        },
      }),
      nsRoot,
    );
    // No ETag on the wire — identity is unprovable, so the migration pass
    // re-uploads. The recorded identity must be the REAL hash of the bytes
    // that went over the wire (never invented).
    fake.objects.set(remoteKeyFor(cfg(), "testns", "migrate.jsonl"), {
      size: 10,
      body: Buffer.from(A10, "utf8"),
    });

    const stats = await pushNamespace(cfg(), "testns", nsRoot);

    expect(stats.uploaded).toBe(1);
    const manifest = loadManifest(nsRoot, "testns")!;
    expect(manifest.files["migrate.jsonl"].sha256).toBe(sha256(A10));
    expect(
      fake.objects.get(remoteKeyFor(cfg(), "testns", "migrate.jsonl"))?.body,
    ).toEqual(Buffer.from(A10, "utf8"));
  });

  it("a second push after an identity-recording push is a full no-op and preserves the recorded identity verbatim", async () => {
    write("stable.jsonl", A10);
    fake.objects.set(remoteKeyFor(cfg(), "testns", "stable.jsonl"), {
      size: 10,
      body: Buffer.from(A10, "utf8"),
    });

    await pushNamespace(cfg(), "testns", nsRoot); // records sha256 (+ etag when served)
    const afterFirst = loadManifest(nsRoot, "testns")!;
    const recorded = { ...afterFirst.files["stable.jsonl"] };
    expect(recorded.sha256).toBe(sha256(A10));

    const second = await pushNamespace(cfg(), "testns", nsRoot);

    expect(second.uploaded).toBe(0);
    expect(second.skipped).toBe(1);
    const afterSecond = loadManifest(nsRoot, "testns")!;
    expect(afterSecond.files["stable.jsonl"]).toEqual(recorded);
  });
});
