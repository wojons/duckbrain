/**
 * QA-DUCKBRAIN-021 regression tests: a corrupt or schema-invalid
 * `duckbrain.config.json` must FAIL LOUDLY.
 *
 * Before this fix `readFileConfig()` caught JSON.parse / zod errors and
 * returned `DuckBrainConfigSchema.parse({})` — i.e. DEFAULTS. Because
 * `namespacesPath` has a default (`./namespaces`), corruption silently
 * retargeted every read at a different store root:
 *
 *   - `duckbrain recall <key>` printed "No memories found" and exited 0 even
 *     though the record existed in the configured store;
 *   - an HTTP daemon booted on a malformed config answered /health ok while
 *     serving a different root.
 *
 * These arms pin the new contract:
 *   1. malformed JSON            -> ConfigFileError naming the config PATH
 *   2. schema violation          -> ConfigFileError naming the FIELD
 *   3. valid config              -> read still works (no false positive)
 *   4. missing config file       -> schema defaults, exactly as before
 *   5. env overrides             -> still win over a valid file
 *   6. write path (updateConfig) -> refuses, leaves the bad file intact
 *   7. CLI + daemon boot         -> non-zero exit / boot refusal, one line
 *
 * The CLI arms spawn the real entry point (`bin/duckbrain.js`). With no
 * `dist/` present it compiles `src/` on the fly via tsx, so they exercise the
 * SAME code path a user hits. Each child gets its own isolated store root
 * (`storeA`, relative to the temp config) and no inherited
 * DUCKBRAIN_NAMESPACES_PATH, so nothing can touch a live namespace store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  getConfig,
  updateConfig,
  resolveNamespacesPath,
  ConfigFileError,
} from "./index";
import { createHttpServer } from "../cli/http";

const ORIGINAL_CONFIG_PATH = process.env.DUCKBRAIN_CONFIG_PATH;
const ORIGINAL_NS_PATH = process.env.DUCKBRAIN_NAMESPACES_PATH;
const REPO_ROOT = process.cwd();

let tmpDir: string;
let cfgFile: string;

function writeConfig(contents: string): void {
  fs.writeFileSync(cfgFile, contents, "utf-8");
}

/** Run the real CLI with the temp config and an env stripped of ns override. */
function runCli(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DUCKBRAIN_NAMESPACES_PATH;
  env.DUCKBRAIN_CONFIG_PATH = cfgFile;
  env.HOME = tmpDir;
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "bin", "duckbrain.js"), ...args],
    { cwd: tmpDir, env, encoding: "utf-8", timeout: 120_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Capture the ConfigFileError a call throws, failing on any other shape. */
function catchConfigError(fn: () => unknown): ConfigFileError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigFileError) return error;
    throw new Error(
      `expected ConfigFileError, got ${(error as Error)?.name}: ${
        (error as Error)?.message
      }`,
    );
  }
  throw new Error("expected a ConfigFileError, but the call returned normally");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa021-cfg-"));
  cfgFile = path.join(tmpDir, "duckbrain.config.json");
  process.env.DUCKBRAIN_CONFIG_PATH = cfgFile;
  // The suite sets DUCKBRAIN_NAMESPACES_PATH globally (src/test-setup.ts); the
  // store-root arms must resolve the config file, so drop it here.
  delete process.env.DUCKBRAIN_NAMESPACES_PATH;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_CONFIG_PATH === undefined) {
    delete process.env.DUCKBRAIN_CONFIG_PATH;
  } else {
    process.env.DUCKBRAIN_CONFIG_PATH = ORIGINAL_CONFIG_PATH;
  }
  if (ORIGINAL_NS_PATH === undefined) {
    delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  } else {
    process.env.DUCKBRAIN_NAMESPACES_PATH = ORIGINAL_NS_PATH;
  }
});

