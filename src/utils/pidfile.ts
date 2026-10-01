/**
 * Per-instance pidfile path helper.
 *
 * Shared by `src/cli/http.ts` (daemon write/remove) and
 * `src/mcp/tools/server.ts` (`server_status` / `server_http_start`) so both
 * sides agree on the same filename for a given TCP port or Unix socket.
 *
 * Naming:
 *   - TCP-only instance on port N: `duckbrain-http-<N>.pid`
 *   - socket-only (or socket + port) instance: `duckbrain-http-<socket-basename>.pid`
 *
 * Directory precedence (highest first):
 *   1. the explicit `dir` argument (test pinning),
 *   2. `DUCKBRAIN_DATA_DIR` (operator/systemd override — unchanged semantics),
 *   3. a per-uid directory under the shared temp dir:
 *      `os.tmpdir()/duckbrain-<uid>`.
 *
 * The per-uid fallback (QA-DUCKBRAIN-002) replaces the old bare
 * `os.tmpdir()` fallback: on a multi-uid host a fixed name in a shared
 * directory can be owned by ANOTHER uid (bunker agents, containers,
 * root-run instances, a previous tenant's leaked instance), which blocked
 * pidfile bookkeeping with EACCES. Two uids can never collide on
 * `duckbrain-<uid>`, while one uid's leftovers behave exactly as before.
 * The directory is created best-effort (mode 0700) when the fallback is
 * resolved; if creation fails the write side degrades to its existing
 * best-effort warning instead of failing startup.
 */

import path from "path";
import os from "os";
import fs from "fs";

/** The uid of the running process (POSIX getuid, os.userInfo elsewhere). */
function runtimeUid(): number {
  if (typeof process.getuid === "function") return process.getuid();
  return os.userInfo().uid;
}

/**
 * The owner-isolated fallback pidfile directory: `os.tmpdir()/duckbrain-<uid>`.
 * Created best-effort with mode 0700; never throws.
 */
function perUidPidDir(): string {
  const dir = path.join(os.tmpdir(), `duckbrain-${runtimeUid()}`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Best-effort: the pidfile write itself is already non-fatal, so a
    // dir we could not create simply surfaces as that same warning.
  }
  return dir;
}

export function httpPidFilePath(
  port: number,
  socket?: string,
  dir?: string,
): string {
  const baseDir = dir || process.env.DUCKBRAIN_DATA_DIR || perUidPidDir();
  const suffix = socket ? path.basename(socket) : String(port);
  return path.join(baseDir, `duckbrain-http-${suffix}.pid`);
}

/**
 * Check whether a pid refers to a live process.
 *
 * `process.kill(pid, 0)` performs a signal-0 probe: no signal is delivered,
 * but the kernel reports whether the process exists. ESRCH means no such
 * process; EPERM means it exists but belongs to another user (still alive).
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove a stale pidfile left behind by a crashed previous instance.
 *
 * A pidfile whose PID is no longer alive (or whose content is unparseable)
 * describes a dead server and would shadow a fresh one, so it is unlinked
 * before a new instance writes its own pid. A pidfile whose PID IS alive is
 * left untouched — another live instance may own it. Best-effort: startup
 * must never fail because a stale pidfile could not be removed.
 */
export function cleanupStalePidFile(pidFile: string): void {
  try {
    if (!fs.existsSync(pidFile)) return;
    const raw = fs.readFileSync(pidFile, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) {
      return; // a live process owns this pidfile — leave it alone
    }
    fs.unlinkSync(pidFile);
    console.error(`[duckbrain] Removed stale pidfile: ${pidFile}`);
  } catch {
    // Best-effort cleanup — never crash startup over a stale pidfile.
  }
}
