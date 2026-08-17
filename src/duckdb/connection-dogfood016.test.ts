/**
 * DOGFOOD-016 regression tests: crash-signal scratch cleanup + orphan sweep.
 *
 * Covered here:
 *  - sweepOrphanScratchFiles() removes only scratch db files whose embedded
 *    pid is dead; live-pid files (other fleet processes) are untouched.
 *  - A child process killed by SIGTERM cleans its own scratch files via the
 *    signal handlers registered at module init, and dies by the signal
 *    (default disposition restored — not swallowed).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import { sweepOrphanScratchFiles } from "./connection";

/**
 * Obtain a pid that is guaranteed dead: spawn a node child that exits
 * immediately and use its pid once the 'exit' event fired.
 */
function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    child.once("exit", () => resolve(child.pid ?? 2147483647));
  });
}

describe("DOGFOOD-016 orphan scratch sweep", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-dogfood016-sweep-"),
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes scratch db files whose embedded pid is dead, keeps live-pid files", async () => {
    const dead = await deadPid();
    const deadFile = path.join(tmpDir, `duckbrain-${dead}-deadbeef-0.db`);
    const liveFile = path.join(
      tmpDir,
      `duckbrain-${process.pid}-deadbeef-0.db`,
    );
    const nonDb = path.join(tmpDir, `duckbrain-${dead}-deadbeef-0.txt`);
    const unparsable = path.join(tmpDir, `duckbrain-notapid-deadbeef-0.db`);
    for (const f of [deadFile, liveFile, nonDb, unparsable]) {
      fs.writeFileSync(f, "x");
    }

    const removed = sweepOrphanScratchFiles(tmpDir);

    expect(fs.existsSync(deadFile)).toBe(false);
    expect(fs.existsSync(liveFile)).toBe(true);
    expect(fs.existsSync(nonDb)).toBe(true);
    expect(fs.existsSync(unparsable)).toBe(true);
    expect(removed).toBe(1);
  });

  it("is tolerant of a missing temp directory", () => {
    const missing = path.join(tmpDir, "does-not-exist");
    expect(() => sweepOrphanScratchFiles(missing)).not.toThrow();
    expect(sweepOrphanScratchFiles(missing)).toBe(0);
  });
});

describe("DOGFOOD-016 crash-signal scratch cleanup", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-dogfood016-signal-"),
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Wait for a marker on the child's stdout, surfacing any stderr output in
   * the failure message so import errors are diagnosable.
   */
  function waitForOutput(
    child: ChildProcess,
    marker: string,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        reject(
          new Error(
            `child did not print "${marker}" in time. stdout: ${out} stderr: ${err}`,
          ),
        );
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes(marker)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        err += chunk.toString();
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        reject(
          new Error(
            `child exited early with code ${code}. stdout: ${out} stderr: ${err}`,
          ),
        );
      });
    });
  }

  function waitForExit(
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("child did not exit in time"));
      }, timeoutMs);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  it("cleans this process's scratch files on SIGTERM and dies by the signal", async () => {
    const childScript = path.join(tmpDir, "signal-child.ts");
    // The child imports connection.ts (registering the exit + signal
    // handlers), then drops a fake scratch file and waits. TMPDIR is set to
    // the test dir so os.tmpdir() resolves there in the child.
    fs.writeFileSync(
      childScript,
      [
        'import fs from "fs";',
        'import os from "os";',
        'import path from "path";',
        `import ${JSON.stringify(path.resolve(__dirname, "connection.ts"))};`,
        'const file = path.join(os.tmpdir(), "duckbrain-" + process.pid + "-dogfood016-sig-0.db");',
        'fs.writeFileSync(file, "x");',
        'console.log("READY");',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );

    const child = spawn(process.execPath, ["--import", "tsx", childScript], {
      env: { ...process.env, TMPDIR: tmpDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const scratchFile = path.join(
      tmpDir,
      `duckbrain-${child.pid}-dogfood016-sig-0.db`,
    );

    try {
      await waitForOutput(child, "READY", 15000);
      expect(fs.existsSync(scratchFile)).toBe(true);

      child.kill("SIGTERM");
      const { code, signal } = await waitForExit(child, 15000);

      expect(fs.existsSync(scratchFile)).toBe(false);
      expect(code).toBeNull();
      expect(signal).toBe("SIGTERM");
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  });
});
