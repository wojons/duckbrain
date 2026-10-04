/**
 * S3-ALERT-002 regression tests: `s3 sync all push` must TERMINATE even when
 * one namespace's push cannot finish.
 *
 * Measured prod failure (2026-10-04): the `scheduler` namespace held a
 * ~46k-file delta (next largest: ~2.4k); pushNamespace uploads strictly
 * sequentially with NO per-namespace bound, so every 3600s wrapper run died
 * mid-scheduler (rc=124 "FAIL sync-all-deadline") and the next run redid the
 * identical delta — backup never advanced past 09-30 and the sync lock changed
 * hands via stale-clear every ~2h15m. Now each namespace gets its own
 * wall-clock deadline: a namespace that exceeds it is abandoned with a LOUD
 * error, the pass CONTINUES with the remaining namespaces, the lock is
 * released, every failed namespace is reported by name, and the CLI exits
 * nonzero so the cron wrapper reports the failure.
 *
 * Isolation: the ./client module is mocked with an in-memory object store
 * (same vi.mock pattern as cli-pull-df092507.test.ts) — no network, no AWS
 * SDK. The "slow" namespace blocks on a 15s unref'd upload timer that the
 * deadline race abandons; the short timer never pins the vitest event loop.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { S3Client } from "@aws-sdk/client-s3";
import type { RemoteObject } from "./client";
import {
  syncAllNamespacesDetailed,
  syncAllNamespaces,
  syncNamespace,
  acquireLock,
  releaseLock,
  namespaceDeadlineMs,
} from "./sync";
import { s3Sync } from "./cli";
import { DEFAULT_S3_CONFIG, type S3Config } from "./config";

/** In-memory object store + controllable put delays (mutable per test). */
const fake = vi.hoisted(() => {
  const FAKE_CLIENT = { __fakeS3Client: true } as unknown;
  const objects = new Map<string, { size: number; body: Buffer }>();
  /** Key suffix → artificial putObject delay in ms (0 = immediate). */
  const putDelays = new Map<string, number>();
  return { FAKE_CLIENT, objects, putDelays };
});

vi.mock("./client", () => ({
  buildClient: (): S3Client => fake.FAKE_CLIENT as S3Client,
  listRemoteObjects: async (
    _client: S3Client,
    _bucket: string,
    prefix: string,
  ): Promise<Map<string, RemoteObject>> => {
    const out = new Map<string, RemoteObject>();
    for (const [key, obj] of fake.objects) {
      if (key.startsWith(prefix)) out.set(key, { key, size: obj.size });
    }
    return out;
  },
  getObject: async (
    _client: S3Client,
    _bucket: string,
    key: string,
  ): Promise<Buffer> => {
    const obj = fake.objects.get(key);
    if (!obj) throw new Error(`NoSuchKey: ${key}`);
    return obj.body;
  },
  putObject: async (
    _client: S3Client,
    _bucket: string,
    key: string,
    body: Buffer,
  ): Promise<void> => {
    const hit = [...fake.putDelays.entries()].find(([suffix]) =>
      key.endsWith(suffix),
    );
    if (hit && hit[1] > 0) {
      // AWAIT the timer: the upload must be genuinely in-flight (a promise
      // that stays pending) so the deadline race has something to abandon.
      // unref: an abandoned upload must never hold the vitest event loop
      // open for the full artificial delay.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, hit[1]);
        t.unref?.();
      });
    }
    fake.objects.set(key, { size: body.length, body });
  },
  deleteObject: async (): Promise<void> => {},
}));

let tmp: string;
let nsRoot: string;
let envSnapshot: Record<string, string | undefined>;

const ENV_KEYS = [
  "DUCKBRAIN_CONFIG_PATH",
  "DUCKBRAIN_NAMESPACES_PATH",
  "S3_SYNC_ALL_DEADLINE_S",
] as const;

function cfg(): S3Config {
  return {
    ...DEFAULT_S3_CONFIG,
    enabled: true,
    bucket: "duckbrain",
    prefix: "duckbrain",
  };
}

function mkns(name: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(nsRoot, name, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf-8");
  }
}

function captureConsole(): {
  logs: string[];
  errors: string[];
  warnings: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map((x) => String(x)).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map((x) => String(x)).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    warnings.push(a.map((x) => String(x)).join(" "));
  });
  return { logs, errors, warnings };
}

/** Write an enabled-s3 config file and point DUCKBRAIN_* env at this test's dirs. */
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
  process.env.DUCKBRAIN_NAMESPACES_PATH = nsRoot;
}

