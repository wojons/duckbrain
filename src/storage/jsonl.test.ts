import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { appendToJsonl, getNextChunkName, readPartition } from "./jsonl";
import { resolveNamespacePath } from "../mcp/tools/shared";
import type { MemoryType } from "../schema/memory";

// GAP-062 spawns the real CLI in a subprocess; tsx startup + a git-committing
// write needs more than the default 15s budget (same convention as
// src/cli/remember-wait-cliwait001.test.ts).
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Regression test for the 0NaN.jsonl chunk-rotation bug (2026-08-06):
 * getNextChunkName() used parseInt() on every *.jsonl filename, so when a
 * partition contained "current.jsonl" (non-numeric), rotation produced
 * "0NaN.jsonl". Because appendToJsonl's capacity check only inspects the
 * original file path, that file then absorbed every write forever —
 * unbounded single-file growth that ballooned namespace git repos to
 * hundreds of GB of loose objects (each auto-commit stored a full copy).
 */
function makeRecord(i: number): MemoryType {
  return {
    id: "00000000-0000-4000-8000-000000000000".replace(/0/g, () =>
      Math.floor(Math.random() * 10).toString(),
    ),
    key: `/test/rotation/${i}`,
    domain: "event",
    timestamp: new Date().toISOString(),
    author: "test@example.com",
    action: "add",
    embedding_text: `rotation test record ${i}`,
    attributes: {},
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-jsonl-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("appendToJsonl chunk rotation", () => {
  it("rotates to a numeric chunk (0001.jsonl) when current.jsonl is at capacity, never 0NaN.jsonl", () => {
    const filePath = path.join(tmpDir, "current.jsonl");

    // MAX_LINES_PER_CHUNK = 1000; the 1001st append must rotate.
    for (let i = 0; i < 1001; i++) {
      appendToJsonl(filePath, makeRecord(i));
    }

    const files = fs.readdirSync(tmpDir).sort();
    expect(files).toContain("current.jsonl");
    expect(files).toContain("0001.jsonl");
    expect(files).not.toContain("0NaN.jsonl");

    // The rotated chunk holds exactly the overflow record(s).
    const rotated = fs.readFileSync(path.join(tmpDir, "0001.jsonl"), "utf-8");
    expect(rotated.trim().split("\n").length).toBe(1);
  });

  it("continues the numeric sequence (0002.jsonl) on subsequent rotations", () => {
    const filePath = path.join(tmpDir, "current.jsonl");

    for (let i = 0; i < 2001; i++) {
      appendToJsonl(filePath, makeRecord(i));
    }

    const files = fs.readdirSync(tmpDir).sort();
    expect(files).toContain("0001.jsonl");
    expect(files).toContain("0002.jsonl");
    expect(files).not.toContain("0NaN.jsonl");
  });

  it("ignores a legacy 0NaN.jsonl and still produces numeric chunks", () => {
    // Simulate a partition already polluted by the old bug.
    fs.writeFileSync(path.join(tmpDir, "current.jsonl"), "legacy\n");
    fs.writeFileSync(path.join(tmpDir, "0NaN.jsonl"), "legacy\n");

    const filePath = path.join(tmpDir, "current.jsonl");
    for (let i = 0; i < 1001; i++) {
      appendToJsonl(filePath, makeRecord(i));
    }

    const files = fs.readdirSync(tmpDir).sort();
    expect(files).toContain("0001.jsonl");
    expect(files).toContain("0NaN.jsonl"); // legacy file left untouched
    expect(files).not.toContain("0000.jsonl");
  });
});

describe("DB-GAP-035: write-path validation", () => {
  it("skips an unserializable record (circular attributes) instead of corrupting the file", () => {
    const filePath = path.join(tmpDir, "current.jsonl");

    // A circular attributes object passes MemorySchema.parse (z.any() value
    // schema never recurses into the value) but FAILS JSON.stringify — the
    // exact class of payload that would land a garbage line in the store.
    const record = makeRecord(0);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    record.attributes = circular as never;

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const written = appendToJsonl(filePath, record);

    // The append must be skipped (0 lines written), logged, and the store
    // left untouched — not even created. (Assert before mockRestore — a
    // restored spy loses its call history.)
    expect(written).toBe(0);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("refusing to append unserializable record"),
    );
    errSpy.mockRestore();
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

/**
 * Regression: rotation froze at segment 9999 (2026-09-19).
 *
 * `padStart(4, "0")` stops padding once a number exceeds 4 digits, so the
 * segment names past 9999 are not fixed-width ("10000.jsonl"). A plain
 * lexicographic `.sort()` then ranks "9999.jsonl" as the newest segment, and
 * getNextChunkName() returned "10000.jsonl" — a name that already existed —
 * on every call. Rotation stopped advancing, one segment absorbed every write
 * forever, and the partition bounded at 1000 lines / 1MB was found holding
 * 87,530 lines / 84MB. Each auto-commit then stored a full 84MB blob, which
 * bloated the namespace git repo to 3.2GB and made every S3 bundle push
 * re-compress that history (measured 470 CPU-seconds per push).
 */
describe("chunk rotation past segment 9999", () => {
  const seed = (names: string[]): void => {
    for (const n of names) fs.writeFileSync(path.join(tmpDir, n), "", "utf8");
  };

  it("continues to 10001.jsonl when 9999.jsonl and 10000.jsonl exist", () => {
    seed(["9999.jsonl", "10000.jsonl"]);
    expect(getNextChunkName(tmpDir)).toBe("10001.jsonl");
  });

  it("skips existing names instead of re-returning one (collision guard)", () => {
    seed(["9999.jsonl", "10000.jsonl", "10001.jsonl", "10002.jsonl"]);
    expect(getNextChunkName(tmpDir)).toBe("10003.jsonl");
  });

  it("keeps the legacy numeric sequence below 10000", () => {
    seed(["0001.jsonl", "0002.jsonl"]);
    expect(getNextChunkName(tmpDir)).toBe("0003.jsonl");
  });

  it("ignores non-numeric segments when choosing the next chunk", () => {
    seed(["0007.jsonl", "current.jsonl"]);
    expect(getNextChunkName(tmpDir)).toBe("0008.jsonl");
  });

  it("appends to a NEW segment when a five-digit-named segment is at capacity", () => {
    // 1000 lines is MAX_LINES_PER_CHUNK, so 9999.jsonl is full.
    const full = path.join(tmpDir, "9999.jsonl");
    fs.writeFileSync(full, "x\n".repeat(1000), "utf8");
    seed(["10000.jsonl"]);

    const written = appendToJsonl(full, makeRecord(1));

    expect(written).toBe(1);
    // The record must land in a fresh segment — not in 10000.jsonl.
    expect(fs.readFileSync(path.join(tmpDir, "10001.jsonl"), "utf8")).toContain(
      "/test/rotation/1",
    );
    expect(fs.readFileSync(path.join(tmpDir, "10000.jsonl"), "utf8")).toBe("");
  });

  it("reads segments in numeric order, not lexicographic order", () => {
    const a = makeRecord(1);
    const b = makeRecord(2);
    fs.writeFileSync(
      path.join(tmpDir, "9999.jsonl"),
      `${JSON.stringify(a)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(tmpDir, "10000.jsonl"),
      `${JSON.stringify(b)}\n`,
      "utf8",
    );

    const records = readPartition(tmpDir);

    // Before the fix this returned 10000.jsonl's record first ("10000.jsonl"
    // sorts below "9999.jsonl" lexicographically), i.e. out of append order.
    expect(records.map((r) => r.key)).toEqual([
      "/test/rotation/1",
      "/test/rotation/2",
    ]);
  });
});

/**
 * GAP-062 regression: a namespace WRITE must resolve its output root from the
 * duckbrain root (the directory owning duckbrain.config.json), never from the
 * caller's cwd.
 *
 * Incident (2026-09-19/20): a `duckbrain` CLI write invoked from an unrelated
 * product checkout (get-h3/sdk-typescript) created `./namespaces/qa` inside
 * that checkout, because `namespacesPath` ("./namespaces") was resolved with
 * `path.resolve(getConfig(".").namespacesPath)` — i.e. relative to whatever
 * cwd the PATH-resolved binary inherited.
 *
 * Hermeticity: the child/in-process writes are redirected with
 * DUCKBRAIN_CONFIG_PATH pointed at a scratch config file inside a scratch
 * root, so nothing here touches the repo's live `namespaces/`.
 */
describe("GAP-062: namespace writes resolve from the config root, never the caller cwd", () => {
  const CONFIG_FILENAME = "duckbrain.config.json";

  /** <scratch>/db-root/{duckbrain.config.json, namespaces/} + a foreign cwd. */
  function scratchLayout(): {
    root: string;
    foreignCwd: string;
    configPath: string;
  } {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-gap062-root-"),
    );
    fs.writeFileSync(
      path.join(root, CONFIG_FILENAME),
      JSON.stringify({ namespacesPath: "./namespaces" }, null, 2) + "\n",
      "utf-8",
    );
    const foreignCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-gap062-foreign-"),
    );
    return { root, foreignCwd, configPath: path.join(root, CONFIG_FILENAME) };
  }

  /** Env that pins the scratch root and nothing else about namespace storage. */
  function childEnv(
    configPath: string,
    extra: Record<string, string> = {},
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DUCKBRAIN_CONFIG_PATH: configPath,
      ...extra,
    };
    // The suite-wide BUG-037 redirect would otherwise win over the config root.
    delete env.DUCKBRAIN_NAMESPACES_PATH;
    return env;
  }

  /** Recursively look for a JSONL row containing `needle` under `dir`. */
  function jsonlUnder(dir: string, needle: string): string | null {
    if (!fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const hit = jsonlUnder(p, needle);
        if (hit) return hit;
      } else if (entry.name.endsWith(".jsonl")) {
        if (fs.readFileSync(p, "utf-8").includes(needle)) return p;
      }
    }
    return null;
  }

  it("writes under the config root when the process cwd is an unrelated directory", () => {
    const { root, foreignCwd, configPath } = scratchLayout();
    const prevConfigPath = process.env.DUCKBRAIN_CONFIG_PATH;
    const prevNsPath = process.env.DUCKBRAIN_NAMESPACES_PATH;
    const prevCwd = process.cwd();
    try {
      process.env.DUCKBRAIN_CONFIG_PATH = configPath;
      delete process.env.DUCKBRAIN_NAMESPACES_PATH;
      process.chdir(foreignCwd);

      // The write path every MCP tool / CLI remember uses to find its root.
      const nsPath = resolveNamespacePath("gap062-ns");
      expect(nsPath).toBe(path.join(root, "namespaces", "gap062-ns"));

      // A real append through the storage layer (not just the resolver).
      const partition = path.join(nsPath, "event", "2026-09");
      fs.mkdirSync(partition, { recursive: true });
      const file = path.join(partition, "current.jsonl");
      expect(appendToJsonl(file, makeRecord(1))).toBe(1);

      expect(
        jsonlUnder(path.join(root, "namespaces"), "/test/rotation/1"),
      ).not.toBeNull();
      // The regression: no namespace tree next to the caller.
      expect(fs.existsSync(path.join(foreignCwd, "namespaces"))).toBe(false);
    } finally {
      process.chdir(prevCwd);
      if (prevConfigPath === undefined) {
        delete process.env.DUCKBRAIN_CONFIG_PATH;
      } else {
        process.env.DUCKBRAIN_CONFIG_PATH = prevConfigPath;
      }
      if (prevNsPath === undefined) {
        delete process.env.DUCKBRAIN_NAMESPACES_PATH;
      } else {
        process.env.DUCKBRAIN_NAMESPACES_PATH = prevNsPath;
      }
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(foreignCwd, { recursive: true, force: true });
    }
  });

  it("a PATH-resolved CLI invoked from a foreign cwd writes under the config root, never <cwd>/namespaces", async () => {
    const { root, foreignCwd, configPath } = scratchLayout();
    const repoRoot = process.cwd();
    const repoBin = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");
    const key = "/gap062/foreign-cwd-probe";

    // PATH resolution, faithfully: a bin directory holding an executable named
    // `duckbrain` (exactly what npm/pnpm link creates) that points at the
    // package entry — the incident's invocation shape.
    const shimBinDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-gap062-bin-"),
    );
    fs.symlinkSync(repoBin, path.join(shimBinDir, "duckbrain"));

    const res = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const child = spawn(
        "duckbrain",
        [
          "remember",
          key,
          "--domain=raw_note",
          "--content=GAP-062 foreign cwd probe",
          "--namespace=gap062-ns",
        ],
        {
          cwd: foreignCwd,
          env: childEnv(configPath, {
            PATH: `${shimBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          }),
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: `${stderr}${String(err)}` });
      });
    });

    try {
      expect(res.stderr + res.stdout).not.toContain("ENOENT");
      expect(res.code).toBe(0);
      // The row landed under the config root...
      expect(
        jsonlUnder(path.join(root, "namespaces", "gap062-ns"), key),
      ).not.toBeNull();
      // ...and nothing was created next to the caller, nor in the live store.
      expect(fs.existsSync(path.join(foreignCwd, "namespaces"))).toBe(false);
      expect(
        fs.existsSync(path.join(repoRoot, "namespaces", "gap062-ns")),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(foreignCwd, { recursive: true, force: true });
      fs.rmSync(shimBinDir, { recursive: true, force: true });
    }
  });
});
