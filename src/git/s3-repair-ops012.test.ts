/**
 * OPS-012 — hermetic tests for the in-daemon duplicate-bundle self-heal
 * (src/git/s3-repair.ts).
 *
 * No real S3, no network, no daemon, no touching namespaces/ or ~/.aws: the
 * S3 client is a scripted `{ send: vi.fn() }` dispatched per command
 * constructor (ListObjectsV2Command / CopyObjectCommand / HeadObjectCommand /
 * DeleteObjectCommand), and `hasCommit` is injected — except ONE scratch-repo
 * case that proves the DEFAULT hasCommit against a real `git init` repo in a
 * tmp dir.
 */

import { describe, it, expect, vi } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from "@aws-sdk/client-s3";

import {
  defaultHasCommit,
  isDuplicateRefPushError,
  parseS3RemoteUrl,
  repairAndRetryPushOnDuplicate,
  repairDuplicateRefBundles,
  type RepairParams,
} from "./s3-repair";

const TIP = "a".repeat(40);
const STALE = "b".repeat(40);
const THIRD = "c".repeat(40);

const KEY_PREFIX = "current/git/scheduler";
const REF_PREFIX = `${KEY_PREFIX}/refs/heads/master/`;

interface BundleSpec {
  sha: string;
  size: number;
  lastModified?: Date;
}

function bundleObject(b: BundleSpec): {
  Key: string;
  Size: number;
  LastModified?: Date;
} {
  return {
    Key: `${REF_PREFIX}${b.sha}.bundle`,
    Size: b.size,
    ...(b.lastModified ? { LastModified: b.lastModified } : {}),
  };
}

/** Recorded S3 command kinds, in order, with the key each acted on. */
type Calls = Array<{ op: string; key?: string; copySource?: string }>;

/**
 * Scripted fake client. `pages` are the ListObjectsV2 responses returned in
 * order (first list, then the re-verify list); copy/head/delete succeed by
 * default, head returns `headSize` (or the requested copy's source size).
 */
function scriptedClient(opts: {
  pages: Array<Array<Record<string, unknown>>>;
  headSize?: number;
  failOn?: "list" | "copy" | "head" | "delete";
}): { client: S3Client; calls: Calls } {
  const calls: Calls = [];
  let listCalls = 0;
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof ListObjectsV2Command) {
      calls.push({ op: "list" });
      if (opts.failOn === "list") throw new Error("simulated list failure");
      const page = opts.pages[Math.min(listCalls, opts.pages.length - 1)];
      listCalls++;
      return { Contents: page, NextContinuationToken: undefined };
    }
    if (cmd instanceof CopyObjectCommand) {
      calls.push({
        op: "copy",
        key: cmd.input.Key,
        copySource: cmd.input.CopySource,
      });
      if (opts.failOn === "copy") throw new Error("simulated copy failure");
      return {};
    }
    if (cmd instanceof HeadObjectCommand) {
      calls.push({ op: "head", key: cmd.input.Key });
      if (opts.failOn === "head") throw new Error("simulated head failure");
      return { ContentLength: opts.headSize ?? 0 };
    }
    if (cmd instanceof DeleteObjectCommand) {
      calls.push({ op: "delete", key: cmd.input.Key });
      if (opts.failOn === "delete") throw new Error("simulated delete failure");
      return {};
    }
    throw new Error("unexpected command");
  });
  return { client: { send } as unknown as S3Client, calls };
}

function baseParams(
  client: S3Client,
  over: Partial<RepairParams> = {},
): RepairParams {
  return {
    client,
    bucket: "duckbrain",
    keyPrefix: KEY_PREFIX,
    branch: "master",
    localTip: TIP,
    namespace: "scheduler",
    hasCommit: async () => true,
    log: () => {},
    ...over,
  };
}

describe("parseS3RemoteUrl", () => {
  it("returns null for non-s3 URLs", () => {
    expect(parseS3RemoteUrl("https://github.com/x/y.git")).toBeNull();
    expect(parseS3RemoteUrl("git@github.com:x/y.git")).toBeNull();
    expect(parseS3RemoteUrl("file:///tmp/bare.git")).toBeNull();
    expect(parseS3RemoteUrl("s3://")).toBeNull();
  });

  it("parses the live remote form", () => {
    expect(parseS3RemoteUrl("s3://duckbrain/current/git/scheduler")).toEqual({
      bucket: "duckbrain",
      keyPrefix: "current/git/scheduler",
    });
  });

  it("parses a bucket-only URL", () => {
    expect(parseS3RemoteUrl("s3://duckbrain")).toEqual({
      bucket: "duckbrain",
      keyPrefix: "",
    });
  });
});

describe("isDuplicateRefPushError", () => {
  it("is positive on the real journal text", () => {
    const journal =
      "Command failed: git push --set-upstream s3daily master\n" +
      "error: dst refspec refs/heads/master matches more than one";
    expect(isDuplicateRefPushError(journal)).toBe(true);
  });

  it("is negative on unrelated push errors", () => {
    expect(
      isDuplicateRefPushError(
        "Command failed: git push\nerror: failed to push some refs",
      ),
    ).toBe(false);
    expect(isDuplicateRefPushError("invalid credentials")).toBe(false);
    expect(isDuplicateRefPushError("")).toBe(false);
  });
});

