/**
 * DOGFOOD-014 P2 Regression Tests: get_compaction_stats must return REAL
 * stats for the ACTIVE namespace — never the all-zero stats produced by the
 * hardcoded legacy path cwd/.duckbrain/namespaces/default.
 *
 * Root cause: src/git/squash.ts had two hardcoded legacy-path fallbacks —
 * getCompactionStats() (scans cwd/.duckbrain/namespaces/default when no
 * namespacePath is passed) and compactHistory() ("assume default namespace
 * for now"). Configured deployments use namespacesPath="./namespaces" +
 * defaultNamespace="<active>" (e.g. eduos.dexdat.com.co), so the legacy
 * path never exists → get_compaction_stats returned a zeroed stats object
 * on every configured deployment.
 *
 * Fix: the MCP tool now resolves the namespace like every other tool
 * (resolveNamespacePath from config namespacesPath + defaultNamespace,
 * DOGFOOD-017) and echoes the resolved name in the response; the squash
 * tool passes it into compactHistory; REST routes accept ?namespace=.
 *
 * Regressions guarded:
 *  (a) getCompactionStatsTool({}) on a POPULATED active namespace returns
 *      non-zero totalRecords/tombstoneRecords — not zeros
 *  (b) getCompactionStatsTool({namespace: "..."}) targets THAT namespace
 *      (different content → different stats, proves targeting works)
 *  (c) the ACTIVE namespace is honored: after the config defaultNamespace
 *      changes, the omitted-arg call scans the new active namespace
 *  (d) squash history-compaction resolves the namespace too — squashTool
 *      dryRun succeeds against the config-resolved path instead of failing
 *      with "Default namespace not found"
 *
 * Isolation: the suite's test-setup.ts already redirects the config FILE
 * (DUCKBRAIN_CONFIG_PATH, GAP-022) and namespace storage
 * (DUCKBRAIN_NAMESPACES_PATH, BUG-037) to per-worker temp dirs — the
 * tracked duckbrain.config.json at the repo root is never touched. The
 * snapshot/restore below guards the temp config only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { rememberTool } from "./remember";
import { forgetTool } from "./forget";
import { createNamespaceTool } from "./namespace";
import { getCompactionStatsTool, squashTool } from "./squash";
import { updateConfig } from "../../config/index";

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

afterEach(() => {
  // Restore the (temp) config file so the test never leaks mappings or a
  // switched defaultNamespace.
  if (configSnapshot) {
    fs.writeFileSync(CONFIG_PATH, configSnapshot, "utf-8");
  } else if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
  }
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

/** Seed one memory via the real write path; returns its id. */
async function seedMemory(key: string, namespace?: string): Promise<string> {
  const result = await rememberTool({
    key,
    domain: "raw_note",
    attributes: { source: "dogfood014" },
    embedding_text: `DOGFOOD-014 seed: ${key}`,
    ...(namespace ? { namespace } : {}),
  });
  expect(result.success).toBe(true);
  return result.id!;
}

describe("DOGFOOD-014: get_compaction_stats resolves the active namespace", () => {
  it("(a) returns REAL non-zero stats for the populated active namespace — not zeros", async () => {
    // Seed the active namespace ('default' in the fresh test config): 2
    // memories + 1 tombstone via the real write path.
    const id = await seedMemory("/scratch/dogfood014-a1");
    await seedMemory("/scratch/dogfood014-a2");
    const forgotten = await forgetTool({ id });
    expect(forgotten.success).toBe(true);

    const result = await getCompactionStatsTool({});

    expect(result.success).toBe(true);
    // DOGFOOD-014: the response must echo the namespace actually scanned.
    expect(result.namespace).toBe("default");
    // On the unfixed code this scanned cwd/.duckbrain/namespaces/default
    // (never exists in configured deployments) → all zeros.
    expect(result.stats!.totalRecords).toBeGreaterThanOrEqual(3);
    expect(result.stats!.tombstoneRecords).toBeGreaterThanOrEqual(1);
    expect(result.stats!.totalPartitions).toBeGreaterThanOrEqual(1);
  });

  it("(b) an explicit namespace param targets that namespace", async () => {
    const nsName = "second-ns";
    await createScratchNamespace(nsName);
    // Different content from the active namespace: 1 memory, no tombstones.
    await seedMemory("/scratch/dogfood014-b1", nsName);

    const result = await getCompactionStatsTool({ namespace: nsName });

    expect(result.success).toBe(true);
    expect(result.namespace).toBe(nsName);
    expect(result.stats!.totalRecords).toBe(1);
    expect(result.stats!.tombstoneRecords).toBe(0);
    // Targeting proof: the default namespace's seeded records (3 from (a))
    // must NOT leak into the explicit namespace's stats.
    expect(result.stats!.totalRecords).not.toBeGreaterThan(1);
  });

  it("(c) honors the ACTIVE namespace from config defaultNamespace (the DOGFOOD-014 failure mode)", async () => {
    const nsName = "dogfood014-active";
    // Switch the active namespace in the config FILE (same mechanism as
    // switch_namespace, DOGFOOD-017). resolveNamespacePath then points at
    // <namespacesPath>/dogfood014-active — never the legacy hardcoded path.
    updateConfig(".", { defaultNamespace: nsName });
    const seeded = await seedMemory("/scratch/dogfood014-c1");
    expect(seeded).toBeTruthy();
    createdNamespaces.push(nsName);

    const result = await getCompactionStatsTool({});

    expect(result.success).toBe(true);
    expect(result.namespace).toBe(nsName);
    expect(result.stats!.totalRecords).toBe(1);
    expect(result.stats!.tombstoneRecords).toBe(0);
  });
});

describe("DOGFOOD-014: squash history-compaction resolves the namespace", () => {
  it("(d) dryRun succeeds against the config-resolved namespace (no 'Default namespace not found')", async () => {
    // Active namespace exists (test-setup creates 'default'): compactHistory
    // must resolve it via config, not fail on the legacy path. Partitions
    // are fresh so nothing compacts, but success:true proves the resolved
    // path was scanned (old code: legacy path missing → success:false).
    const result = await squashTool({ dryRun: true, aggressive: false });

    expect(result.success).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it("(e) an explicit namespace is passed through to compactHistory", async () => {
    const nsName = "second-ns";
    await createScratchNamespace(nsName);
    await seedMemory("/scratch/dogfood014-e1", nsName);

    const result = await squashTool({
      dryRun: true,
      aggressive: false,
      namespace: nsName,
    });

    expect(result.success).toBe(true);
    expect(result.errors).toBeUndefined();
  });
});
