/**
 * S3-PULL-COMPLETENESS-001 — verification covered bytes that ARRIVE; it said
 * nothing about objects that never arrive.
 *
 * The defect (found while landing S3-PULL-INTEGRITY-001 / 301468f7): pull
 * enumerates the REMOTE listing, so an object that was deleted remotely simply
 * produces no download to verify. `scripts/restore-proof.sh --fault
 * delete-one` removed one object and the ENGINE still reported success — only
 * the proof's own file-count/sha256 comparison noticed, after the fact.
 *
 * The ledger the push publishes already records every path that should exist,
 * so the engine can decide completeness itself: a path listed in the ledger
 * with NO object in the remote listing is a failure (kind "missing"), named,
 * nonzero exit, and nothing local is written or deleted.
 *
 * Isolation: ./client is mocked with an in-memory object store whose ETags are
 * derived from the bytes actually stored (same harness as S3-PULL-INTEGRITY-001).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { S3Client } from "@aws-sdk/client-s3";
import type { RemoteObject } from "./client";
import {
  pushNamespace,
  pullNamespace,
  syncAllNamespacesResult,
  ledgerKey,
} from "./sync";
import { DEFAULT_S3_CONFIG, type S3Config } from "./config";

const md5 = (b: Buffer | string): string =>
  createHash("md5").update(b).digest("hex");

/** In-memory S3: ETags are derived from the stored bytes, like a real bucket. */
const fake = vi.hoisted(() => {
  const FAKE_CLIENT = { __fakeS3Client: true } as unknown;
  const objects = new Map<string, { body: Buffer; etag?: string }>();
  const failGetKeys = new Set<string>();
  return { FAKE_CLIENT, objects, failGetKeys };
});

