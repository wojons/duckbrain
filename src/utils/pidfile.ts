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
 * The directory is controlled by `DUCKBRAIN_DATA_DIR`, falling back to
 * `os.tmpdir()`.
 */

import path from "path";
import os from "os";
import fs from "fs";

export function httpPidFilePath(port: number, socket?: string): string {
  const baseDir = process.env.DUCKBRAIN_DATA_DIR || os.tmpdir();
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
