// @ts-nocheck
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { isPidAlive } from "../utils/pidfile";
import type { FencingToken } from "./types";

export const LOCK_STALE_MS = 10 * 60 * 1000;

interface LockPayload {
  pid: number;
  ts: number;
  nonce: string;
}

export interface NamespaceWriteLock {
  path: string;
  token: FencingToken;
  ns: string;
  namespacesPath: string;
}

/**
 * Optional subsystem tag inside the lock payload. Written by the commit path
 * (`owner: "commit"`) so lock payloads are attributable in diagnostics; the
 * same-process flush/commit ordering itself is enforced by the in-process
 * commit gate below, not by this field.
 */
export type NamespaceLockOwner = "commit";

/**
 * QA-DUCKBRAIN-004: legacy test fixtures create their partitions directly
 * under os.tmpdir(), so the derived lock root IS the shared temp directory
 * and every lock lands in the fixed cross-process path
 * <tmpdir>/.duckbrain-write. On a multi-uid machine, once another uid has
 * created that dir (mode 775), every acquire fails EACCES. Those roots are
 * never the config-derived production root (which lives under the repo, or
 * is a temp SUBdirectory via DUCKBRAIN_NAMESPACES_PATH), so only the
 * exact-tmpdir case is rerouted. The rerouted dir embeds the (unique) ns
 * name as a SIBLING of the namespace dir rather than a child of it: tmpdir
 * test namespaces can be git repos, and the commit path stages with
 * `git add -A` while holding this very lock — a lock dir inside the repo
 * would sweep itself into every commit. `<tmpdir>/.duckbrain-write-<ns>` is
 * unique per fixture (mkdtemp suffix), so no cross-uid sharing is possible
 * and production behavior stays byte-identical.
 */
function isSharedTempRoot(root: string): boolean {
  return path.resolve(root) === path.resolve(os.tmpdir());
}

function lockDirFor(namespacesPath: string, ns: string): string {
  if (isSharedTempRoot(namespacesPath)) {
    return path.join(path.resolve(namespacesPath), `.duckbrain-write-${ns}`);
  }
  return path.join(path.resolve(namespacesPath), ".duckbrain-write");
}

export function namespaceWriteLockPath(
  namespacesPath: string,
  ns: string,
): string {
  return path.join(lockDirFor(namespacesPath, ns), `${ns}.lock`);
}

export interface NamespaceWriteLockPayload {
  pid: number;
  ts: number;
  nonce: string;
  owner?: NamespaceLockOwner;
}

/**
 * Read and validate the CURRENT lock payload for a namespace (null when no
 * lock file exists or its content is corrupt). Used by a waiter to decide
 * whether the live holder is one it can cooperate with.
 */
export function readNamespaceWriteLockPayload(
  namespacesPath: string,
  ns: string,
): NamespaceWriteLockPayload | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(namespaceWriteLockPath(namespacesPath, ns), "utf-8"),
    ) as unknown;
    return validPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validPayload(value: unknown): value is LockPayload {
  if (value === null || typeof value !== "object") return false;
  const payload = value as Partial<LockPayload>;
  return (
    Number.isInteger(payload.pid) &&
    (payload.pid as number) > 0 &&
    Number.isFinite(payload.ts) &&
    typeof payload.nonce === "string" &&
    /^[a-f0-9]{32}$/.test(payload.nonce)
  );
}

function shouldBreak(lockPath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    return true;
  }

  try {
    const payload = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as unknown;
    if (validPayload(payload)) {
      if (!isPidAlive(payload.pid)) return true;
      return Date.now() - payload.ts > LOCK_STALE_MS;
    }
  } catch {
    // Corrupt content uses file age below; it cannot be attributed to a pid.
  }
  return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
}

/** Atomic wx acquire with dead-pid recovery and stale-owner preemption. */
export function acquireNamespaceWriteLock(
  namespacesPath: string,
  ns: string,
  owner?: NamespaceLockOwner,
): NamespaceWriteLock | null {
  const lockPath = namespaceWriteLockPath(namespacesPath, ns);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 4; attempt++) {
    const token = crypto.randomBytes(16).toString("hex");
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            ts: Date.now(),
            nonce: token,
            ...(owner ? { owner } : {}),
          }),
        );
      } finally {
        fs.closeSync(fd);
      }
      return {
        path: lockPath,
        token,
        ns,
        namespacesPath: path.resolve(namespacesPath),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!shouldBreak(lockPath)) return null;
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT")
          return null;
      }
    }
  }
  return null;
}

/** Re-read the nonce immediately before writing to fence preempted owners. */
export function tokenStillCurrent(
  namespacesPath: string,
  ns: string,
  token: FencingToken,
): boolean {
  try {
    const payload = JSON.parse(
      fs.readFileSync(namespaceWriteLockPath(namespacesPath, ns), "utf-8"),
    ) as unknown;
    return validPayload(payload) && payload.nonce === token;
  } catch {
    return false;
  }
}

/** Release only the token we acquired; an old owner cannot unlink a successor. */
export function releaseNamespaceWriteLock(
  lock: NamespaceWriteLock | null,
): void {
  if (!lock) return;
  if (!tokenStillCurrent(lock.namespacesPath, lock.ns, lock.token)) return;
  try {
    fs.unlinkSync(lock.path);
  } catch {
    // Already removed or preempted.
  }
}
