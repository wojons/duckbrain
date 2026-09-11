import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  LOCK_STALE_MS,
  acquireNamespaceWriteLock,
  namespaceWriteLockPath,
  releaseNamespaceWriteLock,
  tokenStillCurrent,
} from "./lock";

describe("SUPA-2 namespace write lock", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-supa2-lock-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("has exactly one winner among 16 concurrent wx contenders", async () => {
    const contenders = await Promise.all(
      Array.from(
        { length: 16 },
        () =>
          new Promise<ReturnType<typeof acquireNamespaceWriteLock>>((resolve) =>
            setImmediate(() =>
              resolve(acquireNamespaceWriteLock(root, "alpha")),
            ),
          ),
      ),
    );
    const winners = contenders.filter((lock) => lock !== null);
    expect(winners).toHaveLength(1);
    releaseNamespaceWriteLock(winners[0]);
  });

  it("breaks a dead-pid lock immediately", () => {
    const lockPath = namespaceWriteLockPath(root, "alpha");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 2_147_483_647,
        ts: Date.now(),
        nonce: "a".repeat(32),
      }),
    );

    const lock = acquireNamespaceWriteLock(root, "alpha");
    expect(lock).not.toBeNull();
    expect(lock?.token).not.toBe("a".repeat(32));
    releaseNamespaceWriteLock(lock);
  });

  it("does not break a young lock held by a live pid", () => {
    const lockPath = namespaceWriteLockPath(root, "alpha");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        ts: Date.now(),
        nonce: "b".repeat(32),
      }),
    );
    expect(acquireNamespaceWriteLock(root, "alpha")).toBeNull();
  });

  it("breaks a stale lock even when its pid is live", () => {
    const lockPath = namespaceWriteLockPath(root, "alpha");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        ts: Date.now() - LOCK_STALE_MS - 1,
        nonce: "c".repeat(32),
      }),
    );
    const lock = acquireNamespaceWriteLock(root, "alpha");
    expect(lock).not.toBeNull();
    expect(lock?.token).not.toBe("c".repeat(32));
    releaseNamespaceWriteLock(lock);
  });

  it("keeps a corrupt lock busy until its file age is stale", () => {
    const lockPath = namespaceWriteLockPath(root, "alpha");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "not-json");
    expect(acquireNamespaceWriteLock(root, "alpha")).toBeNull();

    const stale = new Date(Date.now() - LOCK_STALE_MS - 1_000);
    fs.utimesSync(lockPath, stale, stale);
    const lock = acquireNamespaceWriteLock(root, "alpha");
    expect(lock).not.toBeNull();
    releaseNamespaceWriteLock(lock);
  });

  it("fences a stale owner after another contender re-acquires", () => {
    const first = acquireNamespaceWriteLock(root, "alpha");
    expect(first).not.toBeNull();
    const lockPath = namespaceWriteLockPath(root, "alpha");
    const payload = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ ...payload, ts: Date.now() - LOCK_STALE_MS - 1 }),
    );

    const second = acquireNamespaceWriteLock(root, "alpha");
    expect(second).not.toBeNull();
    expect(tokenStillCurrent(root, "alpha", first!.token)).toBe(false);
    expect(tokenStillCurrent(root, "alpha", second!.token)).toBe(true);

    releaseNamespaceWriteLock(first);
    expect(tokenStillCurrent(root, "alpha", second!.token)).toBe(true);
    releaseNamespaceWriteLock(second);
  });
});
