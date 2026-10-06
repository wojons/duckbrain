// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * QA-DUCKBRAIN-004 — a lock root that IS the shared temp directory.
 *
 * Legacy test fixtures (queries.test.ts testPartition, autocommit.test.ts
 * makeTempNamespace, asof-ddl-compat.test.ts makeRepo) create their partitions
 * DIRECTLY under os.tmpdir(), so the DERIVED lock root is dirname(partition)
 * = the tmpdir itself and every lock lands in the fixed shared path
 * <tmpdir>/.duckbrain-write. On a multi-uid machine, once ANOTHER uid creates
 * that dir (mode 775, not writable by us), every acquire fails EACCES —
 * 41 tests / 9 files fail while green on single-user dev boxes.
 *
 * Contract under test: when the lock root is os.tmpdir(), the lock dir moves
 * OUT of the shared fixed path into a per-ns sibling dir
 * (<root>/.duckbrain-write-<ns>) — unique per fixture (mkdtemp suffix), so
 * it is always owned by the caller's uid and never shared cross-uid. It is a
 * SIBLING rather than a child of the namespace dir because tmpdir test
 * namespaces are git repos staged with `git add -A` while the lock is held.
 * Any other root (config-derived production roots, temp SUBdirs) keeps the
 * status-quo <root>/.duckbrain-write byte-for-byte.
 */
describe("QA-DUCKBRAIN-004: lock root at the shared temp dir", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The real legacy-arm derivation: partition under the tmpdir, lock root = dirname(partition). */
  function legacyRootFor(partition: string): string {
    return path.dirname(path.resolve(partition));
  }

  it("routes a tmpdir lock root to a per-ns sibling dir, not <tmpdir>/.duckbrain-write", () => {
    const partition = fs.mkdtempSync(path.join(os.tmpdir(), "test-memory-"));
    const callerDir = legacyRootFor(partition);
    try {
      const ns = path.basename(partition);
      const lockPath = namespaceWriteLockPath(callerDir, ns);

      expect(lockPath).not.toBe(
        path.join(os.tmpdir(), ".duckbrain-write", `${ns}.lock`),
      );
      // Inside the caller-owned per-ns sibling dir…
      expect(
        lockPath.startsWith(
          path.join(os.tmpdir(), `.duckbrain-write-${ns}`) + path.sep,
        ),
      ).toBe(true);
      expect(
        path.dirname(lockPath).endsWith(path.join(".duckbrain-write")),
      ).toBe(false);
      // …and never inside the namespace dir itself (git add -A sweeps it).
      expect(lockPath.startsWith(partition + path.sep)).toBe(false);
    } finally {
      fs.rmSync(partition, { recursive: true, force: true });
    }
  });

  it("acquires even when <tmpdir>/.duckbrain-write exists unwritable (multi-uid simulation)", () => {
    // Simulate another uid having created the shared lock dir first: a
    // private fake tmpdir whose .duckbrain-write is mode 555 — the same
    // EACCES a foreign-owned 775 dir produces for our open, without touching
    // the real /tmp/.duckbrain-write.
    const fakeTmp = fs.mkdtempSync(path.join(os.tmpdir(), "qa004-faketmp-"));
    const hostileDir = path.join(fakeTmp, ".duckbrain-write");
    fs.mkdirSync(hostileDir, { recursive: true });
    fs.chmodSync(hostileDir, 0o555);
    const spy = vi.spyOn(os, "tmpdir").mockReturnValue(fakeTmp);

    try {
      const lock = acquireNamespaceWriteLock(fakeTmp, "test-memory-multiuid");
      expect(lock).not.toBeNull();

      // The lock lives in the caller-owned per-ns sibling dir…
      const expected = path.join(
        fakeTmp,
        ".duckbrain-write-test-memory-multiuid",
        "test-memory-multiuid.lock",
      );
      expect(fs.existsSync(expected)).toBe(true);
      // …the hostile shared dir was never written…
      expect(fs.readdirSync(hostileDir)).toEqual([]);
      // …and the namespace dir itself was never touched.
      expect(fs.existsSync(path.join(fakeTmp, "test-memory-multiuid"))).toBe(
        false,
      );

      releaseNamespaceWriteLock(lock);
      expect(fs.existsSync(expected)).toBe(false);
    } finally {
      spy.mockRestore();
      fs.chmodSync(hostileDir, 0o755);
      fs.rmSync(fakeTmp, { recursive: true, force: true });
    }
  });

  it("gives two different tmpdir-rooted callers distinct lock dirs", () => {
    // Real derivation: each fixture's ns = basename(its own unique dir)
    // (legacy arm, autocommit identity, asof), so two partitions never share
    // an ns — and with the fix, never share a lock dir either.
    const partitionA = fs.mkdtempSync(path.join(os.tmpdir(), "qa004-root-a-"));
    const partitionB = fs.mkdtempSync(path.join(os.tmpdir(), "qa004-root-b-"));
    const rootA = legacyRootFor(partitionA);
    const rootB = legacyRootFor(partitionB);
    const nsA = path.basename(partitionA);
    const nsB = path.basename(partitionB);
    try {
      const pathA = namespaceWriteLockPath(rootA, nsA);
      const pathB = namespaceWriteLockPath(rootB, nsB);

      expect(pathA).not.toBe(pathB);
      // Each lock lives in its OWN per-ns sibling dir…
      expect(
        pathA.startsWith(
          path.join(os.tmpdir(), `.duckbrain-write-${nsA}`) + path.sep,
        ),
      ).toBe(true);
      expect(
        pathB.startsWith(
          path.join(os.tmpdir(), `.duckbrain-write-${nsB}`) + path.sep,
        ),
      ).toBe(true);
      // …so neither depends on the shared cross-uid directory.
      expect(
        pathA.startsWith(path.join(os.tmpdir(), ".duckbrain-write") + path.sep),
      ).toBe(false);
      expect(
        pathB.startsWith(path.join(os.tmpdir(), ".duckbrain-write") + path.sep),
      ).toBe(false);
    } finally {
      fs.rmSync(partitionA, { recursive: true, force: true });
      fs.rmSync(partitionB, { recursive: true, force: true });
    }
  });

  it("keeps the status-quo lock path for every non-tmpdir root (production-equivalence control)", () => {
    const prodRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qa004-prodroot-"));
    try {
      expect(namespaceWriteLockPath(prodRoot, "default")).toBe(
        path.join(path.resolve(prodRoot), ".duckbrain-write", "default.lock"),
      );
    } finally {
      fs.rmSync(prodRoot, { recursive: true, force: true });
    }
  });
});