describe("repairDuplicateRefBundles", () => {
  it("does nothing with 0 bundles", async () => {
    const { client, calls } = scriptedClient({ pages: [[]] });
    const result = await repairDuplicateRefBundles(baseParams(client));
    expect(result).toEqual({
      scanned: 0,
      quarantined: 0,
      skipped: 0,
      remaining: 0,
    });
    expect(calls.filter((c) => c.op !== "list")).toEqual([]);
  });

  it("does nothing with 1 bundle", async () => {
    const { client, calls } = scriptedClient({
      pages: [[bundleObject({ sha: TIP, size: 100 })]],
    });
    const result = await repairDuplicateRefBundles(baseParams(client));
    expect(result).toEqual({
      scanned: 1,
      quarantined: 0,
      skipped: 0,
      remaining: 1,
    });
    expect(calls.filter((c) => c.op !== "list")).toEqual([]);
  });

  it("keeps the local-tip match even when another bundle is newer", async () => {
    const stale = bundleObject({
      sha: STALE,
      size: 200,
      lastModified: new Date("2026-09-20T10:00:00Z"), // NEWER — must not win
    });
    const keeper = bundleObject({
      sha: TIP,
      size: 100,
      lastModified: new Date("2026-09-19T10:00:00Z"),
    });
    const { client, calls } = scriptedClient({
      pages: [
        [stale, keeper],
        [keeper], // after repair only the keeper remains
      ],
      headSize: 200,
    });
    const result = await repairDuplicateRefBundles(baseParams(client));
    expect(result).toEqual({
      scanned: 2,
      quarantined: 1,
      skipped: 0,
      remaining: 1,
    });

    const staleKey = `${REF_PREFIX}${STALE}.bundle`;
    const qkey = `quarantine/git/scheduler/master/${STALE}.bundle`;
    expect(calls).toContainEqual({
      op: "copy",
      key: qkey,
      copySource: encodeURIComponent(`duckbrain/${staleKey}`),
    });
    expect(calls).toContainEqual({ op: "head", key: qkey });
    expect(calls).toContainEqual({ op: "delete", key: staleKey });
    // The keeper is never copied or deleted.
    expect(
      calls.filter(
        (c) => c.op !== "list" && c.key === `${REF_PREFIX}${TIP}.bundle`,
      ),
    ).toEqual([]);
  });

  it("falls back to the newest LastModified when no bundle matches the tip", async () => {
    const older = bundleObject({
      sha: STALE,
      size: 200,
      lastModified: new Date("2026-09-19T10:00:00Z"),
    });
    const newer = bundleObject({
      sha: THIRD,
      size: 300,
      lastModified: new Date("2026-09-20T10:00:00Z"),
    });
    const { client, calls } = scriptedClient({
      pages: [[older, newer], [newer]],
      headSize: 200,
    });
    const logs: string[] = [];
    const result = await repairDuplicateRefBundles(
      baseParams(client, {
        localTip: "d".repeat(40), // matches no bundle
        log: (line) => logs.push(line),
      }),
    );
    expect(result).toEqual({
      scanned: 2,
      quarantined: 1,
      skipped: 0,
      remaining: 1,
    });
    // The OLDER bundle is quarantined; the newer one is the keeper.
    expect(calls).toContainEqual({
      op: "delete",
      key: `${REF_PREFIX}${STALE}.bundle`,
    });
    expect(calls.some((c) => c.key === `${REF_PREFIX}${THIRD}.bundle`)).toBe(
      false,
    );
    expect(logs.some((l) => l.includes("keeping the newest"))).toBe(true);
  });

  it("deletes nothing when no keeper can be identified", async () => {
    // No tip match and no LastModified on any object → abort.
    const a = bundleObject({ sha: STALE, size: 200 });
    const b = bundleObject({ sha: THIRD, size: 300 });
    const { client, calls } = scriptedClient({ pages: [[a, b]] });
    const logs: string[] = [];
    const result = await repairDuplicateRefBundles(
      baseParams(client, {
        localTip: "d".repeat(40),
        log: (line) => logs.push(line),
      }),
    );
    expect(result).toEqual({
      scanned: 2,
      quarantined: 0,
      skipped: 0,
      remaining: 2,
    });
    expect(calls.filter((c) => c.op !== "list")).toEqual([]);
    expect(logs.some((l) => l.includes("nothing deleted"))).toBe(true);
  });

  it("skips a stale bundle whose sha is NOT a local commit", async () => {
    const stale = bundleObject({ sha: STALE, size: 200 });
    const keeper = bundleObject({ sha: TIP, size: 100 });
    const { client, calls } = scriptedClient({
      pages: [
        [stale, keeper],
        [stale, keeper],
      ],
    });
    const logs: string[] = [];
    const result = await repairDuplicateRefBundles(
      baseParams(client, {
        hasCommit: async () => false,
        log: (line) => logs.push(line),
      }),
    );
    expect(result).toEqual({
      scanned: 2,
      quarantined: 0,
      skipped: 1,
      remaining: 2,
    });
    // Skipped BEFORE the quarantine copy — no copy, head, or delete at all.
    expect(calls.filter((c) => c.op !== "list")).toEqual([]);
    expect(logs.some((l) => l.includes("left alone"))).toBe(true);
  });

  it("does NOT delete the original when the quarantine size mismatches", async () => {
    const stale = bundleObject({ sha: STALE, size: 200 });
    const keeper = bundleObject({ sha: TIP, size: 100 });
    const { client, calls } = scriptedClient({
      pages: [
        [stale, keeper],
        [stale, keeper],
      ],
      headSize: 999, // != source size 200
    });
    const logs: string[] = [];
    const result = await repairDuplicateRefBundles(
      baseParams(client, { log: (line) => logs.push(line) }),
    );
    expect(result).toEqual({
      scanned: 2,
      quarantined: 0,
      skipped: 0,
      remaining: 2,
    });
    expect(calls.some((c) => c.op === "copy")).toBe(true);
    expect(calls.some((c) => c.op === "delete")).toBe(false);
    expect(logs.some((l) => l.includes("size mismatch"))).toBe(true);
  });

  it("excludes LOCK#/PROTECTED#/.zip//LOCKS//.lock keys from the bundle set", async () => {
    const valid = bundleObject({ sha: TIP, size: 100 });
    const excluded = [
      { Key: `${REF_PREFIX}LOCK#abc.bundle`, Size: 1 },
      { Key: `${REF_PREFIX}PROTECTED#abc.bundle`, Size: 1 },
      { Key: `${REF_PREFIX}abc.bundle.zip`, Size: 1 },
      { Key: `${REF_PREFIX}LOCKS/abc.bundle`, Size: 1 },
      { Key: `${REF_PREFIX}abc.lock`, Size: 1 },
      { Key: `${REF_PREFIX}not-a-bundle.txt`, Size: 1 },
    ];
    const { client, calls } = scriptedClient({
      pages: [[valid, ...excluded]],
    });
    const result = await repairDuplicateRefBundles(baseParams(client));
    // Only the one valid bundle counts → nothing to repair.
    expect(result).toEqual({
      scanned: 1,
      quarantined: 0,
      skipped: 0,
      remaining: 1,
    });
    expect(calls.filter((c) => c.op !== "list")).toEqual([]);
  });

  it("resolves without throwing when the list itself fails", async () => {
    const { client } = scriptedClient({ pages: [[]], failOn: "list" });
    const logs: string[] = [];
    const result = await repairDuplicateRefBundles(
      baseParams(client, { log: (line) => logs.push(line) }),
    );
    expect(result.scanned).toBe(-1);
    expect(result.quarantined).toBe(0);
    expect(logs.some((l) => l.includes("list failed"))).toBe(true);
  });
});

