import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  defaultEvidenceDir,
  runCrashAttribution,
  type CommandResult,
} from "./crash-attribution";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-crash-attribution-"));
}

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SERVICE_RESULT: "signal",
    EXIT_CODE: "dumped",
    EXIT_STATUS: "11",
    INVOCATION_UNIT: "duckbrain-http.service",
    HOME: "/home/tester",
    ...overrides,
  };
}

function successfulProbe(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: "" };
}

describe("crash attribution", () => {
  it("clean exit is a no-op and returns zero", () => {
    const evidenceDir = tempDir();
    const result = runCrashAttribution({
      env: env({ SERVICE_RESULT: "success", EXIT_CODE: "exited", EXIT_STATUS: "0" }),
      evidenceDir,
    });

    expect(result).toEqual({
      exitCode: 0,
      captured: false,
      classification: "clean",
      detail: "clean exit; no crash evidence written",
    });
    expect(fs.readdirSync(evidenceDir)).toEqual([]);
  });

  it.each([
    ["signal environment", env()],
    ["dumped exit", env({ SERVICE_RESULT: "failed", EXIT_CODE: "dumped" })],
  ])("records %s as a signal crash", (_name, crashEnv) => {
    const evidenceDir = tempDir();
    const result = runCrashAttribution({
      env: crashEnv,
      evidenceDir,
      now: new Date("2026-11-15T12:34:56.789Z"),
      deps: {
        runCommand: () => successfulProbe("MemoryPeak=4294967296\nMemorySwapPeak=9663676416\n"),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.captured).toBe(true);
    expect(result.classification).toBe("signal");
    expect(result.bundlePath).toMatch(/2026-11-15T123456Z-duckbrain-http\.service$/);
    expect(fs.existsSync(path.join(result.bundlePath as string, "evidence.json"))).toBe(true);
  });

  it("captures non-zero exits with stable timestamped bundle content", () => {
    const evidenceDir = tempDir();
    const result = runCrashAttribution({
      env: env({ SERVICE_RESULT: "exit-code", EXIT_CODE: "exited", EXIT_STATUS: "2" }),
      evidenceDir,
      now: new Date("2026-11-15T01:02:03.000Z"),
      deps: {
        runCommand: (command, args) =>
          successfulProbe(
            command === "systemctl"
              ? "MemoryPeak=4294967296\nMemorySwapPeak=9663676416\nMemoryHigh=6442450944\nMemoryMax=8589934592\n"
              : `${command} ${args.join(" ")}`,
          ),
      },
    });

    expect(result.classification).toBe("non-zero");
    expect(result.bundlePath).toMatch(/2026-11-15T010203Z-duckbrain-http\.service$/);
    const evidence = fs.readFileSync(path.join(result.bundlePath as string, "evidence.json"), "utf8");
    expect(evidence).toContain('"classification": "non-zero"');
    expect(evidence).toContain("MemoryPeak=4294967296");
    expect(evidence).toContain("MemoryHigh=6442450944");
    expect(evidence).toContain("MemoryMax=8589934592");
  });

  it("records a failing external command without throwing", () => {
    const evidenceDir = tempDir();
    const result = runCrashAttribution({
      env: env(),
      evidenceDir,
      deps: {
        runCommand: (command) => ({
          ok: false,
          stdout: "partial output",
          stderr: "probe failed",
          error: `${command}: exit status 1`,
        }),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.captured).toBe(true);
    const evidence = fs.readFileSync(path.join(result.bundlePath as string, "evidence.json"), "utf8");
    expect(evidence).toContain('"ok": false');
    expect(evidence).toContain("probe failed");
  });

  it("uses XDG_STATE_HOME and otherwise falls back to the user state home", () => {
    expect(defaultEvidenceDir({ XDG_STATE_HOME: "/var/lib/test", HOME: "/home/tester" })).toBe(
      "/var/lib/test/duckbrain/crash-evidence",
    );
    expect(defaultEvidenceDir({ HOME: "/home/tester" })).toBe(
      "/home/tester/.local/state/duckbrain/crash-evidence",
    );
  });
});

describe("systemd deployment asset", () => {
  const root = path.resolve(__dirname, "..", "..");
  const unitPath = path.join(root, "ops", "systemd", "duckbrain-http.service");

  it("keeps the production memory discipline and crash capture wiring", () => {
    const unit = fs.readFileSync(unitPath, "utf8");
    expect(unit).toContain("MemoryHigh=6442450944");
    expect(unit).toContain("MemoryMax=8589934592");
    expect(unit).toContain("--max-old-space-size=3072");
    expect(unit).toContain("--report-on-fatalerror");
    expect(unit).toContain("--report-directory=%h/.local/state/duckbrain/crash-evidence");
    expect(unit).toMatch(/^ExecStopPost=-.*crash-attribution\.js$/m);
  });

  it("quotes every Environment= value that contains a space", () => {
    // systemd splits Environment= on spaces: an unquoted multi-flag value is
    // silently truncated to its first assignment and every later flag is
    // dropped with "Invalid environment assignment, ignoring" (verified with
    // `systemd-analyze verify`). A quoted single assignment is the only form
    // that actually delivers all the V8 report flags to the daemon.
    const unit = fs.readFileSync(unitPath, "utf8");
    const nodeOptions = unit
      .split("\n")
      .filter((line) => line.startsWith("Environment=") && line.includes("NODE_OPTIONS="));
    expect(nodeOptions).toHaveLength(1);
    expect(nodeOptions[0]).toMatch(/^Environment="NODE_OPTIONS=[^"]+"$/);

    for (const line of unit.split("\n")) {
      if (!line.startsWith("Environment=")) continue;
      const value = line.slice("Environment=".length);
      if (!/\s/.test(value)) continue;
      expect(value).toMatch(/^"/);
    }
  });
});
