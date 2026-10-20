/**
 * S3-CLI-001 — `s3 sync all` exit-code contract.
 *
 * The aggregate is exercised end-to-end against the real engine in
 * sync-all-aggregate-s3cli001.test.ts; this suite pins the CLI's exit
 * arithmetic and output for the cases that would take minutes to reproduce
 * with a real failing wire (N failing namespaces):
 *   - 0 failed            → exit 0 (process.exit NOT called)
 *   - 1 failed            → exit 1
 *   - several failed      → exit = failed count
 *   - many failed         → exit = 125 (capped; 126+ is shell-reserved)
 * and, in every failure case, the summary counts plus the failed-namespace
 * list with each error message.
 *
 * The ./sync module is mocked to return a crafted aggregate — the CLI handler
 * is the unit under test here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { s3Sync } from "./cli";
import { DEFAULT_S3_CONFIG } from "./config";

const state = vi.hoisted(() => ({
  report: {
    stats: [] as unknown[],
    attempted: 0,
    succeeded: 0,
    failed: 0,
    failures: [] as { namespace: string; error: string }[],
  },
}));

vi.mock("./client", () => ({
  buildClient: () => ({}),
  listRemoteObjects: async () => new Map(),
}));

vi.mock("./sync", () => ({
  walkLocal: () => new Map(),
  syncNamespace: async () => null,
  listRemoteNamespaces: async () => [],
  syncAllNamespaces: async () => state.report.stats,
  syncAllNamespacesResult: async () => state.report,
}));

let tmp: string;
let envSnapshot: Record<string, string | undefined>;

const ENV_KEYS = ["DUCKBRAIN_CONFIG_PATH", "DUCKBRAIN_NAMESPACES_PATH"] as const;

function writeConfig(): void {
  const cfgFile = path.join(tmp, "duckbrain.config.json");
  fs.writeFileSync(
    cfgFile,
    JSON.stringify(
      {
        s3: {
          ...DEFAULT_S3_CONFIG,
          enabled: true,
          bucket: "duckbrain",
          prefix: "duckbrain",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  process.env.DUCKBRAIN_CONFIG_PATH = cfgFile;
  process.env.DUCKBRAIN_NAMESPACES_PATH = path.join(tmp, "namespaces");
}

function captureConsole(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map((x) => String(x)).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map((x) => String(x)).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return { logs, errors };
}

/** Craft a report with `failed` failures and `succeeded` successes. */
function report(succeeded: number, failures: { namespace: string; error: string }[]) {
  return {
    stats: [],
    attempted: succeeded + failures.length,
    succeeded,
    failed: failures.length,
    failures,
  };
}

beforeEach(() => {
  envSnapshot = Object.fromEntries(
    ENV_KEYS.map((k) => [k, process.env[k]]),
  ) as Record<string, string | undefined>;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s3cli001-exit-"));
  writeConfig();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = envSnapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("s3 sync all exit codes (S3-CLI-001)", () => {
  it("all success: 0 failed, exit 0 (process.exit not called)", async () => {
    state.report = report(3, []);
    const cap = captureConsole();
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => code as never) as never);

    await s3Sync(".", "all", "push");

    expect(cap.logs.join("\n")).toContain(
      "Sync complete: 3 attempted, 3 succeeded, 0 failed",
    );
    expect(cap.errors.join("\n")).not.toContain("Failed namespaces");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("one failure: summary shows 1 failed, namespace + error listed, exit 1", async () => {
    state.report = report(2, [{ namespace: "beta", error: "putObject 403" }]);
    const cap = captureConsole();
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => code as never) as never);

    await s3Sync(".", "all", "push");

    expect(cap.logs.join("\n")).toContain(
      "Sync complete: 3 attempted, 2 succeeded, 1 failed",
    );
    const stderr = cap.errors.join("\n");
    expect(stderr).toContain("Failed namespaces (1):");
    expect(stderr).toContain("beta: putObject 403");
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("multiple failures: exit code equals the failure count", async () => {
    state.report = report(1, [
      { namespace: "a", error: "boom-a" },
      { namespace: "b", error: "boom-b" },
      { namespace: "c", error: "boom-c" },
    ]);
    const cap = captureConsole();
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => code as never) as never);

    await s3Sync(".", "all", "push");

    expect(cap.logs.join("\n")).toContain(
      "Sync complete: 4 attempted, 1 succeeded, 3 failed",
    );
    const stderr = cap.errors.join("\n");
    expect(stderr).toContain("Failed namespaces (3):");
    for (const ns of ["a", "b", "c"]) {
      expect(stderr).toContain(`  ${ns}: boom-${ns}`);
    }
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("many failures: exit code is capped at 125 and every failure is listed", async () => {
    const failures = Array.from({ length: 200 }, (_, i) => ({
      namespace: `ns-${i}`,
      error: `err-${i}`,
    }));
    state.report = report(0, failures);
    const cap = captureConsole();
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => code as never) as never);

    await s3Sync(".", "all", "push");

    expect(cap.logs.join("\n")).toContain(
      "Sync complete: 200 attempted, 0 succeeded, 200 failed",
    );
    const listed = cap.errors.filter((l) => /^ {2}ns-\d+: err-\d+$/.test(l));
    expect(listed).toHaveLength(200);
    expect(exitSpy).toHaveBeenCalledWith(125);
  });
});
