/**
 * DOGFOOD-017 Regression Tests: remember/recall echo the resolved namespace;
 * non-default writes carry a warning; switch_namespace persists.
 *
 * The bug: switch_namespace in one stdio session PERSISTS
 * config.defaultNamespace into duckbrain.config.json (updateConfig), so the
 * active namespace is sticky across processes — but remember/recall
 * responses never echoed which namespace was actually used. A user who
 * forgot the namespace arg got success:true with no indication the memory
 * went elsewhere.
 *
 * Regressions guarded:
 *  (a) remember without namespace echoes the resolved namespace (active
 *      config defaultNamespace, "default" when nothing was switched)
 *  (b) recall without namespace echoes the resolved namespace
 *  (c) remember with an explicit namespace echoes it
 *  (d) remember warns when the write lands outside the 'default' namespace
 *  (e) switch_namespace persists: defaultNamespace in the config FILE (not
 *      just the in-memory getConfig) reflects the switch — the mechanism
 *      that makes the active namespace sticky across processes
 *  (f) a remember WITHOUT namespace after switch_namespace echoes the
 *      switched namespace and warns — the exact DOGFOOD-017 failure mode
 *
 * DF-0919-06 narrows (d): the warning is only for the STICKY-SURPRISE case
 * (the arg was omitted and the resolved namespace came from the sticky active
 * namespace). An explicit `namespace` argument never warns, however
 * non-default it is — warning there trains callers to ignore the guardrail.
 * See the trailing DF-0919-06 describe block.
 *
 * The config FILE is redirected to a temp path by src/test-setup.ts
 * (DUCKBRAIN_CONFIG_PATH, GAP-022) and namespace storage to a temp root
 * (DUCKBRAIN_NAMESPACES_PATH, BUG-037) — the tracked duckbrain.config.json
 * at the repo root is never touched. The snapshot/restore below guards the
 * temp config, never the repo config.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { rememberTool } from "./remember";
import { recallTool } from "./recall";
import { createNamespaceTool, switchNamespaceTool } from "./namespace";
import { updateConfig } from "../../config/index";
import { drainAsyncCommits } from "../../git/autocommit";

// The config file the tools actually use: the GAP-022 env override when the
// suite set it (src/test-setup.ts), else the repo-root file as fallback.
const CONFIG_PATH =
  process.env.DUCKBRAIN_CONFIG_PATH ||
  path.join(process.cwd(), "duckbrain.config.json");
const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;

const createdNamespaces: string[] = [];

let configSnapshot: string;

beforeEach(() => {
  configSnapshot = fs.existsSync(CONFIG_PATH)
    ? fs.readFileSync(CONFIG_PATH, "utf-8")
    : "";
});

afterEach(async () => {
  // Restore the (temp) config file so the test never leaks mappings or a
  // switched defaultNamespace.
  if (configSnapshot) {
    fs.writeFileSync(CONFIG_PATH, configSnapshot, "utf-8");
  } else if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
  }
  // OPS-006: commits run off the event loop, so a namespace just written may
  // still have a git child working inside it. Let that settle before deleting
  // the tree — removing a namespace mid-commit leaves .git/ non-empty
  // (ENOTEMPTY).
  await drainAsyncCommits();
  // Remove scratch namespace dirs (JSONL + git repos + DuckDB files).
  for (const name of createdNamespaces) {
    fs.rmSync(path.join(NS_ROOT, name), { recursive: true, force: true });
  }
  createdNamespaces.length = 0;
});

/** Create a scratch namespace (registered in the temp config) and track it. */
async function createScratchNamespace(name: string): Promise<void> {
  const result = await createNamespaceTool({ name, setDefault: false });
  expect(result.success).toBe(true);
  createdNamespaces.push(name);
}

