/**
 * DF-0926-04 (unit half): DUCKBRAIN_NAMESPACE is honored, and it is honored
 * as a RUNTIME override — never persisted into duckbrain.config.json.
 *
 * Before the fix the variable had ZERO readers in src/: the docs
 * (docs/guide/ai-configure.md, examples/mcp-client/README.md) sold it as the
 * per-agent isolation knob, but every agent configured that way silently wrote
 * to the config's defaultNamespace instead.
 *
 * The single enforcement point is `applyEnvOverrides()` in this directory, so
 * every consumer that resolves a namespace through the config
 * (mcp/tools/shared.ts `resolveNamespaceName`, the CLI's getDefaultNamespace,
 * the HTTP routes) inherits the same precedence:
 *
 *   explicit param > DUCKBRAIN_NAMESPACE > config defaultNamespace > "default"
 *
 * Hermeticity: this suite owns its own config file (DUCKBRAIN_CONFIG_PATH) and
 * DUCKBRAIN_NAMESPACE, both saved/restored around the file. The repo's tracked
 * duckbrain.config.json is never read or written.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getConfig, updateConfig, CONFIG_FILENAME } from "./index";
import { resolveNamespaceName } from "../mcp/tools/shared";

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "df092604-config-"));
const CONFIG_PATH = path.join(SCRATCH, CONFIG_FILENAME);
const FILE_NS = "df092604-cfg-default";
const ENV_NS = "df092604-env-ns";

const PREV_CONFIG_PATH = process.env.DUCKBRAIN_CONFIG_PATH;
const PREV_NAMESPACE = process.env.DUCKBRAIN_NAMESPACE;

/** Write a config file carrying a non-default defaultNamespace. */
function writeConfigFile(defaultNamespace = FILE_NS): void {
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ defaultNamespace }, null, 2),
    "utf-8",
  );
}

function rawFileConfig(): { defaultNamespace?: string } {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

beforeEach(() => {
  fs.rmSync(CONFIG_PATH, { force: true });
  writeConfigFile();
  // resolveDuckbrainRoot() treats DUCKBRAIN_CONFIG_PATH's directory as the
  // instance root, so resolveNamespaceName() reads THIS file.
  process.env.DUCKBRAIN_CONFIG_PATH = CONFIG_PATH;
  delete process.env.DUCKBRAIN_NAMESPACE;
});

afterEach(() => {
  delete process.env.DUCKBRAIN_NAMESPACE;
});

describe("DF-0926-04: DUCKBRAIN_NAMESPACE is read by the config layer", () => {
  it("overrides the file's defaultNamespace for this process", () => {
    process.env.DUCKBRAIN_NAMESPACE = ENV_NS;

    expect(getConfig(SCRATCH).defaultNamespace).toBe(ENV_NS);
    // The file itself is untouched by a read.
    expect(rawFileConfig().defaultNamespace).toBe(FILE_NS);
  });

  it("falls back to the file's defaultNamespace when unset or blank", () => {
    expect(getConfig(SCRATCH).defaultNamespace).toBe(FILE_NS);

    process.env.DUCKBRAIN_NAMESPACE = "";
    expect(getConfig(SCRATCH).defaultNamespace).toBe(FILE_NS);

    process.env.DUCKBRAIN_NAMESPACE = "   ";
    expect(getConfig(SCRATCH).defaultNamespace).toBe(FILE_NS);
  });

  it("trims surrounding whitespace (a stray newline in an env file must not create a phantom namespace)", () => {
    process.env.DUCKBRAIN_NAMESPACE = `  ${ENV_NS}\n`;

    expect(getConfig(SCRATCH).defaultNamespace).toBe(ENV_NS);
  });

  it("is never persisted: an updateConfig() write keeps the file's own defaultNamespace (GAP-007 invariant)", () => {
    process.env.DUCKBRAIN_NAMESPACE = ENV_NS;

    const returned = updateConfig(SCRATCH, {
      authorEmail: "df092604@example.com",
    });

    // The caller sees the effective runtime config...
    expect(returned.defaultNamespace).toBe(ENV_NS);
    // ...but the on-disk file keeps its own value, so an agent started with the
    // env var can never rewrite a shared duckbrain.config.json.
    expect(rawFileConfig().defaultNamespace).toBe(FILE_NS);
  });

  it("reports 'default' when neither env nor file supplies a value", () => {
    fs.rmSync(CONFIG_PATH, { force: true });

    expect(getConfig(SCRATCH).defaultNamespace).toBe("default");
  });
});

describe("DF-0926-04: resolved precedence is explicit > env > config > 'default'", () => {
  it("an explicit namespace argument always wins over the env var", () => {
    process.env.DUCKBRAIN_NAMESPACE = ENV_NS;

    expect(resolveNamespaceName("df092604-explicit")).toBe("df092604-explicit");
  });

  it("with no explicit argument the env var wins over the config file", () => {
    process.env.DUCKBRAIN_NAMESPACE = ENV_NS;

    expect(resolveNamespaceName()).toBe(ENV_NS);
    expect(resolveNamespaceName(undefined)).toBe(ENV_NS);
  });

  it("with the env var unset the config file wins, and 'default' is the last resort", () => {
    expect(resolveNamespaceName()).toBe(FILE_NS);

    fs.rmSync(CONFIG_PATH, { force: true });
    expect(resolveNamespaceName()).toBe("default");
  });
});

// Restore the ambient config path for any sibling suite in this worker.
afterAll(() => {
  if (PREV_CONFIG_PATH === undefined) delete process.env.DUCKBRAIN_CONFIG_PATH;
  else process.env.DUCKBRAIN_CONFIG_PATH = PREV_CONFIG_PATH;
  if (PREV_NAMESPACE === undefined) delete process.env.DUCKBRAIN_NAMESPACE;
  else process.env.DUCKBRAIN_NAMESPACE = PREV_NAMESPACE;
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});
