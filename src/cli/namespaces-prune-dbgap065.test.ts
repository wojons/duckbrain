/**
 * DB-GAP-065 — `duckbrain namespaces prune` regression tests.
 *
 * Contract under test (acceptance criteria from the row):
 *   AC-1  the verb lives under the `namespaces` group; dry-run is the DEFAULT
 *         and writes nothing; `--apply` removes EXACTLY the mappings whose
 *         resolved directory is gone (live rows untouched) and prunes those
 *         names' `.s3state/<ns>.json` manifests in the same pass;
 *   AC-2  a second `--apply` is a no-op; the config write is atomic
 *         (tmp+fsync+rename) and a concurrent writer aborts without writing;
 *   AC-3  a dead mapping whose path escapes the namespaces root is REFUSED
 *         (reported, kept) using the same guard the delete path uses.
 *
 * All state lives in a vitest tmp dir: DUCKBRAIN_CONFIG_PATH (GAP-022) points
 * at a fixture config, DUCKBRAIN_NAMESPACES_PATH (BUG-037) at a fixture root.
 * The live ~/duckbrain config is never read or written by this suite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { runNamespacesPrune } from "./namespaces-prune";
import { runHumanCLI } from "./human";
import { applyNamespacePrune, planNamespacePrune } from "../namespaces/prune";
import { checkNamespacePathSafety } from "../namespaces/delete";
import { updateConfig } from "../config/index";

let tmpRoot: string;
let nsRoot: string;
let configPath: string;
let s3StateDir: string;
let savedEnv: Record<string, string | undefined>;

type Mappings = Record<string, string>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dbgap065-prune-"));
  nsRoot = path.join(tmpRoot, "namespaces");
  s3StateDir = path.join(nsRoot, ".s3state");
  fs.mkdirSync(s3StateDir, { recursive: true });
  configPath = path.join(tmpRoot, "duckbrain.config.json");

  savedEnv = {
    DUCKBRAIN_CONFIG_PATH: process.env.DUCKBRAIN_CONFIG_PATH,
    DUCKBRAIN_NAMESPACES_PATH: process.env.DUCKBRAIN_NAMESPACES_PATH,
  };
  process.env.DUCKBRAIN_CONFIG_PATH = configPath;
  process.env.DUCKBRAIN_NAMESPACES_PATH = nsRoot;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Write the fixture config through the REAL config writer, so the file is in
 * exactly the normalized shape production has (schema defaults included) and a
 * prune's byte accounting is comparable.
 */
function writeConfig(mappings: Mappings): void {
  updateConfig(".", {
    defaultNamespace: "live-a",
    authorEmail: "fixture@example.invalid",
    namespacesPath: "./namespaces",
    namespaceMappings: mappings,
  });
}

function readConfig(): any {
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function makeDir(rel: string): string {
  const dir = path.join(nsRoot, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), '{"version":"1.0"}\n');
  return dir;
}

