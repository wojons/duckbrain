/**
 * DF-0925-07 regression tests: S3 pull restores a fresh machine.
 *
 * Measured dogfood failure (09-25), all three covered here:
 *  1. `s3 sync <ns> pull` into an EMPTY namespaces root threw
 *     "Namespace not found" — pull now BOOTSTRAPS the local dir (data-only;
 *     push keeps the hard throw).
 *  2. `s3 sync all pull` iterated LOCAL dirs and silently restored nothing on
 *     a fresh machine — pull mode now enumerates the REMOTE prefix
 *     (listRemoteNamespaces) and unions with local namespaces.
 *  3. The CLI pull summary now prints restored-vs-skipped per namespace and
 *     warns + exits nonzero when the remote prefix holds namespaces but
 *     NOTHING was restored (no silent zero).
 *
 * Isolation: the ./client module is mocked with an in-memory object store —
 * no network, no AWS SDK. The real syncNamespace / syncAllNamespaces /
 * s3Sync run against it. DUCKBRAIN_CONFIG_PATH / DUCKBRAIN_NAMESPACES_PATH
 * are snapshotted in beforeEach and restored in afterEach so no leakage
 * survives into other test files (tier1 re-runs the suite).
 */
// @ts-nocheck


import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { S3Client } from "@aws-sdk/client-s3";
import type { RemoteObject } from "./client";
import { syncNamespace, syncAllNamespaces, listRemoteNamespaces } from "./sync";
import { s3Sync } from "./cli";
import { DEFAULT_S3_CONFIG, type S3Config } from "./config";

/** In-memory object store shared by the ./client mock (mutable per test). */
const fake = vi.hoisted(() => {
  const FAKE_CLIENT = { __fakeS3Client: true } as unknown;
  const objects = new Map<string, { size: number; body: Buffer }>();
  return { FAKE_CLIENT, objects };
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
  putObject: async (): Promise<void> => {},
  deleteObject: async (): Promise<void> => {},
}));

let tmp: string;
let nsRoot: string;
let envSnapshot: Record<string, string | undefined>;

const ENV_KEYS = [
  "DUCKBRAIN_CONFIG_PATH",
  "DUCKBRAIN_NAMESPACES_PATH",
] as const;

function cfg(): S3Config {
  return {
    ...DEFAULT_S3_CONFIG,
    enabled: true,
    bucket: "duckbrain",
    prefix: "duckbrain",
  };
}

/** Seed a remote object under s3://duckbrain/<ns>/<relPath>. */
function seedRemote(ns: string, relPath: string, body: string): void {
  const key = `duckbrain/${ns}/${relPath}`;
  fake.objects.set(key, {
    size: Buffer.byteLength(body),
    body: Buffer.from(body),
  });
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "df092507-"));
  nsRoot = path.join(tmp, "namespaces");
  // Fresh machine: the namespaces root itself may not even exist yet.
  fs.mkdirSync(nsRoot, { recursive: true });
  fake.objects.clear();
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

