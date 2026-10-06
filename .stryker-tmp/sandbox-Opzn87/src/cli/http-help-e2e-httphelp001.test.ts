/**
 * HTTP-HELP-001 regression tests (e2e): `node bin/duckbrain.js http --help`
 * must print the http options block to STDOUT, exit 0, and NEVER attempt to
 * bind a port.
 *
 * Before the fix, the http command ignored --help/-h entirely and went
 * straight to startHttpMode — on a host already running a DuckBrain daemon
 * on :3000 that crashed with EADDRINUSE; on a free port it silently
 * STARTED a server when the operator only asked for help.
 *
 * The port-independent bind control is the startup banner: startHttpMode
 * prints "[duckbrain] HTTP server started at http://..." after ANY
 * successful bind and "PID written to:" after it, so their absence proves
 * no bind succeeded regardless of which port the args name, and
 * EADDRINUSE's absence proves none was attempted even on a host where
 * :3000 is busy (it is, in production). In-process seam coverage lives in
 * http-help-httphelp001.test.ts.
 */
// @ts-nocheck


import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import path from "path";

const cliPath = path.join(process.cwd(), "bin", "duckbrain.js");

/**
 * Run the CLI and capture stdout/stderr until exit or timeout.
 * (Same shape as unix-socket-flag.test.ts runCli.)
 */
function runCli(
  args: string[],
  timeoutMs = 15000,
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

describe("HTTP-HELP-001: http --help does not start the server (e2e)", () => {
  it("`http --help` prints usage to STDOUT and exits 0 without binding", async () => {
    const { code, stdout, stderr } = await runCli(["http", "--help"]);

    expect(code).toBe(0);
    // The options block, on STDOUT (help goes to stdout, not stderr).
    expect(stdout).toMatch(/Usage: duckbrain http/);
    expect(stdout).toContain("--port=");
    expect(stdout).toContain("--auth=");
    expect(stdout).toContain("--rate-limit=");
    expect(stdout).toContain("--unix-socket=");
    expect(stdout).toContain("--auth-file=");
    // Negative control: no bind attempt. On a busy :3000 a bind attempt
    // dies EADDRINUSE; on a free port it would print the startup banner.
    expect(stderr).not.toContain("EADDRINUSE");
    expect(stderr).not.toContain("HTTP server started at");
    expect(stderr).not.toContain("PID written to");
  }, 20000);

  it("bare `--help` anywhere in http args prints usage and exits 0", async () => {
    const { code, stdout, stderr } = await runCli([
      "http",
      "--port=8080",
      "--help",
    ]);

    expect(code).toBe(0);
    expect(stdout).toMatch(/Usage: duckbrain http/);
    expect(stderr).not.toContain("EADDRINUSE");
    expect(stderr).not.toContain("HTTP server started at");
    expect(stderr).not.toContain("PID written to");
  }, 20000);

  it("`http -h` prints usage and exits 0", async () => {
    const { code, stdout, stderr } = await runCli(["http", "-h"]);

    expect(code).toBe(0);
    expect(stdout).toMatch(/Usage: duckbrain http/);
    expect(stderr).not.toContain("HTTP server started at");
  }, 20000);
});