describe("QA-DUCKBRAIN-021: malformed JSON fails loudly", () => {
  it("throws a ConfigFileError naming the config path", () => {
    writeConfig('{"namespacesPath": "./storeA",,}\n');

    const error = catchConfigError(() => getConfig("."));

    expect(error.reason).toBe("malformed-json");
    expect(error.configPath).toBe(cfgFile);
    expect(error.message).toContain(cfgFile);
    expect(error.message).toMatch(/malformed JSON/i);
    // A user-facing failure is ONE line — never stacked JSON.parse noise.
    expect(error.message).not.toContain("\n");
    expect(error).toBeInstanceOf(Error);
  });

  it("does not warn-and-default, and never returns the default store root", () => {
    writeConfig("{ this is not json }\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => getConfig(".")).toThrow(ConfigFileError);
    expect(() => resolveNamespacesPath()).toThrow(ConfigFileError);
    // The old behaviour printed "Warning: Could not parse config ... using
    // defaults" and carried on; nothing may paper over corruption now.
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats a truncated (empty) config file as corruption, not as absence", () => {
    writeConfig("");

    const error = catchConfigError(() => getConfig("."));
    expect(error.reason).toBe("malformed-json");
    expect(error.configPath).toBe(cfgFile);
  });
});

describe("QA-DUCKBRAIN-021: schema-invalid JSON fails loudly", () => {
  it("names the offending field (namespacesPath)", () => {
    writeConfig(
      JSON.stringify({ namespacesPath: 12345, defaultNamespace: "default" }),
    );

    const error = catchConfigError(() => getConfig("."));

    expect(error.reason).toBe("schema-invalid");
    expect(error.configPath).toBe(cfgFile);
    expect(error.fields).toContain("namespacesPath");
    expect(error.message).toContain("namespacesPath");
    expect(error.message).not.toContain("\n");
  });

  it("refuses to resolve a store root from the invalid file", () => {
    writeConfig(JSON.stringify({ namespacesPath: 12345 }));

    expect(() => resolveNamespacesPath()).toThrow(ConfigFileError);
  });

  it("names every offending field, not just the first", () => {
    writeConfig(
      JSON.stringify({
        namespacesPath: 12345,
        defaultNamespace: 42,
      }),
    );

    const error = catchConfigError(() => getConfig("."));
    expect(error.fields).toEqual(
      expect.arrayContaining(["namespacesPath", "defaultNamespace"]),
    );
  });
});

describe("QA-DUCKBRAIN-021: legitimate configs keep working", () => {
  it("reads a valid config and resolves the store root it declares", () => {
    writeConfig(
      JSON.stringify({
        namespacesPath: "./storeA",
        defaultNamespace: "qa021",
        authorEmail: "qa021@example.com",
      }),
    );

    expect(getConfig(".").namespacesPath).toBe("./storeA");
    // namespacesPath is relative to the directory that owns the config file.
    expect(resolveNamespacesPath()).toBe(path.join(tmpDir, "storeA"));
  });

  it("still honours DUCKBRAIN_NAMESPACES_PATH over a valid file", () => {
    writeConfig(JSON.stringify({ namespacesPath: "./storeA" }));
    process.env.DUCKBRAIN_NAMESPACES_PATH = path.join(tmpDir, "env-store");

    expect(resolveNamespacesPath()).toBe(path.join(tmpDir, "env-store"));
  });

  it("keeps a MISSING config file on schema defaults (absence != corruption)", () => {
    fs.rmSync(cfgFile, { force: true });

    const config = getConfig(".");
    expect(config.namespacesPath).toBe("./namespaces");
    expect(resolveNamespacesPath()).toBe(path.join(tmpDir, "namespaces"));
  });
});

describe("QA-DUCKBRAIN-021: the write path refuses to clobber corruption", () => {
  it("updateConfig throws instead of rewriting defaults over the bad file", () => {
    const original = '{"namespacesPath": "./storeA",,\n';
    writeConfig(original);

    expect(() =>
      updateConfig(".", { defaultNamespace: "clobbered" }),
    ).toThrow(ConfigFileError);
    // The corrupt bytes are preserved: an operator can still see what broke.
    expect(fs.readFileSync(cfgFile, "utf-8")).toBe(original);
  });

  it("registerNamespace on a schema-invalid file throws too", () => {
    const original = JSON.stringify({ namespacesPath: 12345 });
    writeConfig(original);

    expect(() => updateConfig(".", { defaultNamespace: "x" })).toThrow(
      ConfigFileError,
    );
    expect(fs.readFileSync(cfgFile, "utf-8")).toBe(original);
  });
});

describe("QA-DUCKBRAIN-021: daemon boot refuses a corrupt config", () => {
  it("createHttpServer throws ConfigFileError before binding a listener", () => {
    writeConfig('{"namespacesPath": "./storeA",,\n');

    const error = catchConfigError(() => createHttpServer({}));
    expect(error.configPath).toBe(cfgFile);
  });
});

describe("QA-DUCKBRAIN-021: CLI exits non-zero and names the config", () => {
  it("recall on a malformed config fails loudly (never 'No memories found')", () => {
    writeConfig('{"namespacesPath": "./storeA",,\n');

    const { status, stdout, stderr } = runCli(["recall", "/qa/settle/probe-c"]);

    expect(status).not.toBe(0);
    expect(stderr).toContain(cfgFile);
    expect(stderr).toMatch(/malformed JSON/i);
    expect(stdout).not.toContain("No memories found");
  }, 180_000);

  it("recall on a schema-invalid config names the field", () => {
    writeConfig(JSON.stringify({ namespacesPath: 12345 }));

    const { status, stdout, stderr } = runCli(["recall", "/qa/settle/probe-c"]);

    expect(status).not.toBe(0);
    expect(stderr).toContain(cfgFile);
    expect(stderr).toContain("namespacesPath");
    expect(stdout).not.toContain("No memories found");
  }, 180_000);
});
