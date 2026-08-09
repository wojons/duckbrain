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

export function httpPidFilePath(port: number, socket?: string): string {
  const baseDir = process.env.DUCKBRAIN_DATA_DIR || os.tmpdir();
  const suffix = socket ? path.basename(socket) : String(port);
  return path.join(baseDir, `duckbrain-http-${suffix}.pid`);
}
