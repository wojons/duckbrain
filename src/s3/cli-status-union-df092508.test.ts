/**
 * DF-0925-08 (c): `duckbrain s3 status` must enumerate the UNION of the
 * config registry (`namespaceMappings`) and the on-disk namespaces root.
 *
 * Incident: a namespace created through the HTTP/MCP API exists as a
 * directory under the namespaces root with NO config mapping (the DB-GAP-057
 * registry split-brain shape). `s3Status` used to list the CONFIG keys
 * whenever any mapping existed and scanned the directory ONLY when that list
 * was empty — so such a namespace, which exists, accepts writes and is
 * actively pushed to S3, was invisible on its own status surface.
 *
 * What this suite pins:
 *   1. both halves are listed (config-registered + on-disk-only);
 *   2. a name present in both halves is listed exactly ONCE;
 *   3. an on-disk-only row is marked as unregistered (the cheap per-namespace
 *      backing state: it has a directory but no config mapping);
 *   4. an ABSENT namespaces root degrades gracefully — the config block and
 *      the config-registered namespaces still print, nothing throws (the
 *      census warns instead of failing).
 *
 * Isolation: `DUCKBRAIN_CONFIG_PATH` / `DUCKBRAIN_NAMESPACES_PATH` point at
 * temp dirs, and ./client is mocked so the per-namespace remote listing (not
 * what this suite measures) never performs an S3 request. Env vars are
 * snapshot/restored per test so no leakage reaches a sibling file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { s3Status, unionNamespaceList } from "./cli";
import { DEFAULT_S3_CONFIG } from "./config";

// No network: the remote object listing is not under test here.
vi.mock("./client", () => ({
  buildClient: () => ({}),
  listRemoteObjects: async () => new Map(),
}));

const ENV_KEYS = [
  "DUCKBRAIN_CONFIG_PATH",
  "DUCKBRAIN_NAMESPACES_PATH",
  "AWS_ENDPOINT_URL_S3",
  "AWS_ENDPOINT_URL",
] as const;

let envSnapshot: Record<string, string | undefined>;
let tmpDir: string;
let nsRoot: string;

beforeEach(() => {
  envSnapshot = Object.fromEntries(
    ENV_KEYS.map((k) => [k, process.env[k]]),
  ) as Record<string, string | undefined>;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "df092508-"));
  nsRoot = path.join(tmpDir, "namespaces");
  fs.mkdirSync(nsRoot, { recursive: true });
  process.env.DUCKBRAIN_NAMESPACES_PATH = nsRoot;
  // The endpoint line is printed from config; the client is mocked anyway.
  process.env.AWS_ENDPOINT_URL_S3 = "https://probe.invalid";
  delete process.env.AWS_ENDPOINT_URL;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = envSnapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Write the temp config file and pin DUCKBRAIN_CONFIG_PATH at it. */
function writeConfig(namespaceMappings: Record<string, string>): void {
  const cfgFile = path.join(tmpDir, "duckbrain.config.json");
  fs.writeFileSync(
    cfgFile,
    JSON.stringify(
      {
        s3: { ...DEFAULT_S3_CONFIG, enabled: true, bucket: "probe-bucket" },
        namespaceMappings,
      },
      null,
      2,
    ),
    "utf-8",
  );
  process.env.DUCKBRAIN_CONFIG_PATH = cfgFile;
}

/** Run s3Status(".") and return the captured log lines. */
async function statusLines(): Promise<string[]> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await s3Status(".");
  return log.mock.calls.map((c) => c.join(" "));
}

/** The per-namespace rows (`  <ns>: local=…`). */
function perNamespaceRows(lines: string[]): string[] {
  return lines.filter((l) => /^ {2}[^ ]+: local=/.test(l));
}

describe("DF-0925-08: s3 status lists the registry/census UNION", () => {
  it("lists config-registered AND on-disk-only namespaces, no duplicates", async () => {
    // (a) config-registered WITH a directory → healthy row.
    fs.mkdirSync(path.join(nsRoot, "cfg-ns"), { recursive: true });
    writeConfig({ "cfg-ns": path.join(nsRoot, "cfg-ns") });

    // (b) directory with NO mapping — the API-created namespace that used to
    // be invisible the moment any mapping existed.
    fs.mkdirSync(path.join(nsRoot, "disk-only-ns"), { recursive: true });

    // Noise the census must skip (hidden dir + a file).
    fs.mkdirSync(path.join(nsRoot, ".s3state"), { recursive: true });
    fs.writeFileSync(path.join(nsRoot, "stray.txt"), "not a namespace\n");

    const lines = await statusLines();
    const rows = perNamespaceRows(lines);

    const cfgRow = rows.filter((r) => /^ {2}cfg-ns: /.test(r));
    const diskRow = rows.filter((r) => /^ {2}disk-only-ns: /.test(r));

    // Both halves listed, exactly once each.
    expect(cfgRow).toHaveLength(1);
    expect(diskRow).toHaveLength(1);

    // The registered row carries no on-disk-only marker…
    expect(cfgRow[0]).not.toContain("on-disk only");
    // …while the unmapped directory is named as such (cheap backing state).
    expect(diskRow[0]).toContain("on-disk only");

    // Non-namespaces never appear.
    expect(rows.some((r) => r.includes(".s3state"))).toBe(false);
    expect(rows.some((r) => r.includes("stray.txt"))).toBe(false);
  });

  it("a name present in BOTH halves is listed exactly once (no duplicate)", async () => {
    fs.mkdirSync(path.join(nsRoot, "both"), { recursive: true });
    writeConfig({ both: path.join(nsRoot, "both") });

    const rows = perNamespaceRows(await statusLines());
    expect(rows.filter((r) => /^ {2}both: /.test(r))).toHaveLength(1);
  });

  it("still resolves an explicit namespace argument to just that namespace", async () => {
    writeConfig({ "cfg-ns": path.join(nsRoot, "cfg-ns") });
    fs.mkdirSync(path.join(nsRoot, "disk-only-ns"), { recursive: true });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await s3Status(".", "explicit-ns");
    const rows = perNamespaceRows(log.mock.calls.map((c) => c.join(" ")));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("explicit-ns:");
  });

  it("degrades gracefully when the namespaces root is ABSENT (fresh machine)", async () => {
    // Point the root at a path that does not exist and cannot be created.
    const missing = path.join(tmpDir, "no-such-root", "namespaces");
    process.env.DUCKBRAIN_NAMESPACES_PATH = missing;
    writeConfig({ "cfg-ns": path.join(missing, "cfg-ns") });

    const lines = await statusLines(); // must not throw

    expect(lines).toContain("S3 config: ENABLED");
    // The registry half is still served…
    expect(perNamespaceRows(lines).filter((r) => /^ {2}cfg-ns: /.test(r))).toHaveLength(1);
    // …and nothing was created on disk by a read-only status call.
    expect(fs.existsSync(missing)).toBe(false);
  });
});

describe("DF-0925-08: unionNamespaceList (order + dedupe)", () => {
  it("appends on-disk-only names after the config names, deduped", () => {
    expect(
      unionNamespaceList(["a", "b"], ["b", "c", "a", "d"]),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("returns the on-disk names when the registry is empty", () => {
    expect(unionNamespaceList([], ["only-disk"])).toEqual(["only-disk"]);
  });

  it("returns the config names when the census is empty", () => {
    expect(unionNamespaceList(["only-cfg"], [])).toEqual(["only-cfg"]);
  });

  it("dedupes within a single half too", () => {
    expect(unionNamespaceList(["x", "x"], ["y", "y"])).toEqual(["x", "y"]);
  });
});
