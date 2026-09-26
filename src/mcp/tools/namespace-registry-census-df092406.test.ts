/**
 * DF-0924-06 regression tests — MCP tool level: registry agrees with reality.
 *
 * The P1 split-brain at the TOOL layer (src/mcp/tools/namespace.ts):
 *   - list_namespaces mapped config.namespaceMappings ONLY and unshifted a
 *     synthetic `default` row even when the default namespace was never
 *     created (phantom row — GET /api/namespaces had the DB-GAP-057 census
 *     union, but the MCP tool did not);
 *   - switch_namespace validated the target against config mappings only,
 *     so a directory-present, mapping-absent namespace (exactly what the
 *     be129bc split-brain produced) was 404 on switch while being visible
 *     in listings — the surfaces disagreed with each other.
 *
 * Contract pinned here:
 *   AC-1: a directory under the namespaces root with NO config mapping is
 *         listed by list_namespaces (flagged onDiskOnly — census truth);
 *   AC-2: NO phantom `default` row when default was never created (no
 *         mapping, no directory). GAP-062's absolute-path note is kept for
 *         the synthetic row whenever it legitimately appears;
 *   AC-3: switch_namespace accepts a directory-present, mapping-absent
 *         namespace and REGISTERS the mapping (the write path's own
 *         treatment of directory-only namespaces is "create the dir, then
 *         register it" — switch adopts the same reconciliation), then
 *         persists defaultNamespace;
 *   AC-4: a namespace that exists NOWHERE (no mapping, no directory) still
 *         fails with an accurate error NAMING the namespace.
 *
 * Isolation (GAP-007/BUG-037 class): every test redirects the config FILE
 * (DUCKBRAIN_CONFIG_PATH) and the namespaces root (DUCKBRAIN_NAMESPACES_PATH)
 * to its own mkdtemp pair — the tracked duckbrain.config.json and the repo's
 * namespaces/ directory are never touched; env is restored afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { listNamespacesTool, switchNamespaceTool } from "./namespace";
import { registerNamespace } from "../../config/index";

let tmpRoot: string;
let nsRoot: string;
let configPath: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "df092406-tool-"));
  nsRoot = path.join(tmpRoot, "namespaces");
  fs.mkdirSync(nsRoot, { recursive: true });
  configPath = path.join(tmpRoot, "duckbrain.config.json");

  savedEnv = {
    DUCKBRAIN_CONFIG_PATH: process.env.DUCKBRAIN_CONFIG_PATH,
    DUCKBRAIN_NAMESPACES_PATH: process.env.DUCKBRAIN_NAMESPACES_PATH,
  };
  process.env.DUCKBRAIN_CONFIG_PATH = configPath;
  process.env.DUCKBRAIN_NAMESPACES_PATH = nsRoot;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function readConfigMappings(): Record<string, string> {
  if (!fs.existsSync(configPath)) return {};
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
    namespaceMappings?: Record<string, string>;
  };
  return raw.namespaceMappings ?? {};
}

function readConfigDefaultNamespace(): string | undefined {
  if (!fs.existsSync(configPath)) return undefined;
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
    defaultNamespace?: string;
  };
  return raw.defaultNamespace;
}

describe("DF-0924-06: list_namespaces unions the directory census", () => {
  it("AC-1: a directory-present, mapping-absent namespace is listed (onDiskOnly)", async () => {
    // Directory exists under the namespaces root; the config registry has
    // never heard of it (the be129bc split-brain shape).
    fs.mkdirSync(path.join(nsRoot, "solo"), { recursive: true });
    // Census noise the DB-GAP-057 contract says to skip.
    fs.mkdirSync(path.join(nsRoot, ".s3state"), { recursive: true });
    fs.writeFileSync(path.join(nsRoot, "duckbrain.config.json"), "{}\n");

    const result = await listNamespacesTool({});

    expect(result.success).toBe(true);
    const solo = result.namespaces.find((n) => n.name === "solo");
    expect(solo).toBeDefined();
    expect(solo?.path).toBe(path.join(nsRoot, "solo"));
    expect(solo?.onDiskOnly).toBe(true);
    expect(solo?.isDefault).toBe(false);
    // Noise skipped.
    expect(result.namespaces.some((n) => n.name === ".s3state")).toBe(false);
    expect(
      result.namespaces.some((n) => n.name === "duckbrain.config.json"),
    ).toBe(false);
  });

  it("AC-1: a mapped namespace with its directory stays a plain registry row (no onDiskOnly)", async () => {
    fs.mkdirSync(path.join(nsRoot, "work"), { recursive: true });
    registerNamespace(".", "work", path.join(nsRoot, "work"));

    const result = await listNamespacesTool({});

    const work = result.namespaces.find((n) => n.name === "work");
    expect(work).toBeDefined();
    expect(work?.onDiskOnly).toBeUndefined();
  });

  it("AC-2: NO phantom default row when the default namespace was never created", async () => {
    // Empty registry, no directories at all — nothing was ever created.
    const result = await listNamespacesTool({});

    expect(result.success).toBe(true);
    expect(result.namespaces.some((n) => n.name === "default")).toBe(false);
  });

  it("AC-2: no phantom default even when OTHER namespaces exist", async () => {
    fs.mkdirSync(path.join(nsRoot, "work"), { recursive: true });
    registerNamespace(".", "work", path.join(nsRoot, "work"));

    const result = await listNamespacesTool({});

    expect(result.namespaces.some((n) => n.name === "default")).toBe(false);
    expect(result.namespaces.map((n) => n.name)).toContain("work");
  });

  it("AC-2: a REAL default (dir + mapping) still lists exactly once", async () => {
    fs.mkdirSync(path.join(nsRoot, "default"), { recursive: true });
    registerNamespace(".", "default", path.join(nsRoot, "default"));

    const result = await listNamespacesTool({});

    const defaults = result.namespaces.filter((n) => n.name === "default");
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.onDiskOnly).toBeUndefined();
  });
});

describe("DF-0924-06: switch_namespace reconciles with the directory census", () => {
  it("AC-3: switch to a directory-present, mapping-absent namespace succeeds and REGISTERS it", async () => {
    fs.mkdirSync(path.join(nsRoot, "solo"), { recursive: true });

    const result = await switchNamespaceTool({ name: "solo" });

    expect(result.success).toBe(true);
    expect(result.current).toBe("solo");

    // The mapping is REGISTERED (the write path's own reconciliation rule:
    // dir created → mapping registered), into the config file the list and
    // switch paths read.
    expect(readConfigMappings()["solo"]).toBe(path.join(nsRoot, "solo"));
    expect(readConfigDefaultNamespace()).toBe("solo");
  });

  it("AC-4: switch to a namespace that exists nowhere fails, NAMING the namespace", async () => {
    const result = await switchNamespaceTool({ name: "no-such-ns" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no-such-ns");
  });
});