/** Read a config field straight from disk (bypassing caches). */
function liveConfig(): { defaultNamespace?: string } {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

describe("DOGFOOD-017: remember echoes the namespace actually written", () => {
  it("(a) echoes the resolved namespace when the arg is omitted (active = 'default')", async () => {
    const result = await rememberTool({
      key: "/scratch/dogfood017-a",
      domain: "raw_note",
      attributes: {},
      embedding_text: "DOGFOOD-017 (a): omitted namespace resolves to default",
    });

    expect(result.success).toBe(true);
    expect(result.namespace).toBe("default");
    // A write to the literal 'default' namespace is not surprising — no warning.
    expect(result.warning).toBeUndefined();
  });

  it("(c) echoes an explicit namespace arg", async () => {
    const nsName = "dogfood017-explicit";
    await createScratchNamespace(nsName);

    const result = await rememberTool({
      key: "/scratch/dogfood017-c",
      domain: "raw_note",
      attributes: {},
      embedding_text: "DOGFOOD-017 (c): explicit namespace",
      namespace: nsName,
    });

    expect(result.success).toBe(true);
    expect(result.namespace).toBe(nsName);
  });

  // DF-0919-06: this case used to assert the OPPOSITE (an explicit non-default
  // arg warned). That contract is the defect: the caller named the namespace,
  // so the warning is pure noise. The genuine sticky-surprise case — which is
  // what DOGFOOD-017 was guarding — is (f) below and DF-0919-06 (b).
  it("(d) does NOT warn when the caller named the non-default namespace explicitly", async () => {
    const nsName = "dogfood017-warn";
    await createScratchNamespace(nsName);

    const result = await rememberTool({
      key: "/scratch/dogfood017-d",
      domain: "raw_note",
      attributes: {},
      embedding_text: "DOGFOOD-017 (d): explicit non-default write",
      namespace: nsName,
    });

    expect(result.success).toBe(true);
    expect(result.namespace).toBe(nsName);
    expect(result.warning).toBeUndefined();
  });

  it("(f) after switch_namespace, an omitted-arg remember echoes the switched namespace + warns — the DOGFOOD-017 failure mode", async () => {
    const nsName = "dogfood017-switched";
    await createScratchNamespace(nsName);

    const switched = await switchNamespaceTool({ name: nsName });
    expect(switched.success).toBe(true);
    expect(switched.current).toBe(nsName);

    // No namespace arg: previously this wrote to the switched namespace
    // while the response said nothing about where it landed.
    const result = await rememberTool({
      key: "/scratch/dogfood017-f",
      domain: "raw_note",
      attributes: {},
      embedding_text: "DOGFOOD-017 (f): omitted arg after switch",
    });

    expect(result.success).toBe(true);
    expect(result.namespace).toBe(nsName);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain(nsName);

    // The memory actually landed in the switched namespace's JSONL.
    const partitionGlob = path.join(NS_ROOT, nsName, "raw_note");
    const jsonlFiles = fs
      .readdirSync(partitionGlob, { recursive: true })
      .filter((f) => String(f).endsWith("current.jsonl"));
    expect(jsonlFiles.length).toBeGreaterThan(0);
    const written = fs.readFileSync(
      path.join(partitionGlob, String(jsonlFiles[0])),
      "utf-8",
    );
    expect(written).toContain("/scratch/dogfood017-f");
  });
});

describe("DOGFOOD-017: recall echoes the namespace actually queried", () => {
  it("(b) echoes the resolved namespace when the arg is omitted (active = 'default')", async () => {
    // Seed a memory in the default namespace via the real write path.
    const seed = await rememberTool({
      key: "/scratch/dogfood017-b",
      domain: "raw_note",
      attributes: {},
      embedding_text: "DOGFOOD-017 (b): recall omitted namespace",
    });
    expect(seed.success).toBe(true);

    const result = await recallTool({ key: "/scratch/dogfood017-b" });

    expect(result.error).toBeUndefined();
    expect(result.count).toBeGreaterThan(0);
    expect(result.namespace).toBe("default");
  });

  it("(b2) after switch_namespace, an omitted-arg recall echoes the switched namespace", async () => {
    const nsName = "dogfood017-recall-switched";
    await createScratchNamespace(nsName);
    const switched = await switchNamespaceTool({ name: nsName });
    expect(switched.success).toBe(true);

    const seed = await rememberTool({
      key: "/scratch/dogfood017-b2",
      domain: "raw_note",
      attributes: {},
      embedding_text: "DOGFOOD-017 (b2): recall after switch",
    });
    expect(seed.success).toBe(true);
    expect(seed.namespace).toBe(nsName);

    const result = await recallTool({ key: "/scratch/dogfood017-b2" });

    expect(result.error).toBeUndefined();
    expect(result.count).toBeGreaterThan(0);
    expect(result.namespace).toBe(nsName);
  });

  it("(c2) echoes an explicit namespace arg", async () => {
    const nsName = "dogfood017-recall-explicit";
    await createScratchNamespace(nsName);

    const seed = await rememberTool({
      key: "/scratch/dogfood017-c2",
      domain: "raw_note",
      attributes: {},
      embedding_text: "DOGFOOD-017 (c2): recall explicit namespace",
      namespace: nsName,
    });
    expect(seed.success).toBe(true);

    const result = await recallTool({
      key: "/scratch/dogfood017-c2",
      namespace: nsName,
    });

    expect(result.error).toBeUndefined();
    expect(result.count).toBeGreaterThan(0);
    expect(result.namespace).toBe(nsName);
  });

  it("reports the RESOLVED name in the does-not-exist error (not 'undefined')", async () => {
    const result = await recallTool({ keyPrefix: "/scratch/" });
    // default namespace exists (test-setup creates it), so force a missing one.
    updateConfig(".", { defaultNamespace: "dogfood017-missing" });
    const result2 = await recallTool({ keyPrefix: "/scratch/" });

    expect(result2.error).toContain("'dogfood017-missing'");
    expect(result2.namespace).toBe("dogfood017-missing");
    expect(result2.error).not.toContain("undefined");
    expect(result.namespace).toBe("default");
  });
});

describe("DOGFOOD-017: switch_namespace persists to the config FILE", () => {
  it("(e) the config file on disk reflects the switched defaultNamespace", async () => {
    const nsName = "dogfood017-persist";
    await createScratchNamespace(nsName);

    // The switch must call updateConfig -> the config FILE (the mechanism
    // that makes the active namespace sticky for LATER separate processes).
    const switched = await switchNamespaceTool({ name: nsName });
    expect(switched.success).toBe(true);
    expect(switched.previous).toBe("default");
    expect(switched.current).toBe(nsName);

    const onDisk = liveConfig();
    expect(onDisk.defaultNamespace).toBe(nsName);
  });
});

/**
 * DF-0919-06: the "written outside default namespace" warning is a guardrail
 * against the STICKY-SURPRISE case only — the arg was omitted and the write
 * landed in the process-persisted active namespace. Firing it when the caller
 * EXPLICITLY named the namespace (live probe: a write with
 * `?namespace=df-ns-0919` still warned) turns a real guardrail into noise that
 * trains callers to ignore it.
 */
describe("DF-0919-06: remember warns only when the namespace was OMITTED", () => {
  it("(a) an explicit non-default namespace produces NO warning", async () => {
    const nsName = "df0919-explicit";
    await createScratchNamespace(nsName);

    const result = await rememberTool({
      key: "/scratch/df0919-a",
      domain: "raw_note",
      attributes: {},
      embedding_text: "DF-0919-06 (a): explicit non-default namespace",
      namespace: nsName,
    });

    expect(result.success).toBe(true);
    expect(result.namespace).toBe(nsName);
    expect(result.warning).toBeUndefined();
  });

  it("(a2) an explicit namespace equal to the STICKY active namespace also produces NO warning", async () => {
    // Distinguishes "arg was provided" from "resolved == active": an
    // implementation gating on `resolvedNamespace !== config.defaultNamespace`
    // would warn here even though the caller named the namespace.
    const nsName = "df0919-explicit-sticky";
    await createScratchNamespace(nsName);
    const switched = await switchNamespaceTool({ name: nsName });
    expect(switched.success).toBe(true);

    const result = await rememberTool({
      key: "/scratch/df0919-a2",
      domain: "raw_note",
      attributes: {},
      embedding_text: "DF-0919-06 (a2): explicit arg == sticky active",
      namespace: nsName,
    });

    expect(result.success).toBe(true);
    expect(result.namespace).toBe(nsName);
    expect(result.warning).toBeUndefined();
  });

  it("(b) an OMITTED namespace with a non-default sticky active namespace DOES warn", async () => {
    const nsName = "df0919-sticky";
    await createScratchNamespace(nsName);
    const switched = await switchNamespaceTool({ name: nsName });
    expect(switched.success).toBe(true);

    const result = await rememberTool({
      key: "/scratch/df0919-b",
      domain: "raw_note",
      attributes: {},
      embedding_text: "DF-0919-06 (b): omitted arg, sticky non-default",
    });

    expect(result.success).toBe(true);
    expect(result.namespace).toBe(nsName);
    // Text deliberately unchanged from DOGFOOD-017 — only the trigger narrowed.
    expect(result.warning).toBe(
      `Memory written to namespace '${nsName}', not 'default'. The active namespace is sticky across processes — pass namespace explicitly to control where writes land.`,
    );
  });

  it("(c) an explicit namespace='default' produces NO warning", async () => {
    const result = await rememberTool({
      key: "/scratch/df0919-c",
      domain: "raw_note",
      attributes: {},
      embedding_text: "DF-0919-06 (c): explicit default namespace",
      namespace: "default",
    });

    expect(result.success).toBe(true);
    expect(result.namespace).toBe("default");
    expect(result.warning).toBeUndefined();
  });
});