describe("listRemoteNamespaces (remote prefix discovery)", () => {
  it("groups object keys by their first path segment under the prefix", async () => {
    seedRemote("alpha", "event/2026-08/current.jsonl", "a\n");
    seedRemote("alpha", "manifest.json", "{}");
    seedRemote("beta", "config/x.jsonl", "b\n");
    seedRemote("beta", "manifest.json", "{}");

    const names = await listRemoteNamespaces(
      fake.FAKE_CLIENT as S3Client,
      cfg(),
    );
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("ignores bare prefix-level keys that carry no namespace payload", async () => {
    seedRemote("alpha", "event/current.jsonl", "a\n");
    // Key shapes that are NOT a restorable namespace: "<prefix>/<ns>" and
    // "<prefix>/<ns>/" with nothing below.
    fake.objects.set("duckbrain/lonely", { size: 3, body: Buffer.from("abc") });
    fake.objects.set("duckbrain/empty/", { size: 0, body: Buffer.alloc(0) });

    const names = await listRemoteNamespaces(
      fake.FAKE_CLIENT as S3Client,
      cfg(),
    );
    expect(names).toEqual(["alpha"]);
  });

  it("returns an empty list for an empty remote prefix", async () => {
    const names = await listRemoteNamespaces(
      fake.FAKE_CLIENT as S3Client,
      cfg(),
    );
    expect(names).toEqual([]);
  });
});

describe("syncNamespace bootstrap pull (empty local root)", () => {
  it("pull creates the missing namespace dir and downloads the files", async () => {
    seedRemote("alpha", "event/2026-08/current.jsonl", "line1\nline2\n");
    seedRemote("alpha", "manifest.json", "{}");
    expect(fs.existsSync(path.join(nsRoot, "alpha"))).toBe(false);

    const stats = await syncNamespace(cfg(), "alpha", nsRoot, "pull");

    expect(stats).not.toBeNull();
    expect(stats!.downloaded).toBe(2);
    expect(stats!.direction).toBe("pull");
    const pulled = fs.readFileSync(
      path.join(nsRoot, "alpha", "event/2026-08/current.jsonl"),
      "utf-8",
    );
    expect(pulled).toBe("line1\nline2\n");
    expect(fs.existsSync(path.join(nsRoot, "alpha", "manifest.json"))).toBe(
      true,
    );
  });

  it("pull bootstrap is data-only: no git history ships through S3 objects", async () => {
    seedRemote("alpha", "event/2026-08/current.jsonl", "a\n");
    await syncNamespace(cfg(), "alpha", nsRoot, "pull");
    // .git is excluded from sync by design — a restored namespace arrives
    // data-only. The README documents reinitializing tracking for it.
    expect(fs.existsSync(path.join(nsRoot, "alpha", ".git"))).toBe(false);
  });

  it("push on a missing namespace still throws and creates nothing", async () => {
    await expect(syncNamespace(cfg(), "ghost", nsRoot, "push")).rejects.toThrow(
      "Namespace not found: ghost",
    );
    expect(fs.existsSync(path.join(nsRoot, "ghost"))).toBe(false);
  });

  it("disabled config stays inert: no bootstrap, no dir", async () => {
    seedRemote("alpha", "event/current.jsonl", "a\n");
    const stats = await syncNamespace(
      { ...cfg(), enabled: false },
      "alpha",
      nsRoot,
      "pull",
    );
    expect(stats).toBeNull();
    expect(fs.existsSync(path.join(nsRoot, "alpha"))).toBe(false);
  });
});

describe("syncAllNamespaces pull mode (remote enumeration)", () => {
  it("restores remote namespaces into an EMPTY local root", async () => {
    seedRemote("alpha", "event/current.jsonl", "a\n");
    seedRemote("beta", "config/x.jsonl", "b\n");
    seedRemote("beta", "config/y.jsonl", "bb\n");

    const all = await syncAllNamespaces(cfg(), nsRoot, "pull");

    expect(all.map((s) => s.ns).sort()).toEqual(["alpha", "beta"]);
    const beta = all.find((s) => s.ns === "beta")!;
    expect(beta.downloaded).toBe(2);
    expect(
      fs.readFileSync(
        path.join(nsRoot, "alpha", "event/current.jsonl"),
        "utf-8",
      ),
    ).toBe("a\n");
    expect(fs.existsSync(path.join(nsRoot, "beta", "config/y.jsonl"))).toBe(
      true,
    );
  });

  it("unions remote namespaces with local-only dirs (nothing dropped)", async () => {
    seedRemote("alpha", "event/current.jsonl", "a\n");
    // A namespace that exists ONLY locally: pushable, not restorable — but it
    // must still be visited so an `all pull` can refresh remote deltas for it.
    fs.mkdirSync(path.join(nsRoot, "gamma"), { recursive: true });
    fs.writeFileSync(path.join(nsRoot, "gamma", "local-only.jsonl"), "g\n");

    const all = await syncAllNamespaces(cfg(), nsRoot, "pull");
    const byNs = new Map(all.map((s) => [s.ns, s]));

    expect(byNs.get("alpha")?.downloaded).toBe(1);
    expect(byNs.has("gamma")).toBe(true);
    expect(byNs.get("gamma")?.downloaded).toBe(0);
  });

  it("restores into an ABSENT namespaces root (truly fresh machine)", async () => {
    seedRemote("alpha", "event/current.jsonl", "a\n");
    fs.rmSync(nsRoot, { recursive: true, force: true });

    const all = await syncAllNamespaces(cfg(), nsRoot, "pull");

    expect(all.map((s) => s.ns)).toEqual(["alpha"]);
    expect(
      fs.readFileSync(
        path.join(nsRoot, "alpha", "event/current.jsonl"),
        "utf-8",
      ),
    ).toBe("a\n");
  });

  it("push mode keeps local-only enumeration and restores nothing", async () => {
    seedRemote("alpha", "event/current.jsonl", "a\n");
    // Empty local root + non-empty remote: push must NOT bootstrap and must
    // not explode — the old local-only walk is preserved for push.
    const all = await syncAllNamespaces(cfg(), nsRoot, "push");
    expect(all).toEqual([]);
    expect(fs.existsSync(path.join(nsRoot, "alpha"))).toBe(false);
  });
});

describe("s3Sync CLI pull summary (loud reporting)", () => {
  it("all pull on an empty root reports restored namespaces and per-ns counts", async () => {
    writeConfig();
    seedRemote("alpha", "event/current.jsonl", "a\n");
    seedRemote("beta", "config/x.jsonl", "b\n");
    const cap = captureConsole();

    await s3Sync(".", "all", "pull");

    const joined = cap.logs.join("\n");
    expect(joined).toContain(
      "[S3] pull complete: 2 namespaces, 2 files transferred",
    );
    expect(joined).toContain("[S3] pull alpha: downloaded=1");
    expect(joined).toContain("[S3] pull beta: downloaded=1");
  });

  it("all pull restoring 0 with a non-empty remote warns and exits nonzero", async () => {
    writeConfig();
    // Remote listing succeeds but EVERY per-namespace sync throws → nothing
    // is restored. The realistic all-throw path: another process holds the
    // sync lock (syncNamespace throws "another sync is in progress").
    seedRemote("alpha", "event/current.jsonl", "a\n");
    const lockDir = path.join(nsRoot, ".s3state");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, ".lock"),
      JSON.stringify({ pid: process.pid, ts: Date.now() }),
    );
    const cap = captureConsole();
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => code as never) as never);

    await s3Sync(".", "all", "pull");

    expect(cap.errors.join("\n")).toContain(
      "exist on S3 but ALL failed to restore",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    // The warning must be visible even though the "complete" line printed.
    expect(cap.logs.join("\n")).toContain("0 namespaces, 0 files transferred");
  });

  it("a fully in-sync re-run restores 0 files but does NOT warn", async () => {
    writeConfig();
    seedRemote("alpha", "event/current.jsonl", "a\n");
    // First pull restores the data...
    await syncNamespace(cfg(), "alpha", nsRoot, "pull");
    const cap = captureConsole();
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => code as never) as never);

    // ...second pull is a no-op (skipped, not failed): no warning, no exit.
    await s3Sync(".", "all", "pull");

    expect(cap.errors.join("\n")).not.toContain("failed to restore");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(cap.logs.join("\n")).toContain("0 files transferred");
  });

  it("single-ns pull on an empty root bootstraps via the CLI path", async () => {
    writeConfig();
    seedRemote("alpha", "event/current.jsonl", "a\n");
    const cap = captureConsole();

    await s3Sync(".", "alpha", "pull");

    expect(cap.logs.join("\n")).toContain(
      "pull alpha: uploaded=0 downloaded=1",
    );
    expect(
      fs.readFileSync(
        path.join(nsRoot, "alpha", "event/current.jsonl"),
        "utf-8",
      ),
    ).toBe("a\n");
  });
});
