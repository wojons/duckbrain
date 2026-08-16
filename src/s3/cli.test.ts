/**
 * Regression tests for `duckbrain s3` CLI usage/error semantics (DB-GAP-029):
 * - `--help` / `-h` print usage to stdout and exit 0
 * - bare `duckbrain s3` prints usage (NOT the status subcommand) and exits 0
 * - unknown subcommand writes an error to stderr and exits nonzero
 *
 * Spawns the real CLI (bin/duckbrain.js → tsx → bin/duckbrain.ts) so the
 * asserted exit codes are the actual process exit codes — the same pattern
 * as src/cli/unix-socket-flag.test.ts. The usage/error paths never read S3
 * config, so these tests are isolated from real S3.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import path from "path";

const cliPath = path.join(process.cwd(), "bin", "duckbrain.js");

/**
 * Run the CLI and capture stdout/stderr until exit or timeout.
 */
function runCli(
  args: string[],
  timeoutMs = 10000,
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

describe("duckbrain s3 CLI usage and errors (DB-GAP-029)", () => {
  it("--help prints usage to stdout and exits 0", async () => {
    const { code, stdout } = await runCli(["s3", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("duckbrain s3 status");
    expect(stdout).toContain("duckbrain s3 sync");
    expect(stdout).toContain("duckbrain s3 query");
    expect(stdout).toContain("duckbrain s3 config");
  }, 20000);

  it("-h prints usage to stdout and exits 0", async () => {
    const { code, stdout } = await runCli(["s3", "-h"]);
    expect(code).toBe(0);
    expect(stdout).toContain("duckbrain s3 status");
    expect(stdout).toContain("duckbrain s3 query");
  }, 20000);

  it("bare invocation prints usage (not status) and exits 0", async () => {
    const { code, stdout } = await runCli(["s3"]);
    expect(code).toBe(0);
    expect(stdout).toContain("duckbrain s3 status");
    // Must NOT fall through to the status subcommand's output.
    expect(stdout).not.toContain("S3 config:");
  }, 20000);

  it("unknown subcommand writes an error to stderr and exits nonzero", async () => {
    const { code, stderr } = await runCli(["s3", "bogus"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown s3 subcommand: bogus");
  }, 20000);
});
