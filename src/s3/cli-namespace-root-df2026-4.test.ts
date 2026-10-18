/**
 * DF-2026-4: every `duckbrain s3` verb must resolve the namespace storage root
 * from the CONFIG path (DUCKBRAIN_CONFIG_PATH, or the default/duckbrain-root
 * config), never from `process.cwd()`.
 *
 * Incident shape: `s3Command` passes `configDir = "."` and the local helper did
 * `path.resolve(".", cfg.namespacesPath)` — a relative `namespacesPath`
 * ("./namespaces") resolved against the CWD, so `duckbrain s3 status|sync`
 * launched from any other checkout looked at `<cwd>/namespaces`: status
 * reported local=0 / nothing registered and sync pushed-or-pulled the wrong
 * (usually absent) tree, silently.
 *
 * These tests run the real `s3Status` / `s3Sync` / `s3Command` entry points with
 * the process CWD parked in a foreign directory, and assert the CONFIG root is
 * what gets read and synced:
 *   1. `s3 status` counts the config-root namespace's files (pre-fix: local=0);
 *   2. `s3 status` writes nothing next to the caller;
 *   3. `s3 sync <ns> push` hands the config-root namespaces path to the sync
 *      engine (pre-fix: `<cwd>/namespaces`);
 *   4. the DUCKBRAIN_HOME_ROOT fallback (no DUCKBRAIN_CONFIG_PATH) resolves the
 *      same way — the "default config location" arm;
 *   5. an EXPLICIT configDir is still honored verbatim (embedders/tests);
 *   6. the same root reaches the `pushOnCommit` autocommit hook
 *      (src/s3/index.ts), which used to hand `cfg.namespacesPath` (relative)
 *      to the sync engine.
 *
 * Isolation: DUCKBRAIN_CONFIG_PATH / DUCKBRAIN_NAMESPACES_PATH / DUCKBRAIN_HOME_ROOT
 * and the CWD are snapshot-restored per test; ./client is mocked (no S3
 * requests) and ./sync is mocked only to CAPTURE the namespacesPath the CLI
 * hands it (the real walkLocal is kept so the status counts are real).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { s3Status, s3Sync, s3Command } from "./cli";
import { maybeSyncOnCommit } from "./index";
import { resolveDuckbrainRoot } from "../config";
import { DEFAULT_S3_CONFIG } from "./config";

// No network: the remote object listing is not what this suite measures.
vi.mock("./client", () => ({
  buildClient: () => ({}),
  listRemoteObjects: async () => new Map(),
}));

const captured = vi.hoisted(() => ({
  syncCalls: [] as Array<{
    ns: string;
    namespacesPath: string;
    direction: string;
  }>,
}));

vi.mock("./sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sync")>();
  return {
    ...actual,
    // Capture the resolved root the CLI passes; never touch the network.
    syncNamespace: async (
      _cfg: unknown,
      ns: string,
      namespacesPath: string,
      direction: "push" | "pull",
    ) => {
      captured.syncCalls.push({ ns, namespacesPath, direction });
      return {
        ns,
        direction,
        uploaded: 0,
        downloaded: 0,
        skipped: 0,
        durationMs: 0,
      };
    },
    syncAllNamespaces: async () => [],
  };
});

const ENV_KEYS = [
  "DUCKBRAIN_CONFIG_PATH",
  "DUCKBRAIN_NAMESPACES_PATH",
  "DUCKBRAIN_HOME_ROOT",
  "AWS_ENDPOINT_URL_S3",
  "AWS_ENDPOINT_URL",
] as const;

let envSnapshot: Record<string, string | undefined>;
let prevCwd: string;
let tmpDir: string;
let configRootDir: string;
let nsRoot: string;
let foreignCwd: string;

/** Write `<configRootDir>/duckbrain.config.json` (s3 enabled). */
function writeConfig(
  namespaceMappings: Record<string, string> = {},
  s3Overrides: Record<string, unknown> = {},
): string {
  const cfgFile = path.join(configRootDir, "duckbrain.config.json");
  fs.writeFileSync(
    cfgFile,
    JSON.stringify(
      {
        namespacesPath: "./namespaces",
        s3: {
          ...DEFAULT_S3_CONFIG,
          enabled: true,
          bucket: "probe-bucket",
          ...s3Overrides,
        },
        namespaceMappings,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return cfgFile;
}

/** Run `fn` and return the console.log lines it produced. */
async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await fn();
    return log.mock.calls.map((c) => c.join(" "));
  } finally {
    log.mockRestore();
  }
}

beforeEach(() => {
  envSnapshot = Object.fromEntries(
    ENV_KEYS.map((k) => [k, process.env[k]]),
  ) as Record<string, string | undefined>;
  prevCwd = process.cwd();
  captured.syncCalls.length = 0;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "df2026-4-"));
  configRootDir = path.join(tmpDir, "duckbrain-root");
  nsRoot = path.join(configRootDir, "namespaces");
  foreignCwd = path.join(tmpDir, "foreign-checkout");
  fs.mkdirSync(nsRoot, { recursive: true });
  fs.mkdirSync(foreignCwd, { recursive: true });

  // A real namespace next to the CONFIG: two syncable files.
  const nsDir = path.join(nsRoot, "ns-alpha");
  fs.mkdirSync(nsDir, { recursive: true });
  fs.writeFileSync(path.join(nsDir, "rows-a.jsonl"), '{"a":1}\n', "utf-8");
  fs.writeFileSync(path.join(nsDir, "rows-b.jsonl"), '{"b":2}\n', "utf-8");

  process.env.AWS_ENDPOINT_URL_S3 = "https://probe.invalid";
  delete process.env.AWS_ENDPOINT_URL;
  // Per-test isolation: drop the worker-wide redirects the global setup file
  // installs, so each test states exactly which config root it exercises.
  delete process.env.DUCKBRAIN_CONFIG_PATH;
  delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  delete process.env.DUCKBRAIN_HOME_ROOT;
});

