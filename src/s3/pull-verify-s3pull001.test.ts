/**
 * S3-PULL-INTEGRITY-001 — a pull must not accept bytes it cannot vouch for.
 *
 * The defect (reproduced against the real bucket in
 * docs/evidence/backup-restore-proof-2026-11-05.md): one remote object was
 * overwritten with same-length garbage, `duckbrain s3 sync all pull` into an
 * EMPTY root printed "0 failed", wrote the corrupt file, and a scratch daemon
 * then served the corrupt content. Nothing compared the downloaded bytes to
 * any authority — and on a fresh machine the strongest authority we own (our
 * own sha256 per path, in `.s3state/<ns>.json`) did not even exist there,
 * because it never travelled with the backup.
 *
 * Fix (two halves, both covered here):
 *   1. every downloaded body is verified BEFORE it is written — listing size,
 *      single-part ETag md5, the published checksum ledger's sha256, then the
 *      local manifest hash while its version token still holds; no evidence
 *      means the object is restored but REPORTED as unverified, never silently
 *      trusted;
 *   2. the push publishes `<prefix>/<ns>/.s3state/checksums.json`, so a restore
 *      onto an empty machine has our own sha256 to check against. That is the
 *      tier that catches a server-side overwrite: such an object carries a
 *      self-consistent ETag (md5 of the garbage) and passes any md5 check.
 *
 * Isolation: ./client is mocked with an in-memory object store that behaves
 * like S3 (an ETag is recomputed from the bytes actually stored).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { S3Client } from "@aws-sdk/client-s3";
import type { RemoteObject } from "./client";
import {
  verifyDownloadedObject,
  pushNamespace,
  pullNamespace,
  syncAllNamespacesResult,
  ledgerKey,
  LEDGER_REL_PATH,
} from "./sync";
import { DEFAULT_S3_CONFIG, type S3Config } from "./config";

const sha256 = (b: Buffer | string): string =>
  createHash("sha256").update(b).digest("hex");
const md5 = (b: Buffer | string): string =>
  createHash("md5").update(b).digest("hex");

/** In-memory S3: ETags are derived from the stored bytes, like a real bucket. */
const fake = vi.hoisted(() => {
  const FAKE_CLIENT = { __fakeS3Client: true } as unknown;
  const objects = new Map<string, { body: Buffer; etag?: string }>();
  const failPutKeys = new Set<string>();
  const failGetKeys = new Set<string>();
  return { FAKE_CLIENT, objects, failPutKeys, failGetKeys };
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
      if (key.startsWith(prefix)) out.set(key, { key, size: o.body.length, etag: o.etag });
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
const NS_PREFIX = `${CFG.prefix}/${NS}/`;

let root: string;

/** Write a namespace tree with two data files (one JSONL, one markdown). */
function seedNamespace(dir: string): void {
  fs.mkdirSync(path.join(dir, "event", "2026-11"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "event", "2026-11", "current.jsonl"),
    '{"k":"a","v":1}\n{"k":"b","v":2}\n',
  );
  fs.writeFileSync(path.join(dir, "notes.md"), "# hermes\n");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "s3pull001-"));
  fake.objects.clear();
  fake.failPutKeys.clear();
  fake.failGetKeys.clear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("verifyDownloadedObject — evidence tiers (S3-PULL-INTEGRITY-001)", () => {
  const good = Buffer.from('{"k":"a"}\n');

  it("rejects a body whose length differs from the listing (truncated transfer)", () => {
    const verdict = verifyDownloadedObject(good, { size: good.length + 5 });
    expect(verdict.kind).toBe("mismatch");
    if (verdict.kind === "mismatch") {
      expect(verdict.evidence).toBe("listing-size");
      expect(verdict.detail).toContain("bytes");
    }
  });

  it("verifies a single-part ETag md5 (transfer integrity)", () => {
    expect(
      verifyDownloadedObject(good, { size: good.length, etag: `"${md5(good)}"` }),
    ).toEqual({ kind: "verified", evidence: "etag-md5" });
  });

  it("rejects bytes that do not match a single-part ETag", () => {
    const verdict = verifyDownloadedObject(good, {
      size: good.length,
      etag: `"${md5("other")}"`,
    });
    expect(verdict.kind).toBe("mismatch");
    if (verdict.kind === "mismatch") expect(verdict.evidence).toBe("etag-md5");
  });

  it("REJECTS a self-consistent ETag when the published ledger disagrees (the control)", () => {
    // Same length, different bytes: the bucket's ETag is md5(garbage) and
    // matches the download perfectly. Only the ledger still knows the truth.
    const garbage = Buffer.from('{"k":"Z"}\n');
    expect(garbage.length).toBe(good.length);
    const verdict = verifyDownloadedObject(garbage, {
      size: garbage.length,
      etag: `"${md5(garbage)}"`,
      ledgerSha256: sha256(good),
    });
    expect(verdict.kind).toBe("mismatch");
    if (verdict.kind === "mismatch") {
      expect(verdict.evidence).toBe("ledger-sha256");
      expect(verdict.expected).toBe(sha256(good));
      expect(verdict.actual).toBe(sha256(garbage));
    }
  });

  it("verifies against the ledger when the ETag is multipart (not a checksum)", () => {
    expect(
      verifyDownloadedObject(good, {
        size: good.length,
        etag: '"deadbeefcafe0000-3"',
        ledgerSha256: sha256(good),
      }),
    ).toEqual({ kind: "verified", evidence: "ledger-sha256" });
  });

  it("verifies against the manifest hash while its version token still holds", () => {
    expect(
      verifyDownloadedObject(good, {
        size: good.length,
        etag: '"deadbeefcafe0000-3"',
        manifestSha256: sha256(good),
        manifestEtag: "deadbeefcafe0000-3",
      }),
    ).toEqual({ kind: "verified", evidence: "manifest-sha256" });
  });

  it("does NOT use the manifest hash once the remote version token changed", () => {
    const verdict = verifyDownloadedObject(good, {
      size: good.length,
      etag: '"changed0000000000-4"',
      manifestSha256: sha256("something else"),
      manifestEtag: "deadbeefcafe0000-3",
    });
    expect(verdict.kind).toBe("unverified");
    if (verdict.kind === "unverified") {
      expect(verdict.reason).toContain("version token changed");
    }
  });

  it("reports a multipart-ETag object with no other evidence as UNVERIFIED, not verified", () => {
    const verdict = verifyDownloadedObject(good, {
      size: good.length,
      etag: '"deadbeefcafe0000-3"',
    });
    expect(verdict.kind).toBe("unverified");
    if (verdict.kind === "unverified") {
      expect(verdict.reason).toContain("multipart");
    }
  });

  it("reports a no-ETag, no-evidence object as UNVERIFIED (fresh machine, legacy record)", () => {
    const verdict = verifyDownloadedObject(good, { size: good.length });
    expect(verdict.kind).toBe("unverified");
    if (verdict.kind === "unverified") {
      expect(verdict.reason).toContain("no ETag");
    }
  });
});

describe("pull end to end against an S3-shaped store (S3-PULL-INTEGRITY-001)", () => {
  it("push publishes the checksum ledger next to the data", async () => {
    const nsRoot = path.join(root, "src");
    seedNamespace(path.join(nsRoot, NS));

    const stats = await pushNamespace(CFG, NS, nsRoot);

    expect(stats.uploaded).toBe(2); // data files only — the ledger is metadata
    expect(stats.checksumLedger).toBe("pushed");
    const raw = fake.objects.get(ledgerKey(CFG, NS));
    expect(raw).toBeDefined();
    const ledger = JSON.parse(raw!.body.toString("utf-8"));
    expect(ledger.version).toBe(1);
    expect(ledger.ns).toBe(NS);
    expect(Object.keys(ledger.files).sort()).toEqual(
      ["event/2026-11/current.jsonl", "notes.md"],
    );
    // The ledger hash is the hash of the bytes actually uploaded.
    expect(ledger.files["notes.md"].sha256).toBe(
      sha256(fs.readFileSync(path.join(nsRoot, NS, "notes.md"))),
    );
  });

  it("a failed ledger publish is a FAILED push, not a silent gap", async () => {
    const nsRoot = path.join(root, "src");
    seedNamespace(path.join(nsRoot, NS));
    fake.failPutKeys.add(ledgerKey(CFG, NS));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const stats = await pushNamespace(CFG, NS, nsRoot);

    expect(stats.checksumLedger).toBe("absent");
    expect(stats.failed).toBe(1);
    expect(stats.failures[0].relPath).toBe(LEDGER_REL_PATH);
  });

  it("clean restore into an empty root: every object verified", async () => {
    const srcRoot = path.join(root, "src");
    seedNamespace(path.join(srcRoot, NS));
    await pushNamespace(CFG, NS, srcRoot);
    fs.rmSync(srcRoot, { recursive: true, force: true });

    const dstRoot = path.join(root, "dst");
    const stats = await pullNamespace(CFG, NS, dstRoot);

    expect(stats.failed).toBe(0);
    expect(stats.downloaded).toBe(2);
    expect(stats.verified).toBe(2);
    expect(stats.unverified).toBe(0);
    expect(stats.checksumLedger).toBe("present");
    expect(
      fs.readFileSync(
        path.join(dstRoot, NS, "event", "2026-11", "current.jsonl"),
        "utf-8",
      ),
    ).toContain('"k":"a"');
  });

  it("REPRODUCES + REFUSES: a same-length remote overwrite never reaches the restored tree", async () => {
    const srcRoot = path.join(root, "src");
    seedNamespace(path.join(srcRoot, NS));
    await pushNamespace(CFG, NS, srcRoot);

    // The fault the negative control injects: overwrite one object with
    // same-length garbage. The bucket re-derives the ETag from the new bytes,
    // so the object is self-consistent to every md5 check.
    const rel = "event/2026-11/current.jsonl";
    const key = `${NS_PREFIX}${rel}`;
    const stored = fake.objects.get(key)!;
    const garbage = Buffer.from(stored.body);
    for (let i = 0; i < garbage.length; i++) garbage[i] ^= 0xff;
    fake.objects.set(key, { body: garbage, etag: `"${md5(garbage)}"` });
    expect(garbage.length).toBe(stored.body.length);

    fs.rmSync(srcRoot, { recursive: true, force: true });
    const dstRoot = path.join(root, "dst");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });

    const stats = await pullNamespace(CFG, NS, dstRoot);

    // FALSIFIER: pre-fix code wrote the file and reported "0 failed".
    expect(stats.failed).toBe(1);
    expect(stats.failures[0].key).toBe(key);
    expect(stats.failures[0].kind).toBe("verification");
    expect(stats.failures[0].detail).toContain("ledger-sha256");
    expect(stats.downloaded).toBe(1); // only the intact object was restored
    expect(fs.existsSync(path.join(dstRoot, NS, rel))).toBe(false);
    // The intact file still restores — the run is partial, not aborted.
    expect(fs.readFileSync(path.join(dstRoot, NS, "notes.md"), "utf-8")).toBe(
      "# hermes\n",
    );
    // The failure is LOUD and names the object key.
    expect(errors.join("\n")).toContain(key);
    expect(errors.join("\n")).toContain("integrity");
  });

  it("a transfer error is counted and named (it used to be a console.warn only)", async () => {
    const srcRoot = path.join(root, "src");
    seedNamespace(path.join(srcRoot, NS));
    await pushNamespace(CFG, NS, srcRoot);
    fs.rmSync(srcRoot, { recursive: true, force: true });
    fake.failGetKeys.add(`${NS_PREFIX}notes.md`);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const stats = await pullNamespace(CFG, NS, path.join(root, "dst"));

    expect(stats.failed).toBe(1);
    expect(stats.failures[0]).toMatchObject({
      key: `${NS_PREFIX}notes.md`,
      kind: "transfer",
    });
  });

  it("a namespace pushed before the ledger existed restores as UNVERIFIED and says so", async () => {
    // Simulate legacy/pre-ledger data: objects on the wire, no ledger object.
    fake.objects.set(`${NS_PREFIX}notes.md`, {
      body: Buffer.from("# hermes\n"),
      etag: undefined, // no ETag on the wire at all → no evidence
    });
    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    });

    const stats = await pullNamespace(CFG, NS, path.join(root, "dst"));

    expect(stats.failed).toBe(0);
    expect(stats.downloaded).toBe(1); // a restore must still run on an empty machine
    expect(stats.unverified).toBe(1);
    expect(stats.checksumLedger).toBe("absent");
    expect(stats.unverifiedKeys).toEqual([`${NS_PREFIX}notes.md`]);
    expect(warns.join("\n")).toContain("NO checksum evidence");
  });

  it("an unreadable ledger is reported and never silently trusted", async () => {
    fake.objects.set(ledgerKey(CFG, NS), {
      body: Buffer.from('{"version":1,"ns":"hermes","files":{"notes.md":'),
      etag: undefined,
    });
    fake.objects.set(`${NS_PREFIX}notes.md`, {
      body: Buffer.from("# hermes\n"),
      etag: undefined,
    });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const stats = await pullNamespace(CFG, NS, path.join(root, "dst"));

    expect(stats.checksumLedger).toBe("absent");
    expect(stats.unverified).toBe(1);
    expect(errors.join("\n")).toContain("not a usable ledger");
  });

  it("the ledger object is never restored as if it were namespace data", async () => {
    const srcRoot = path.join(root, "src");
    seedNamespace(path.join(srcRoot, NS));
    await pushNamespace(CFG, NS, srcRoot);
    fs.rmSync(srcRoot, { recursive: true, force: true });

    const dstRoot = path.join(root, "dst");
    await pullNamespace(CFG, NS, dstRoot);

    expect(fs.existsSync(path.join(dstRoot, NS, ".s3state"))).toBe(false);
  });
});

describe("sync all pull — a per-object failure is a namespace failure", () => {
  it("aggregate reports the namespace as failed (it used to print 0 failed)", async () => {
    const srcRoot = path.join(root, "src");
    seedNamespace(path.join(srcRoot, NS));
    await pushNamespace(CFG, NS, srcRoot);

    const rel = "event/2026-11/current.jsonl";
    const key = `${NS_PREFIX}${rel}`;
    const stored = fake.objects.get(key)!;
    const garbage = Buffer.from(stored.body);
    for (let i = 0; i < garbage.length; i++) garbage[i] ^= 0xff;
    fake.objects.set(key, { body: garbage, etag: `"${md5(garbage)}"` });
    fs.rmSync(srcRoot, { recursive: true, force: true });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await syncAllNamespacesResult(CFG, path.join(root, "dst"), "pull");

    expect(result.attempted).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.failures[0].namespace).toBe(NS);
    expect(result.failures[0].error).toContain(key);
  });
});
