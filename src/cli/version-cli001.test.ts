/**
 * CLI-VERSION-001 regression suite.
 *
 * `duckbrain --version` did not exist: the CLI had no version command, so the
 * remote update check (src/ssh/client.ts checkRemoteInstall) — which runs
 * `duckbrain --version` over SSH and parses /(\d+\.\d+\.\d+)/ from stdout —
 * always saw versionResult.status !== 0 and returned
 * `{installed: true, needsUpdate: false}` (silently "up to date" forever).
 * Its unit tests in src/ssh/client.test.ts mock the missing command, so they
 * keep passing either way.
 *
 * These tests drive the REAL CLI entry (`node bin/duckbrain.js`, the same path
 * the SSH check and the README use) and assert the output contract the parser
 * depends on. No mocks: a mocked spawnSync cannot see the missing command.
 */

import { describe, it, expect, vi } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const BIN_PATH = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");

/** The regex src/ssh/client.ts checkRemoteInstall uses to parse the version. */
const SSH_VERSION_RE = /(\d+\.\d+\.\d+)/;

function packageVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "..", "package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}

function runCli(
  args: string[],
  timeoutMs = 45_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      env: { ...process.env, NO_COLOR: "1" },
      cwd: process.cwd(),
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

describe("CLI-VERSION-001: `duckbrain --version`", () => {
  it("`--version` exits 0 and prints `duckbrain v<semver>`", async () => {
    const { code, stdout } = await runCli(["--version"]);
    expect(code).toBe(0);

    const line = stdout.trim();
    expect(line.startsWith("duckbrain v")).toBe(true);

    // The exact shape the SSH parser needs — it must extract the version.
    const match = line.match(SSH_VERSION_RE);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(packageVersion());
  });

  it("`-v` behaves identically to `--version`", async () => {
    const short = await runCli(["-v"]);
    const long = await runCli(["--version"]);

    expect(short.code).toBe(0);
    expect(short.stdout.trim()).toBe(long.stdout.trim());
    expect(short.stdout.trim().match(SSH_VERSION_RE)).not.toBeNull();
  });

  it("`--version` wins over `--socket=<name>` routing", async () => {
    // Before the fix a socket prefix routed to runRemoteCLI and the missing
    // socket aborted with exit 1 before any version output.
    const { code, stdout, stderr } = await runCli([
      "--socket=nonexistent-socket",
      "--version",
    ]);

    expect(code).toBe(0);
    expect(stdout.trim().match(SSH_VERSION_RE)?.[1]).toBe(packageVersion());
    expect(stderr).not.toContain("Socket 'nonexistent-socket' not found");
  });

  it("help output documents `--version`", async () => {
    const { code, stdout } = await runCli(["help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("--version");
  });
});