function makeManifest(ns: string): string {
  const file = path.join(s3StateDir, `${ns}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      ns,
      lastSyncAt: "2026-01-01T00:00:00.000Z",
      files: {},
    }) + "\n",
  );
  return file;
}

/**
 * Mixed fixture: two live rows (one relative, one absolute value),
 * two dead rows (one relative, one absolute), and manifests for a live and a
 * dead namespace so "prunes only those names" is falsifiable.
 */
function mixedFixture(): {
  mappings: Mappings;
  liveManifest: string;
  deadManifest: string;
} {
  const liveAbs = makeDir("live-abs");
  makeDir("live-a");
  const mappings: Mappings = {
    // relative registry values, exactly like the live registry's 181 rows
    "live-a": "namespaces/live-a",
    // absolute registry values, exactly like the live registry's other rows
    "live-abs": liveAbs,
    "dead-a": "namespaces/dead-a",
    "dead-b": path.join(nsRoot, "dead-b"),
  };
  writeConfig(mappings);
  return {
    mappings,
    liveManifest: makeManifest("live-a"),
    deadManifest: makeManifest("dead-a"),
  };
}

describe("DB-GAP-065 AC-1: prune verb, dry-run default", () => {
  it("dry run reports the dead set and leaves the config byte-identical", () => {
    mixedFixture();
    const before = fs.readFileSync(configPath, "utf-8");
    const lines: string[] = [];

    const result = runNamespacesPrune({
      dryRun: true,
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
    });

    expect(result.exitCode).toBe(0);
    expect(result.plan.dead.map((r) => r.name)).toEqual(["dead-a", "dead-b"]);
    expect(result.plan.live.map((r) => r.name)).toEqual(["live-a", "live-abs"]);

    const report = lines.join("\n");
    expect(report).toContain("DRY RUN — would remove 2 dead mapping(s)");
    expect(report).toContain("dead-a -> namespaces/dead-a");
    expect(report).toContain("Nothing written (dry run)");
    expect(report).toContain("--apply");

    // Byte-identical: nothing was written at all.
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
    expect(readConfig().namespaceMappings["dead-a"]).toBe("namespaces/dead-a");
  });

  it("`duckbrain namespaces prune` with no flag is the dry run (real CLI dispatch)", async () => {
    mixedFixture();
    const before = fs.readFileSync(configPath, "utf-8");
    const logs: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });

    await runHumanCLI("namespaces", ["prune"]);

    logSpy.mockRestore();
    errSpy.mockRestore();

    expect(logs.join("\n")).toContain("DRY RUN — would remove 2 dead mapping(s)");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
  });
});

describe("DB-GAP-065 AC-1/AC-2: --apply removes exactly the dead set", () => {
  it("removes the dead rows, keeps live values byte-identical, prunes only their manifests, and the second run is a no-op", () => {
    const { liveManifest, deadManifest } = mixedFixture();
    const before = readConfig();
    const bytesBefore = fs.statSync(configPath).size;

    const first = runNamespacesPrune({
      dryRun: false,
      out: () => {},
      err: () => {},
    });

    expect(first.exitCode).toBe(0);
    expect(first.applied?.removed.map((r) => r.name)).toEqual([
      "dead-a",
      "dead-b",
    ]);
    expect(first.applied?.bytesAfter).toBeLessThan(bytesBefore);

    const after = readConfig();
    // The exact removal set: dead keys gone, every other key untouched.
    expect(Object.keys(after.namespaceMappings).sort()).toEqual([
      "live-a",
      "live-abs",
    ]);
    for (const [name, value] of Object.entries(after.namespaceMappings)) {
      expect(value).toBe((before.namespaceMappings as Mappings)[name]);
    }
    // Unrelated config fields survive the rewrite.
    expect(after.defaultNamespace).toBe("live-a");
    expect(after.authorEmail).toBe("fixture@example.invalid");
    expect(after.namespacesPath).toBe("./namespaces");

    // Manifests: the dead namespace's manifest is pruned, the live one stays.
    expect(fs.existsSync(deadManifest)).toBe(false);
    expect(fs.existsSync(liveManifest)).toBe(true);
    expect(first.applied?.manifestsPruned).toEqual([deadManifest]);

    // No temp file left behind (tmp + rename).
    const leftovers = fs
      .readdirSync(tmpRoot)
      .filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);

    // Second run: zero dead rows, no write, exit 0.
    const bytesAfterFirst = fs.readFileSync(configPath, "utf-8");
    const second = runNamespacesPrune({
      dryRun: false,
      out: () => {},
      err: () => {},
    });
    expect(second.exitCode).toBe(0);
    expect(second.plan.dead).toEqual([]);
    expect(second.applied?.removed).toEqual([]);
    expect(fs.readFileSync(configPath, "utf-8")).toBe(bytesAfterFirst);
  });

  it("is idempotent when a dead row's directory is recreated later (it becomes live, never removed)", () => {
    const { mappings } = mixedFixture();
    // The dead name now has a directory → it is live and must survive a prune.
    makeDir("dead-a");

    const result = runNamespacesPrune({
      dryRun: false,
      out: () => {},
      err: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.plan.dead.map((r) => r.name)).toEqual(["dead-b"]);

    const after = readConfig();
    expect(after.namespaceMappings["dead-a"]).toBe(mappings["dead-a"]);
    expect(after.namespaceMappings["dead-b"]).toBeUndefined();
  });
});

describe("DB-GAP-065 AC-2: crash safety", () => {
  it("aborts non-zero without writing when the config changed after the plan was computed", () => {
    mixedFixture();
    const plan = planNamespacePrune();
    expect(plan.dead).toHaveLength(2);

    // A concurrent writer lands between plan and apply.
    const concurrent = {
      defaultNamespace: "live-a",
      authorEmail: "fixture@example.invalid",
      namespacesPath: "./namespaces",
      namespaceMappings: { "live-a": "namespaces/live-a", "dead-a": "namespaces/dead-a" },
      concurrentWriterMarker: true,
    };
    const concurrentBytes = JSON.stringify(concurrent, null, 2) + "\n";
    fs.writeFileSync(configPath, concurrentBytes, "utf-8");

    expect(() => applyNamespacePrune(plan)).toThrow(/changed on disk/);
    // Nothing written: the concurrent writer's file survives verbatim.
    expect(fs.readFileSync(configPath, "utf-8")).toBe(concurrentBytes);
  });

  it("a write failure never truncates the existing config (single atomic replace)", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      // root ignores the read-only directory; the atomicity arm is meaningless.
      return;
    }
    mixedFixture();
    const original = fs.readFileSync(configPath, "utf-8");

    // Make the config directory unwritable: both the temp-file create and the
    // rename must fail, and the ORIGINAL file must be untouched (no in-place
    // truncation is ever performed).
    fs.chmodSync(tmpRoot, 0o500);
    const errors: string[] = [];
    let result: ReturnType<typeof runNamespacesPrune> | undefined;
    try {
      result = runNamespacesPrune({
        dryRun: false,
        out: () => {},
        err: (l) => errors.push(l),
      });
    } finally {
      fs.chmodSync(tmpRoot, 0o700);
    }

    expect(result?.exitCode).toBe(2);
    expect(errors.join("\n")).toContain("nothing was written");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(original);
  });
});

describe("DB-GAP-065 AC-3: path-safety guard reuse", () => {
  it("refuses a dead mapping whose path escapes the namespaces root (error, not deleted)", () => {
    const outside = path.join(tmpRoot, "outside-root", "gone-ns");
    writeConfig({
      "live-a": "namespaces/live-a",
      "dead-a": "namespaces/dead-a",
      escapee: outside,
      // `../` traversal is refused by the same rule
      traversal: path.join(nsRoot, "..", "traversal-gone"),
    });
    makeDir("live-a");
    const deadManifest = makeManifest("dead-a");

    const errors: string[] = [];
    const result = runNamespacesPrune({
      dryRun: false,
      out: () => {},
      err: (l) => errors.push(l),
    });

    // Refused rows are an ERROR: non-zero exit, named, and still registered.
    expect(result.exitCode).toBe(1);
    expect(result.plan.refused.map((r) => r.name)).toEqual([
      "escapee",
      "traversal",
    ]);
    expect(errors.join("\n")).toContain("escapes the namespaces root");
    expect(errors.join("\n")).toContain("escapee");

    const after = readConfig();
    expect(after.namespaceMappings.escapee).toBe(outside);
    expect(after.namespaceMappings.traversal).toBe(
      path.join(nsRoot, "..", "traversal-gone"),
    );
    // The legitimate dead row was still pruned, and its manifest too.
    expect(after.namespaceMappings["dead-a"]).toBeUndefined();
    expect(fs.existsSync(deadManifest)).toBe(false);
    // Nothing outside the root was created or removed.
    expect(fs.existsSync(path.join(tmpRoot, "outside-root"))).toBe(false);
  });

  it("uses the SAME rule as the delete path (plan refuses exactly what deleteNamespace refuses)", () => {
    const outside = path.join(tmpRoot, "outside-root", "gone-ns");
    writeConfig({ escapee: outside });
    const safety = checkNamespacePathSafety(outside, nsRoot);
    expect(safety.inside).toBe(false);
    expect(planNamespacePrune().refused.map((r) => r.name)).toEqual(["escapee"]);
  });
});