describe("repairAndRetryPushOnDuplicate", () => {
  it("runs the repair and retries the push exactly once (success)", async () => {
    const stale = bundleObject({ sha: STALE, size: 200 });
    const keeper = bundleObject({ sha: TIP, size: 100 });
    const { client, calls } = scriptedClient({
      pages: [[stale, keeper], [keeper]],
      headSize: 200,
    });
    const push = vi.fn(async () => "ok");
    const recovered = await repairAndRetryPushOnDuplicate({
      ...baseParams(client),
      push,
    });
    expect(recovered).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.op === "delete")).toBe(true);
  });

  it("returns false (never throws) when the retried push fails", async () => {
    const { client } = scriptedClient({ pages: [[]] });
    const logs: string[] = [];
    const recovered = await repairAndRetryPushOnDuplicate({
      ...baseParams(client, {
        log: (line) => logs.push(line),
      }),
      push: async () => {
        throw new Error("still broken");
      },
    });
    expect(recovered).toBe(false);
    expect(logs.some((l) => l.includes("retry"))).toBe(true);
  });
});

describe("defaultHasCommit (scratch repo)", () => {
  it("resolves true for a real commit and false for 40 zeros", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-ops012-"));
    try {
      const git = (args: string): string =>
        execSync(`git ${args}`, {
          cwd: dir,
          stdio: ["ignore", "pipe", "pipe"],
        })
          .toString()
          .trim();
      git("init");
      git("config user.email ops012@example.com");
      git("config user.name OPS-012");
      fs.writeFileSync(path.join(dir, "f.txt"), "ops-012\n");
      git("add f.txt");
      git("commit -m init");
      const sha = git("rev-parse HEAD");

      const hasCommit = defaultHasCommit(dir);
      await expect(hasCommit(sha)).resolves.toBe(true);
      await expect(hasCommit("0".repeat(40))).resolves.toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
