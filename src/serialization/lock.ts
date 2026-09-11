import crypto from "crypto";
import fs from "fs";
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

export function namespaceWriteLockPath(
  namespacesPath: string,
  ns: string,
): string {
  return path.join(
    path.resolve(namespacesPath),
    ".duckbrain-write",
    `${ns}.lock`,
  );
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
          JSON.stringify({ pid: process.pid, ts: Date.now(), nonce: token }),
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
