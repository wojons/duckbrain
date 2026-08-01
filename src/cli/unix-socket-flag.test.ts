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
 */

import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

const cliPath = path.join(process.cwd(), "bin", "duckbrain.js");

/**
 * Run the CLI and capture stdout/stderr until exit or timeout.
 */
function runCli(
  args: string[],
  timeoutMs = 4500,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, NO_COLOR: "1" },
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

describe("HTTP unix-socket flag (regression: flag collision)", () => {
  it("--unix-socket is NOT treated as a remote --socket connection", async () => {
    const tmpSock = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-cli-")),
      "test.sock",
    );

    // If the interceptor wrongly ate --unix-socket, the CLI would try to
    // reach a remote socket named "/tmp/.../test.sock" and fail fast with
    // "Socket not found" BEFORE starting an HTTP listener. Correct
    // behavior: the HTTP server starts and binds the socket.
    const { code, stderr, stdout } = await runCli(
      ["http", `--unix-socket=${tmpSock}`, "--port=0"],
      4500,
    );

    const combined = stdout + stderr;

    // It should NOT have errored with the remote-socket "not found" message
    expect(combined).not.toContain("Socket not found");
    expect(combined).not.toContain("Active sockets:");

    // It should have reached HTTP startup (either bound the socket, or
    // failed for an unrelated reason like port 0 / already-bound). The key
    // assertion: no remote-socket routing happened.
    expect(code).not.toBe(1);

    // Cleanup: the process may still be running (killed by timeout) —
    // remove any socket file it created.
    try {
      if (fs.existsSync(tmpSock)) fs.unlinkSync(tmpSock);
      fs.rmSync(path.dirname(tmpSock), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }, 20000);

  it("--unix-socket= with separate value form works", async () => {
    const tmpSock = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-cli-")),
      "separate.sock",
    );

    const { stderr, stdout } = await runCli(
      ["http", "--unix-socket", tmpSock, "--port=0"],
      4500,
    );
    const combined = stdout + stderr;

    expect(combined).not.toContain("Socket not found");
    expect(combined).not.toContain("Active sockets:");

    try {
      if (fs.existsSync(tmpSock)) fs.unlinkSync(tmpSock);
      fs.rmSync(path.dirname(tmpSock), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }, 20000);

  it("--unix-socket-mode and --unix-socket-group are accepted by the CLI", async () => {
    const tmpSock = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-cli-")),
      "mode.sock",
    );

    const { stderr, stdout } = await runCli(
      [
        "http",
        `--unix-socket=${tmpSock}`,
        "--unix-socket-mode=0660",
        "--unix-socket-group=nogroup",
        "--port=0",
      ],
      4500,
    );
    const combined = stdout + stderr;

    // Must not be routed to remote-socket machinery
    expect(combined).not.toContain("Active sockets:");

    try {
      if (fs.existsSync(tmpSock)) fs.unlinkSync(tmpSock);
      fs.rmSync(path.dirname(tmpSock), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }, 20000);
});
