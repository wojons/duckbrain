/**
 * S3-PULL-INTEGRITY-001 — the CLI must exit nonzero and NAME the object when a
 * pull could not restore it.
 *
 * `s3 sync <ns> pull` (the single-namespace form the restore runbook and the
 * proof script use) used to print the counters and return 0 no matter what the
 * per-object result was, because per-object failures never left the engine.
 * The engine unit is covered against a real object store in
 * pull-verify-s3pull001.test.ts; here the CLI handler is the unit under test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { s3Sync } from "./cli";
import { DEFAULT_S3_CONFIG } from "./config";

const state = vi.hoisted(() => ({
  stats: {
    ns: "hermes",
    direction: "pull" as const,
    uploaded: 0,
    downloaded: 1,
    skipped: 0,
    durationMs: 12,
    verified: 0,
    unverified: 0,
    unverifiedKeys: [] as string[],
    failed: 0,
    failures: [] as {
      ns: string;
      key: string;
      relPath: string;
      kind: "transfer" | "verification";
      detail: string;
    }[],
    checksumLedger: "present" as const,
  },
}));

vi.mock("./client", () => ({
  buildClient: () => ({}),
  listRemoteObjects: async () => new Map(),
}));

vi.mock("./sync", () => ({
  walkLocal: () => new Map(),
  syncNamespace: async () => state.stats,
  listRemoteNamespaces: async () => [],
  syncAllNamespaces: async () => [],
  syncAllNamespacesResult: async () => ({
    stats: [],
    attempted: 0,
    succeeded: 0,
    failed: 0,
    failures: [],
  }),
}));

let tmp: string;
const ENV_KEYS = ["DUCKBRAIN_CONFIG_PATH", "DUCKBRAIN_NAMESPACES_PATH"] as const;
let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = Object.fromEntries(
    ENV_KEYS.map((k) => [k, process.env[k]]),
  ) as Record<string, string | undefined>;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s3pull001-cli-"));
  const cfgFile = path.join(tmp, "duckbrain.config.json");
  fs.writeFileSync(
    cfgFile,
    JSON.stringify({
      s3: { ...DEFAULT_S3_CONFIG, enabled: true, bucket: "duckbrain", prefix: "duckbrain" },
    }),
    "utf-8",
  );
  process.env.DUCKBRAIN_CONFIG_PATH = cfgFile;
  process.env.DUCKBRAIN_NAMESPACES_PATH = path.join(tmp, "namespaces");
  state.stats = {
    ...state.stats,
    failed: 0,
    failures: [],
    downloaded: 1,
  };
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

describe("s3 sync <ns> pull exit code (S3-PULL-INTEGRITY-001)", () => {
  it("clean pull: counters printed, exit 0 (process.exit not called)", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => code as never) as never);

    await s3Sync(".", "hermes", "pull");

    expect(logs.join("\n")).toContain("verified=0 unverified=0 failed=0");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("a rejected object exits 1 and names the key", async () => {
    state.stats = {
      ...state.stats,
      downloaded: 0,
      verified: 0,
      failed: 1,
      failures: [
        {
          ns: "hermes",
          key: "duckbrain/hermes/event/2026-11/current.jsonl",
          relPath: "event/2026-11/current.jsonl",
          kind: "verification",
          detail: "ledger-sha256: sha256 abc != ledger def",
        },
      ],
    };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => code as never) as never);

    await s3Sync(".", "hermes", "pull");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain(
      "duckbrain/hermes/event/2026-11/current.jsonl",
    );
    expect(errors.join("\n")).toContain("verification");
  });
});
