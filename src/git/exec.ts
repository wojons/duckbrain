/**
 * Bounded ASYNC git runner for HTTP-serving paths (OPS-007).
 *
 * OPS-006 removed the synchronous child spawns from the namespace write path
 * (see `autocommit.ts`); OPS-007 removes the two that were still reachable
 * from an HTTP handler:
 *
 *  - `src/mcp/tools/namespace.ts` — `execSync("git init")` in
 *    `createNamespaceTool` (POST /api/namespaces).
 *  - `src/http/routes/users.ts` — `execSync("git log --all --format=%aN")` in
 *    `getAuthorsFromGit` (GET /users), called once per namespace.
 *
 * `execFile` (never a shell) keeps argv unquoted-safe, and running it
 * asynchronously keeps the JS thread free so an unrelated cheap route (the
 * daemon's `/health`) is served while git works. Both call sites pass an
 * explicit `timeoutMs` and `maxBufferBytes`, so a hung or chatty git can
 * neither park the handler forever nor grow the response without bound.
 */

import { execFile } from "child_process";

export interface GitExecOptions {
  /** Finite per-git wall-clock bound. Callers must always pass one. */
  timeoutMs?: number;
  /** Hard cap on captured stdout/stderr (bounded output). */
  maxBufferBytes?: number;
  env?: NodeJS.ProcessEnv;
}

/** Default output bound when a caller does not name one (4 MiB). */
export const GIT_EXEC_DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * Run `git <args>` in `cwd` without blocking the event loop.
 *
 * Rejects on a non-zero exit, a timeout, or a maxBuffer overflow — every call
 * site is responsible for its own best-effort fallback (the namespace create
 * keeps its warning; GET /users keeps its DuckDB fallback).
 */
export function runGitAsync(
  args: string[],
  cwd: string,
  options: GitExecOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        ...(options.timeoutMs !== undefined
          ? { timeout: options.timeoutMs }
          : {}),
        ...(options.env ? { env: options.env } : {}),
        maxBuffer: options.maxBufferBytes ?? GIT_EXEC_DEFAULT_MAX_BUFFER_BYTES,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.toString());
      },
    );
  });
}
