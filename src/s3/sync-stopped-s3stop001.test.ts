/**
 * S3-SYNC-STOPPED-001 — the mirror went eight days stale while every surface
 * that could have said so was green.
 *
 * Measured 2026-11-05: every `.s3state/*.json` was dated 2026-10-28, hermes was
 * local=14 / remote=6, and `pull hermes` into an EMPTY tree restored 2 files /
 * 1 record and exited 0 with "downloaded=6 skipped=0". Completeness was checked
 * against a checksum ledger published by the SAME stale push, so the mirror
 * always agreed with itself.
 *
 * What this suite pins:
 *   1. a clean push records WHEN (lastPushAt) and whether it was clean; a push
 *      with a failed PUT does not advance the clean timestamp;
 *   2. freshness is numbers: age of the last clean push + the local syncable
 *      files that push does not cover (named, not just counted);
 *   3. `sync all push` leaves a run record, and a pass that never finished is
 *      distinguishable from one that did (finishedAt null);
 *   4. pull REFUSES a mirror older than the local tree, and names the files —
 *      pre-fix it reported success (the falsifier);
 *   5. control: a pull into an empty tree still restores everything and stays
 *      green (the guard cannot fire on a restore that has nothing local).
 *
 * Isolation: ./client is mocked with an in-memory bucket (ETags derived from
 * the stored bytes, same harness as S3-PULL-INTEGRITY-001); every tree is a
 * temp dir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  pushNamespace,
  pullNamespace,
  syncAllNamespacesResult,
} from "./sync";
import {
  loadPushRun,
  loadPushState,
  measureNamespaceFreshness,
} from "./freshness";
import { loadManifest, makeManifest, saveManifest } from "./manifest";
import { DEFAULT_S3_CONFIG, type S3Config } from "./config";
import { collectS3StatusReport, describePushRun, formatAge } from "./cli";

const md5 = (b: Buffer | string): string =>
  createHash("md5").update(b).digest("hex");

const fake = vi.hoisted(() => {
  const FAKE_CLIENT = { __fakeS3Client: true } as unknown;
  const objects = new Map<string, { body: Buffer; etag?: string }>();
  const failPutKeys = new Set<string>();
  return { FAKE_CLIENT, objects, failPutKeys };
});

vi.mock("./client", () => ({
  buildClient: () => fake.FAKE_CLIENT,
  listRemoteObjects: async (
    _c: unknown,
    _b: string,
    prefix: string,
  ): Promise<Map<string, { key: string; size: number; etag?: string }>> => {
    const out = new Map<string, { key: string; size: number; etag?: string }>();
    for (const [key, o] of fake.objects) {
      if (key.startsWith(prefix))
        out.set(key, { key, size: o.body.length, etag: o.etag });
    }
    return out;
  },
  getObject: async (_c: unknown, _b: string, key: string): Promise<Buffer> => {
    const obj = fake.objects.get(key);
    if (!obj) throw new Error(`NoSuchKey: ${key}`);
    return Buffer.from(obj.body);
  },
  putObject: async (
    _c: unknown,
    _b: string,
    key: string,
    body: Buffer,
  ): Promise<string> => {
    if (fake.failPutKeys.has(key)) throw new Error(`stubbed PUT failure: ${key}`);
    const etag = `"${md5(body)}"`;
    fake.objects.set(key, { body: Buffer.from(body), etag });
    return etag;
  },
  deleteObject: async (): Promise<void> => undefined,
}));

const CFG: S3Config = {
  ...DEFAULT_S3_CONFIG,
  enabled: true,
  bucket: "duckbrain",
  prefix: "duckbrain",
};
const NS = "hermes";
const REC_A = "event/2026-11/current.jsonl";
const REC_B = "config/2026-11/current.jsonl";
const NS_PREFIX = `${CFG.prefix}/${NS}/`;

let root: string;
let nsRoot: string;
let configFile: string;

function seedNamespace(): void {
  const dir = path.join(nsRoot, NS);
  fs.mkdirSync(path.join(dir, path.dirname(REC_A)), { recursive: true });
  fs.mkdirSync(path.join(dir, path.dirname(REC_B)), { recursive: true });
  fs.writeFileSync(
    path.join(dir, REC_A),
    '{"key":"/a","value":1}\n{"key":"/b","value":2}\n',
  );
  fs.writeFileSync(path.join(dir, REC_B), '{"key":"/c","value":3}\n');
}

/** Make a file look written AFTER `iso` (filesystems can share a ms). */
function touchAfter(relPath: string, iso: string): void {
  const at = new Date(Date.parse(iso) + 60_000);
  fs.utimesSync(path.join(nsRoot, NS, relPath), at, at);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "s3stop001-"));
  nsRoot = path.join(root, "namespaces");
  // The status surface resolves config + the namespaces root from
  // DUCKBRAIN_CONFIG_PATH, exactly as the CLI does.
  configFile = path.join(root, "duckbrain.config.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify(
      {
        namespacesPath: "./namespaces",
        s3: { ...DEFAULT_S3_CONFIG, enabled: true, bucket: "duckbrain", prefix: "duckbrain" },
      },
      null,
      2,
    ),
    "utf-8",
  );
  process.env.DUCKBRAIN_CONFIG_PATH = configFile;
  process.env.DUCKBRAIN_NAMESPACES_PATH = nsRoot;
  fake.objects.clear();
  fake.failPutKeys.clear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.DUCKBRAIN_CONFIG_PATH;
  delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("S3-SYNC-STOPPED-001 — push freshness record", () => {
  it("records lastPushAt + a clean verdict, and counts what it moved", async () => {
    seedNamespace();
    const before = Date.now();
    const stats = await pushNamespace(CFG, NS, nsRoot);

    expect(stats.uploaded).toBe(2);
    const state = loadPushState(nsRoot, NS);
    expect(state).not.toBeNull();
    expect(state!.lastPushOk).toBe(true);
    expect(state!.uploaded).toBe(2);
    expect(state!.failedUploads).toBe(0);
    const pushedAt = Date.parse(state!.lastPushAt!);
    expect(Number.isFinite(pushedAt)).toBe(true);
    expect(pushedAt).toBeGreaterThanOrEqual(before - 1000);
  });

  it("does NOT advance the clean timestamp when an object fails to upload", async () => {
    seedNamespace();
    await pushNamespace(CFG, NS, nsRoot); // first clean push
    const first = loadPushState(nsRoot, NS)!.lastPushAt;

    // A new file whose upload is rejected.
    const rel = "raw_note/2026-11/current.jsonl";
    fs.mkdirSync(path.join(nsRoot, NS, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(nsRoot, NS, rel), '{"key":"/d","value":4}\n');
    fake.failPutKeys.add(`${NS_PREFIX}${rel}`);

    const dirty = await pushNamespace(CFG, NS, nsRoot);

    expect(dirty.uploaded).toBe(0);
    const state = loadPushState(nsRoot, NS)!;
    expect(state.lastPushOk).toBe(false);
    expect(state.failedUploads).toBe(1);
    // The clean time is the LAST CLEAN pass, not "some push happened".
    expect(state.lastPushAt).toBe(first);
    expect(state.lastPushAttemptAt).not.toBe(first);
  });

  it("measures age and names the local files the clean push does not cover", async () => {
    seedNamespace();
    await pushNamespace(CFG, NS, nsRoot);
    const state = loadPushState(nsRoot, NS)!;

    // Untouched since the push: nothing is unpushed.
    const clean = measureNamespaceFreshness(nsRoot, NS);
    expect(clean.unpushed).toBe(0);
    expect(clean.pushAgeSeconds).not.toBeNull();
    expect(clean.pushAgeSeconds!).toBeLessThan(60);

    // A file written after the push is stale data, named, not just counted.
    touchAfter(REC_A, state.lastPushAt!);
    const after = measureNamespaceFreshness(nsRoot, NS);
    expect(after.unpushed).toBe(1);
    expect(after.unpushedSample).toEqual([REC_A]);
  });

  it("treats a host with no push record as fully unpushed, and falls back to the manifest's coverage", async () => {
    seedNamespace();
    // No push record at all (pre-upgrade install): nothing can be claimed.
    const bare = measureNamespaceFreshness(nsRoot, NS);
    expect(bare.lastPushAt).toBeNull();
    expect(bare.pushAgeSeconds).toBeNull();
    expect(bare.unpushed).toBe(2);

    // The manifest is the fallback authority: the paths it carries were
    // uploaded or verified against the remote, so they are not "unpushed".
    const manifest = makeManifest(NS, {
      [REC_A]: { size: 1, mtimeMs: 0 },
      [REC_B]: { size: 1, mtimeMs: 0 },
    });
    saveManifest(manifest, nsRoot);
    const withManifest = measureNamespaceFreshness(nsRoot, NS);
    expect(withManifest.unpushed).toBe(0);
  });
});

describe("S3-SYNC-STOPPED-001 — sync all pass record", () => {
  it("writes a start record and a terminal record for a completed pass", async () => {
    seedNamespace();
    fs.mkdirSync(path.join(nsRoot, "second"), { recursive: true });
    fs.writeFileSync(path.join(nsRoot, "second", "notes.md"), "# second\n");

    const result = await syncAllNamespacesResult(CFG, nsRoot, "push");
    expect(result.failed).toBe(0);

    const run = loadPushRun(nsRoot);
    expect(run).not.toBeNull();
    expect(run!.command).toBe("sync all push");
    expect(run!.finishedAt).not.toBeNull();
    expect(run!.ok).toBe(true);
    expect(run!.attempted).toBe(2);
    expect(run!.succeeded).toBe(2);
    expect(run!.uploaded).toBe(3);
  });

  it("records ok:false with the first failing namespace", async () => {
    seedNamespace();
    fs.mkdirSync(path.join(nsRoot, "broken"), { recursive: true });
    fs.writeFileSync(path.join(nsRoot, "broken", "a.jsonl"), "{}\n");
    // The ledger publish is a push failure: the data would be restorable but
    // unverifiable, which S3-PULL-INTEGRITY-001 defines as a failed push.
    fake.failPutKeys.add(`${CFG.prefix}/broken/.s3state/checksums.json`);

    const result = await syncAllNamespacesResult(CFG, nsRoot, "push");
    expect(result.failed).toBe(1);

    const run = loadPushRun(nsRoot)!;
    expect(run.ok).toBe(false);
    expect(run.failed).toBe(1);
    expect(run.error).toContain("broken");
  });
});

describe("S3-SYNC-STOPPED-001 — pull refuses a mirror older than the tree", () => {
  it("FALSIFIER: pre-fix, this pull reported success; now it names the newer files and writes nothing", async () => {
    seedNamespace();
    await pushNamespace(CFG, NS, nsRoot);
    const state = loadPushState(nsRoot, NS)!;
    // Local writes after the push — the exact drift the mirror cannot contain.
    // (Write FIRST, then stamp the mtime: a write sets mtime to "now", which can
    // land in the same millisecond as the push that created the marker.)
    fs.writeFileSync(
      path.join(nsRoot, NS, REC_A),
      '{"key":"/a","value":1}\n{"key":"/b","value":2}\n{"key":"/e","value":5}\n',
    );
    touchAfter(REC_A, state.lastPushAt!);

    const before = fs.readFileSync(path.join(nsRoot, NS, REC_A), "utf-8");
    const stats = await pullNamespace(CFG, NS, nsRoot);

    expect(stats.failed).toBeGreaterThan(0);
    const stale = stats.failures.filter((f) => f.kind === "stale");
    expect(stale.map((f) => f.relPath)).toContain(REC_A);
    expect(stale[0].detail).toContain("after the last sync");
    // Refusal is terminal: nothing downloaded, local bytes untouched.
    expect(stats.downloaded).toBe(0);
    expect(fs.readFileSync(path.join(nsRoot, NS, REC_A), "utf-8")).toBe(before);
  });

  it("names a local path that has no object in the remote listing", async () => {
    seedNamespace();
    await pushNamespace(CFG, NS, nsRoot);
    const localOnly = "raw_note/2026-11/current.jsonl";
    fs.mkdirSync(path.join(nsRoot, NS, path.dirname(localOnly)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(nsRoot, NS, localOnly), '{"key":"/new"}\n');

    const stats = await pullNamespace(CFG, NS, nsRoot);

    const unpushed = stats.failures.filter((f) => f.kind === "unpushed");
    expect(unpushed.map((f) => f.relPath)).toContain(localOnly);
    expect(unpushed[0].detail).toContain("NO object in the remote listing");
    expect(stats.downloaded).toBe(0);
  });

  it("CONTROL: a pull into an empty tree still restores everything and stays green", async () => {
    seedNamespace();
    await pushNamespace(CFG, NS, nsRoot);
    const dstRoot = path.join(root, "restore");

    const stats = await pullNamespace(CFG, NS, dstRoot);

    expect(stats.failed).toBe(0);
    expect(stats.downloaded).toBe(2);
    expect(fs.readFileSync(path.join(dstRoot, NS, REC_A), "utf-8")).toContain(
      '"/b"',
    );
    expect(fs.readFileSync(path.join(dstRoot, NS, REC_B), "utf-8")).toContain(
      '"/c"',
    );
  });

  it("CONTROL: a re-pull immediately after a pull is not misread as drift", async () => {
    seedNamespace();
    await pushNamespace(CFG, NS, nsRoot);
    const dstRoot = path.join(root, "restore");
    const first = await pullNamespace(CFG, NS, dstRoot);
    expect(first.failed).toBe(0);
    const manifest = loadManifest(dstRoot, NS);
    expect(manifest).not.toBeNull();

    const second = await pullNamespace(CFG, NS, dstRoot);
    expect(second.failed).toBe(0);
    expect(second.downloaded).toBe(0);
  });
});

describe("S3-SYNC-STOPPED-001 — s3 status reports freshness, not just a timestamp", () => {
  it("exposes lastPushAt, its age, the unpushed count and paths, plus the pass record", async () => {
    seedNamespace();
    await pushNamespace(CFG, NS, nsRoot);
    await syncAllNamespacesResult(CFG, nsRoot, "push");
    const state = loadPushState(nsRoot, NS)!;
    touchAfter(REC_B, state.lastPushAt!);

    const report = await collectS3StatusReport(root, NS, {
      probeRemote: false,
    });

    const row = report.namespaces.find((r) => r.ns === NS)!;
    expect(row.lastPushAt).toBe(state.lastPushAt);
    expect(row.lastPushAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(row.lastPushOk).toBe(true);
    expect(row.unpushed).toBe(1);
    expect(row.unpushedSample).toEqual([REC_B]);
    expect(report.lastRun).not.toBeNull();
    expect(report.lastRun!.finishedAt).not.toBeNull();
  });

  it("renders the age and the run record in human form (not a bare timestamp)", () => {
    expect(formatAge(8 * 24 * 3600 + 3 * 3600)).toBe("8d 3h");
    expect(formatAge(90)).toBe("90s");
    expect(formatAge(300)).toBe("5m");
    expect(formatAge(null)).toBe("unknown");

    const now = Date.parse("2026-11-06T12:00:00Z");
    expect(describePushRun(null, now)).toContain("NEVER");
    expect(
      describePushRun(
        {
          version: 1,
          command: "sync all push",
          startedAt: "2026-11-06T08:00:00Z",
          finishedAt: null,
          ok: null,
          attempted: null,
          succeeded: null,
          failed: null,
          uploaded: null,
          error: null,
        },
        now,
      ),
    ).toContain("never finished");
    expect(
      describePushRun(
        {
          version: 1,
          command: "sync all push",
          startedAt: "2026-11-06T08:00:00Z",
          finishedAt: "2026-11-06T08:10:00Z",
          ok: true,
          attempted: 3,
          succeeded: 3,
          failed: 0,
          uploaded: 12,
          error: null,
        },
        now,
      ),
    ).toContain("ok at 2026-11-06T08:10:00Z");
  });
});