vi.mock("./client", () => ({
  buildClient: (): S3Client => fake.FAKE_CLIENT as S3Client,
  listRemoteObjects: async (
    _c: S3Client,
    _b: string,
    prefix: string,
  ): Promise<Map<string, RemoteObject>> => {
    const out = new Map<string, RemoteObject>();
    for (const [key, o] of fake.objects) {
      if (key.startsWith(prefix))
        out.set(key, { key, size: o.body.length, etag: o.etag });
    }
    return out;
  },
  getObject: async (_c: S3Client, _b: string, key: string): Promise<Buffer> => {
    if (fake.failGetKeys.has(key)) {
      fake.failGetKeys.delete(key);
      throw new Error(`stubbed GET failure: ${key}`);
    }
    const obj = fake.objects.get(key);
    if (!obj) throw new Error(`NoSuchKey: ${key}`);
    return Buffer.from(obj.body);
  },
  putObject: async (
    _c: S3Client,
    _bucket: string,
    key: string,
    body: Buffer,
  ): Promise<string> => {
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
const NS_PREFIX = `${CFG.prefix}/${NS}/`;
const MISSING_REL = "event/2026-11/current.jsonl";

let root: string;

function seedNamespace(dir: string): void {
  fs.mkdirSync(path.join(dir, "event", "2026-11"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, MISSING_REL),
    '{"k":"a","v":1}\n{"k":"b","v":2}\n',
  );
  fs.writeFileSync(path.join(dir, "notes.md"), "# hermes\n");
}

/** Push a seeded namespace, then remove a single DATA object from the bucket. */
async function pushThenLoseObject(rel: string): Promise<string> {
  const srcRoot = path.join(root, "src");
  seedNamespace(path.join(srcRoot, NS));
  await pushNamespace(CFG, NS, srcRoot);
  fs.rmSync(srcRoot, { recursive: true, force: true });
  const key = `${NS_PREFIX}${rel}`;
  expect(fake.objects.delete(key)).toBe(true);
  // The ledger must still list it — that is the whole premise.
  const ledger = JSON.parse(
    fake.objects.get(ledgerKey(CFG, NS))!.body.toString("utf-8"),
  ) as { files: Record<string, unknown> };
  expect(Object.keys(ledger.files)).toContain(rel);
  return key;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "s3pull002-"));
  fake.objects.clear();
  fake.failGetKeys.clear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("s3 pull completeness — ledger-listed but absent remotely (S3-PULL-COMPLETENESS-001)", () => {
  it("names a ledger-listed object missing from the remote listing and writes nothing", async () => {
    const key = await pushThenLoseObject(MISSING_REL);
    const dstRoot = path.join(root, "dst");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const stats = await pullNamespace(CFG, NS, dstRoot);

    // FALSIFIER: pre-fix code reported failed=0 and exited 0 here.
    expect(stats.checksumLedger).toBe("present");
    expect(stats.failed).toBe(1);
    expect(stats.failures[0]).toMatchObject({
      ns: NS,
      key,
      relPath: MISSING_REL,
      kind: "missing",
    });
    expect(stats.failures[0].detail).toContain("checksum ledger");
    // No local file was invented for a path with no object behind it.
    expect(fs.existsSync(path.join(dstRoot, NS, MISSING_REL))).toBe(false);
    // The objects that DID arrive still restore — the run is partial, not aborted.
    expect(fs.readFileSync(path.join(dstRoot, NS, "notes.md"), "utf-8")).toBe(
      "# hermes\n",
    );
    // The engine's own output names the missing key and the reason.
    expect(errors.join("\n")).toContain(key);
    expect(errors.join("\n")).toContain("missing");
  });

  it("stays green when every ledger path is present remotely (the control)", async () => {
    const srcRoot = path.join(root, "src");
    seedNamespace(path.join(srcRoot, NS));
    await pushNamespace(CFG, NS, srcRoot);
    fs.rmSync(srcRoot, { recursive: true, force: true });

    const dstRoot = path.join(root, "dst");
    const stats = await pullNamespace(CFG, NS, dstRoot);

    expect(stats.failed).toBe(0);
    expect(stats.failures).toEqual([]);
    expect(stats.downloaded).toBe(2);
    expect(stats.verified).toBe(2);
    expect(stats.checksumLedger).toBe("present");
    expect(
      fs.readFileSync(path.join(dstRoot, NS, MISSING_REL), "utf-8"),
    ).toContain('"k":"b"');
  });

  it("does not touch or delete an existing local file whose object went missing", async () => {
    const key = await pushThenLoseObject(MISSING_REL);
    const dstRoot = path.join(root, "dst");
    // An incremental pull onto a tree that still has the file (the remote lost
    // the object, the local copy is fine): the local bytes are not evidence of
    // a complete backup, so the gap is still reported — and nothing is deleted.
    const local = path.join(dstRoot, NS, MISSING_REL);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, "local copy, untouched\n");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const stats = await pullNamespace(CFG, NS, dstRoot);

    expect(stats.failed).toBe(1);
    expect(stats.failures[0]).toMatchObject({ key, kind: "missing" });
    expect(fs.readFileSync(local, "utf-8")).toBe("local copy, untouched\n");
  });

  it("says it cannot claim completeness when no ledger exists", async () => {
    const srcRoot = path.join(root, "src");
    seedNamespace(path.join(srcRoot, NS));
    await pushNamespace(CFG, NS, srcRoot);
    fs.rmSync(srcRoot, { recursive: true, force: true });
    // Legacy/pre-ledger backup: objects on the wire, no identity record.
    fake.objects.delete(ledgerKey(CFG, NS));
    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    });

    const stats = await pullNamespace(CFG, NS, path.join(root, "dst"));

    expect(stats.checksumLedger).toBe("absent");
    expect(stats.failed).toBe(0); // nothing to compare — not a fabricated gap
    expect(stats.downloaded).toBe(2);
    expect(warns.join("\n")).toContain("CANNOT claim completeness");
  });
});

describe("sync all pull — a missing object is a namespace failure", () => {
  it("aggregate reports the namespace as failed and names the missing key", async () => {
    const key = await pushThenLoseObject(MISSING_REL);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await syncAllNamespacesResult(
      CFG,
      path.join(root, "dst"),
      "pull",
    );

    expect(result.attempted).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.failures[0].namespace).toBe(NS);
    expect(result.failures[0].error).toContain(key);
    expect(result.failures[0].error).toContain("missing");
  });
});