beforeEach(() => {
  envSnapshot = Object.fromEntries(
    ENV_KEYS.map((k) => [k, process.env[k]]),
  ) as Record<string, string | undefined>;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s3alert002-"));
  nsRoot = path.join(tmp, "namespaces");
  fs.mkdirSync(nsRoot, { recursive: true });
  fake.objects.clear();
  fake.putDelays.clear();
  delete process.env.S3_SYNC_ALL_DEADLINE_S;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = envSnapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.exitCode = 0; // CLI failure paths set this — never leak into the worker
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("namespaceDeadlineMs (env parsing)", () => {
  it("defaults to 1800s when the env var is unset", () => {
    delete process.env.S3_SYNC_ALL_DEADLINE_S;
    expect(namespaceDeadlineMs()).toBe(1_800_000);
  });

  it("reads whole seconds and disables on 0", () => {
    process.env.S3_SYNC_ALL_DEADLINE_S = "300";
    expect(namespaceDeadlineMs()).toBe(300_000);
    process.env.S3_SYNC_ALL_DEADLINE_S = "0";
    expect(namespaceDeadlineMs()).toBe(0);
  });

  it("falls back to the default on garbage or negative input", () => {
    process.env.S3_SYNC_ALL_DEADLINE_S = "banana";
    expect(namespaceDeadlineMs()).toBe(1_800_000);
    process.env.S3_SYNC_ALL_DEADLINE_S = "-5";
    expect(namespaceDeadlineMs()).toBe(1_800_000);
  });
});

describe("syncAllNamespacesDetailed (per-namespace deadline)", () => {
  it("abandons a namespace past its deadline, continues with the rest, and terminates", async () => {
    // Alphabetical iteration: the blocked namespace comes FIRST — the pass
    // must continue PAST a failed namespace (the old code hung right here
    // forever, so this ordering proves continuation, not just termination).
    mkns("aaa-blocked", { "event/stuck.jsonl": "stuck\n" });
    mkns("ok-later", { "event/current.jsonl": "fine\n" });
    fake.putDelays.set("stuck.jsonl", 15_000); // unref'd; raced out at 2s

    const cap = captureConsole();
    const { stats, failures } = await syncAllNamespacesDetailed(
      cfg(),
      nsRoot,
      "push",
      { perNsTimeoutMs: 2_000 },
    );

    expect(failures).toHaveLength(1);
    expect(failures[0].ns).toBe("aaa-blocked");
    expect(failures[0].error).toContain("deadline");
    expect(stats.map((s) => s.ns)).toEqual(["ok-later"]);
    expect(stats[0].uploaded).toBe(1);
    expect(cap.warnings.join("\n")).toContain(
      "aaa-blocked exceeded its 2s deadline",
    );
  }, 20_000);

  it("releases the sync lock when a namespace is abandoned", async () => {
    mkns("aaa-blocked", { "event/stuck.jsonl": "stuck\n" });
    fake.putDelays.set("stuck.jsonl", 15_000);

    captureConsole();
    await syncAllNamespacesDetailed(cfg(), nsRoot, "push", {
      perNsTimeoutMs: 1_000,
    });

    // The abandoned namespace's lock MUST be gone — a held lock would make
    // every later namespace (and the next pass) fail with "lock held".
    const probe = acquireLock(nsRoot);
    expect(probe).not.toBeNull();
    releaseLock(probe);
  }, 20_000);

  it("timeoutMs=0 keeps the old unbounded behavior (off switch)", async () => {
    mkns("slow-but-finite", { "event/current.jsonl": "eventually\n" });
    fake.putDelays.set("eventually.jsonl", 1_500);

    const stats = await syncNamespace(
      cfg(),
      "slow-but-finite",
      nsRoot,
      "push",
      {
        timeoutMs: 0,
      },
    );

    expect(stats).not.toBeNull();
    expect(stats!.uploaded).toBe(1);
  }, 15_000);

  it("a fully healthy pass reports zero failures", async () => {
    mkns("alpha", { "event/current.jsonl": "a\n" });
    mkns("beta", { "event/current.jsonl": "b\n" });

    const { stats, failures } = await syncAllNamespacesDetailed(
      cfg(),
      nsRoot,
      "push",
      { perNsTimeoutMs: 5_000 },
    );

    expect(failures).toEqual([]);
    expect(stats.map((s) => s.ns).sort()).toEqual(["alpha", "beta"]);
  });

  it("reads the deadline from S3_SYNC_ALL_DEADLINE_S when no explicit override", async () => {
    process.env.S3_SYNC_ALL_DEADLINE_S = "1";
    mkns("aaa-blocked", { "event/stuck.jsonl": "stuck\n" });
    fake.putDelays.set("stuck.jsonl", 15_000);

    const cap = captureConsole();
    const { failures } = await syncAllNamespacesDetailed(cfg(), nsRoot, "push");

    expect(failures).toHaveLength(1);
    expect(cap.warnings.join("\n")).toContain(
      "aaa-blocked exceeded its 1s deadline",
    );
  }, 20_000);
});

describe("s3Sync CLI exit code reflects namespace failures", () => {
  it("reports failed namespaces by name and exits nonzero while healthy ones still push", async () => {
    writeConfig();
    mkns("aaa-blocked", { "event/stuck.jsonl": "stuck\n" });
    mkns("ok-later", { "event/current.jsonl": "fine\n" });
    fake.putDelays.set("stuck.jsonl", 15_000);
    process.env.S3_SYNC_ALL_DEADLINE_S = "2";
    const cap = captureConsole();

    await s3Sync(".", "all", "push");

    const joinedLogs = cap.logs.join("\n");
    const joinedErrors = cap.errors.join("\n");
    // The healthy namespace still transferred...
    expect(joinedLogs).toContain(
      "[S3] push complete: 1 namespaces, 1 files transferred",
    );
    // ...and the failures are named, counted, and reflected in the exit code.
    expect(joinedErrors).toContain("aaa-blocked");
    expect(joinedErrors).toContain("1/2 namespace(s) failed this pass");
    expect(process.exitCode).toBe(1);
  }, 20_000);

  it("a clean pass exits zero", async () => {
    writeConfig();
    mkns("alpha", { "event/current.jsonl": "a\n" });
    captureConsole();

    await s3Sync(".", "all", "push");

    expect(process.exitCode).toBe(0);
  });

  it("the legacy syncAllNamespaces wrapper still returns plain stats (compat)", async () => {
    mkns("alpha", { "event/current.jsonl": "a\n" });
    captureConsole();

    const all = await syncAllNamespaces(cfg(), nsRoot, "push");

    expect(all.map((s) => s.ns)).toEqual(["alpha"]);
  });
});