afterEach(() => {
  process.chdir(prevCwd);
  for (const k of ENV_KEYS) {
    const v = envSnapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("DF-2026-4: s3 status resolves the namespace root from the config path", () => {
  it("counts the config-root namespace's files while the CWD is elsewhere", async () => {
    process.env.DUCKBRAIN_CONFIG_PATH = writeConfig({
      "ns-alpha": path.join(nsRoot, "ns-alpha"),
    });
    process.chdir(foreignCwd);

    const lines = await captureLogs(() => s3Status("."));

    const row = lines.find((l) => /^ {2}ns-alpha: local=/.test(l));
    expect(row).toBeDefined();
    // THE regression: pre-fix this read `<foreign-cwd>/namespaces/ns-alpha`
    // and reported local=0.
    expect(row).toContain("local=2");
    expect(row).not.toContain("(on-disk only");
  });

  it("never creates a namespaces tree next to the caller", async () => {
    process.env.DUCKBRAIN_CONFIG_PATH = writeConfig({});
    process.chdir(foreignCwd);

    await captureLogs(() => s3Status("."));

    expect(fs.existsSync(path.join(foreignCwd, "namespaces"))).toBe(false);
  });

  it("resolves the DEFAULT config location (DUCKBRAIN_HOME_ROOT) the same way", async () => {
    // No DUCKBRAIN_CONFIG_PATH: the root comes from the explicit install-root
    // knob — the arm a fresh invocation without a redirected config file uses.
    writeConfig({});
    process.env.DUCKBRAIN_HOME_ROOT = configRootDir;
    process.chdir(foreignCwd);

    const lines = await captureLogs(() => s3Status("."));

    // The root comes from the install-root knob, NOT the caller's cwd.
    expect(resolveDuckbrainRoot()).toBe(configRootDir);
    expect(lines.join("\n")).toContain("S3 config: ENABLED");
    const row = lines.find((l) => /^ {2}ns-alpha: local=/.test(l));
    expect(row).toBeDefined();
    expect(row).toContain("local=2");
  });
});

describe("DF-2026-4: s3 sync resolves the namespace root from the config path", () => {
  it("hands the config-root namespaces path to the sync engine", async () => {
    process.env.DUCKBRAIN_CONFIG_PATH = writeConfig({});
    process.chdir(foreignCwd);

    await captureLogs(() => s3Sync(".", "ns-alpha", "push"));

    expect(captured.syncCalls).toHaveLength(1);
    expect(captured.syncCalls[0].ns).toBe("ns-alpha");
    // THE regression: pre-fix this was `<foreign-cwd>/namespaces`.
    expect(captured.syncCalls[0].namespacesPath).toBe(nsRoot);
    expect(fs.existsSync(path.join(foreignCwd, "namespaces"))).toBe(false);
  });

  it("applies the same resolution through the s3Command dispatcher", async () => {
    process.env.DUCKBRAIN_CONFIG_PATH = writeConfig({});
    process.chdir(foreignCwd);

    await captureLogs(() => s3Command(["sync", "ns-alpha", "pull"]));

    expect(captured.syncCalls).toHaveLength(1);
    expect(captured.syncCalls[0].direction).toBe("pull");
    expect(captured.syncCalls[0].namespacesPath).toBe(nsRoot);
  });

  it("still honors an EXPLICIT configDir verbatim (embedders/tests)", async () => {
    // DUCKBRAIN_CONFIG_PATH must NOT hijack an explicitly supplied directory.
    delete process.env.DUCKBRAIN_CONFIG_PATH;
    const explicitRoot = path.join(tmpDir, "explicit-root");
    const explicitNs = path.join(explicitRoot, "ns-store");
    fs.mkdirSync(explicitNs, { recursive: true });
    fs.writeFileSync(
      path.join(explicitRoot, "duckbrain.config.json"),
      JSON.stringify(
        {
          namespacesPath: "./ns-store",
          s3: { ...DEFAULT_S3_CONFIG, enabled: true, bucket: "probe-bucket" },
        },
        null,
        2,
      ),
      "utf-8",
    );
    process.chdir(foreignCwd);

    await captureLogs(() => s3Sync(explicitRoot, "ns-alpha", "push"));

    expect(captured.syncCalls).toHaveLength(1);
    expect(captured.syncCalls[0].namespacesPath).toBe(explicitNs);
  });

  it("the pushOnCommit hook pushes from the config root, not the cwd", async () => {
    process.env.DUCKBRAIN_CONFIG_PATH = writeConfig({}, { pushOnCommit: true });
    process.chdir(foreignCwd);

    maybeSyncOnCommit(path.join(nsRoot, "ns-alpha"));
    // The hook defers to a zero-delay timer; let it run.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(captured.syncCalls).toHaveLength(1);
    expect(captured.syncCalls[0].ns).toBe("ns-alpha");
    // Pre-fix: `cfg.namespacesPath` (".../namespaces" relative) resolved
    // against the caller's cwd.
    expect(captured.syncCalls[0].namespacesPath).toBe(nsRoot);
  });
});
