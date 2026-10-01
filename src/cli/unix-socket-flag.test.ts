/**
 * Regression tests: `--unix-socket` flag must not collide with the
 * remote-CLI `--socket=<name>` interceptor.
 *
 * DuckBrain's CLI intercepts `--socket=NAME` at the top of main() to route
 * commands to a REMOTE DuckBrain over an SSH-tunnel Unix socket. When the
 * HTTP mode gained `--unix-socket=PATH` support, a naive `--socket` flag
 * would be swallowed by that interceptor (Bug: "Socket '/tmp/x.sock' not
 * found at ~/.duckbrain/sockets/..."). These tests pin the fix: the HTTP
 * subcommand must receive its own unix-socket flag untouched.
 *
 * Hermeticity: every spawned daemon gets its own DUCKBRAIN_DATA_DIR and
 * DUCKBRAIN_NAMESPACES_PATH (the pattern the sibling CLI suites use —
 * src/cli/http.test.ts, auth-file.test.ts, token-auth-file-dogfood026.test.ts).
 * Without DUCKBRAIN_DATA_DIR the pidfile falls back to the per-uid
 * `<tmpdir>/duckbrain-<uid>/duckbrain-http-<socket-basename>.pid`
 * (QA-DUCKBRAIN-002) — before that fix it was the SHARED
 * `<tmpdir>/duckbrain-http-<socket-basename>.pid`, so a leftover owned by
 * another user (a root-run instance, a container, a previous clean-machine
 * battery) made the daemon's pidfile write fail with EACCES. The daemon
 * treats that as non-fatal (see src/cli/http.ts) and this suite never
 * depends on it either way.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

const cliPath = path.join(process.cwd(), "bin", "duckbrain.js");

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI and capture stdout/stderr until exit or timeout.
 */
function runCli(
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CliRun> {
  const timeoutMs = opts.timeoutMs ?? 4500;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, NO_COLOR: "1", ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** A private scratch dir for one spawned daemon (socket + pidfile live here). */
function scratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-cli-"));
}

/**
 * Env that pins every daemon side effect (pidfile, namespace resolution)
 * inside the test's own scratch dir.
 */
function hermeticEnv(dir: string): Record<string, string> {
  return {
    DUCKBRAIN_DATA_DIR: dir,
    DUCKBRAIN_NAMESPACES_PATH: path.join(dir, "namespaces"),
  };
}

/** Remove the scratch dir (and any socket the killed daemon left behind). */
function cleanup(dir: string, sock: string): void {
  try {
    if (fs.existsSync(sock)) fs.unlinkSync(sock);
  } catch {
    // ignore
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe("HTTP unix-socket flag (regression: flag collision)", () => {
  it("--unix-socket is NOT treated as a remote --socket connection", async () => {
    const dir = scratchDir();
    const tmpSock = path.join(dir, "test.sock");

    // If the interceptor wrongly ate --unix-socket, the CLI would try to
    // reach a remote socket named "/tmp/.../test.sock" and fail fast with
    // "Socket not found" BEFORE starting an HTTP listener. Correct
    // behavior: the HTTP server starts and binds the socket.
    const { stderr, stdout } = await runCli(
      ["http", `--unix-socket=${tmpSock}`, "--port=0"],
      { env: hermeticEnv(dir) },
    );

    const combined = stdout + stderr;

    // It should NOT have errored with the remote-socket "not found" message
    expect(combined).not.toContain("Socket not found");
    expect(combined).not.toContain("Active sockets:");

    // It DID reach HTTP startup and consumed the flag as its own flag: both
    // banners prove the http subcommand ran, bound TCP, and bound THIS
    // socket path. This replaces the old `expect(code).not.toBe(1)` proxy,
    // which was wrong in both directions — ANY unrelated startup failure is
    // also exit 1 (a foreign-owned pidfile in the shared temp dir was
    // enough), while saying nothing about the flag reaching the HTTP path.
    expect(combined).toContain("HTTP server started at http://127.0.0.1:0");
    expect(combined).toContain(
      `HTTP server listening on Unix socket ${tmpSock}`,
    );
    expect(combined).not.toContain("Failed to start HTTP server");

    cleanup(dir, tmpSock);
  }, 20000);

  it("--unix-socket= with separate value form works", async () => {
    const dir = scratchDir();
    const tmpSock = path.join(dir, "separate.sock");

    const { stderr, stdout } = await runCli(
      ["http", "--unix-socket", tmpSock, "--port=0"],
      { env: hermeticEnv(dir) },
    );
    const combined = stdout + stderr;

    expect(combined).not.toContain("Socket not found");
    expect(combined).not.toContain("Active sockets:");
    // The separate-value spelling must reach the HTTP path too.
    expect(combined).toContain("HTTP server started at http://127.0.0.1:0");
    expect(combined).toContain(
      `HTTP server listening on Unix socket ${tmpSock}`,
    );
    expect(combined).not.toContain("Failed to start HTTP server");

    cleanup(dir, tmpSock);
  }, 20000);

  it("--unix-socket-mode and --unix-socket-group are accepted by the CLI", async () => {
    const dir = scratchDir();
    const tmpSock = path.join(dir, "mode.sock");

    const { stderr, stdout } = await runCli(
      [
        "http",
        `--unix-socket=${tmpSock}`,
        "--unix-socket-mode=0660",
        "--unix-socket-group=nogroup",
        "--port=0",
      ],
      { env: hermeticEnv(dir) },
    );
    const combined = stdout + stderr;

    // Must not be routed to remote-socket machinery
    expect(combined).not.toContain("Active sockets:");

    cleanup(dir, tmpSock);
  }, 20000);

  it("a pidfile that cannot be written does not take down the daemon", async () => {
    const dir = scratchDir();
    const tmpSock = path.join(dir, "blocked.sock");

    // The pidfile lives in DUCKBRAIN_DATA_DIR. Point it at a regular FILE so
    // the pidfile path is `<file>/duckbrain-http-*.pid` and the write fails
    // with ENOTDIR for every uid (a chmod-based refusal would be silently
    // bypassed by root, which is how the clean-machine battery runs). A
    // shared temp dir reaches the same state via a foreign-owned leftover
    // (EACCES). The TCP listener is already bound when the pidfile is
    // written, so this must degrade to a warning — never exit 1.
    const blockedDataDir = path.join(dir, "not-a-directory");
    fs.writeFileSync(blockedDataDir, "");

    const { stderr, stdout } = await runCli(
      ["http", `--unix-socket=${tmpSock}`, "--port=0"],
      { env: { ...hermeticEnv(dir), DUCKBRAIN_DATA_DIR: blockedDataDir } },
    );
    const combined = stdout + stderr;

    expect(combined).toContain("Could not write pidfile");
    expect(combined).toContain("HTTP server started at http://127.0.0.1:0");
    expect(combined).toContain(
      `HTTP server listening on Unix socket ${tmpSock}`,
    );
    expect(combined).not.toContain("Failed to start HTTP server");

    cleanup(dir, tmpSock);
  }, 20000);
});
