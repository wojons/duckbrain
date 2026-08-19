/**
 * RETR-011 Regression Tests: fact versioning (valid_from/valid_until) via
 * the MCP recall tool.
 *
 * Guards src/mcp/tools/recall.ts end-to-end against a real seeded namespace
 * (JSONL partition + manifest under the DUCKBRAIN_NAMESPACES_PATH temp
 * root — same pattern as recall-timerange-retr003.test.ts):
 *   - the default CURRENT view excludes rows whose valid_until is in the
 *     past (expired) and rows whose valid_from is in the future (not yet
 *     valid)
 *   - historical=true includes ALL rows — expired facts remain visible
 *     there, with valid_from/valid_until echoed on the rows
 *   - rows written WITHOUT validity fields are unaffected (no regression)
 *   - the keyword (contains=) path validity-scopes its candidates too
 *     (real rebuilt FTS sidecar, rebuildNamespaceIndex)
 *   - the write side (rememberTool) persists valid_from/valid_until
 *
 * Negative verification: the "current view excludes expired" test fails
 * without the buildValidityConditions wiring — a plain queryMemories
 * returns the seeded expired row, and only the RETR-011 filter removes it.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { recallTool } from "./recall";
import { rememberTool } from "./remember";
import { rebuildNamespaceIndex } from "../../search/index";

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const NS = path.join(NS_ROOT, "recall-retr011");
const PARTITION = path.join(NS, "concept", "2026-08");
const JSONL = path.join(PARTITION, "current.jsonl");
const MANIFEST = path.join(NS, "manifest.json");

function mem(
  id: string,
  key: string,
  text: string,
  validity?: { valid_from?: string; valid_until?: string },
): string {
  return JSON.stringify({
    id,
    key,
    domain: "concept",
    timestamp: "2026-08-15T12:00:00.000Z",
    author: "test@example.com",
    action: "add",
    embedding_text: text,
    attributes: {},
    ...(validity?.valid_from !== undefined
      ? { valid_from: validity.valid_from }
      : {}),
    ...(validity?.valid_until !== undefined
      ? { valid_until: validity.valid_until }
      : {}),
  });
}

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

const ROWS = [
  // Control: no validity fields — must behave exactly as before RETR-011.
  mem("m1", "/validity/plain", "plain valid"),
  // Expired: valid_until in the past.
  mem("m2", "/validity/expired", "expired valid", { valid_until: PAST }),
  // Not yet valid: valid_from in the future.
  mem("m3", "/validity/future", "future valid", { valid_from: FUTURE }),
  // Open-ended: valid_until far in the future — currently valid.
  mem("m4", "/validity/open", "open valid", { valid_until: FUTURE }),
  // Full window covering now — currently valid.
  mem("m5", "/validity/window", "window valid", {
    valid_from: PAST,
    valid_until: FUTURE,
  }),
];

beforeAll(() => {
  fs.mkdirSync(PARTITION, { recursive: true });
  fs.writeFileSync(JSONL, ROWS.join("\n") + "\n");
  fs.writeFileSync(
    MANIFEST,
    JSON.stringify({
      partitions: ["concept/2026-08"],
      lastUpdated: new Date().toISOString(),
    }),
  );
});

afterAll(() => {
  fs.rmSync(PARTITION, { recursive: true, force: true });
  fs.rmSync(MANIFEST, { force: true });
  fs.rmSync(path.join(NS, ".search"), { recursive: true, force: true });
  fs.rmSync(path.join(NS, ".embeddings"), { recursive: true, force: true });
});

describe("RETR-011: fact versioning — MCP recall list path", () => {
  it("current view excludes expired (past valid_until) and not-yet-valid (future valid_from) rows", async () => {
    const result = await recallTool({
      keyPrefix: "/validity/",
      namespace: "recall-retr011",
      limit: 50,
    });

    expect(result.error).toBeUndefined();
    const ids = result.memories.map((m) => m.id).sort();
    // m2 (expired) and m3 (future valid_from) must NOT be in the current view.
    expect(ids).toEqual(["m1", "m4", "m5"]);
    expect(result.count).toBe(3);
    // GAP-024: the reported total matches the returned current window.
    expect(result.total).toBe(3);
  });

  it("historical view includes ALL rows and echoes the validity fields", async () => {
    const result = await recallTool({
      keyPrefix: "/validity/",
      namespace: "recall-retr011",
      historical: true,
      limit: 50,
    });

    expect(result.error).toBeUndefined();
    const ids = result.memories.map((m) => m.id).sort();
    expect(ids).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(result.count).toBe(5);

    const byId = new Map(result.memories.map((m) => [m.id, m]));
    // Expired row visible with its valid_until echoed.
    expect(byId.get("m2")?.valid_until).toBe(PAST);
    // Not-yet-valid row visible with its valid_from echoed.
    expect(byId.get("m3")?.valid_from).toBe(FUTURE);
    // Full window echoed on both sides.
    expect(byId.get("m5")?.valid_from).toBe(PAST);
    expect(byId.get("m5")?.valid_until).toBe(FUTURE);
    // Control row carries no validity fields at all.
    expect(byId.get("m1")).not.toHaveProperty("valid_from");
    expect(byId.get("m1")).not.toHaveProperty("valid_until");
  });

  it("omitted validity fields behave identically to before (no regression)", async () => {
    const result = await recallTool({
      key: "/validity/plain",
      namespace: "recall-retr011",
      limit: 10,
    });

    expect(result.error).toBeUndefined();
    expect(result.memories.map((m) => m.id)).toEqual(["m1"]);
    expect(result.total).toBe(1);
  });

  it("explicit historical=false behaves like the default current view", async () => {
    const result = await recallTool({
      keyPrefix: "/validity/",
      namespace: "recall-retr011",
      historical: false,
      limit: 50,
    });

    expect(result.error).toBeUndefined();
    const ids = result.memories.map((m) => m.id).sort();
    expect(ids).toEqual(["m1", "m4", "m5"]);
  });
});

describe("RETR-011: fact versioning — MCP recall keyword (contains=) path", () => {
  beforeAll(async () => {
    await rebuildNamespaceIndex(NS);
  });

  it("current view excludes expired / not-yet-valid keyword candidates", async () => {
    const result = await recallTool({
      contains: "valid",
      namespace: "recall-retr011",
      limit: 50,
    });

    expect(result.error).toBeUndefined();
    const ids = result.memories.map((m) => m.id).sort();
    // Same validity semantics as the list path: m2 + m3 filtered out.
    expect(ids).toEqual(["m1", "m4", "m5"]);
    expect(result.total).toBe(3);
  });

  it("historical keyword view includes the expired rows too", async () => {
    const result = await recallTool({
      contains: "valid",
      namespace: "recall-retr011",
      historical: true,
      limit: 50,
    });

    expect(result.error).toBeUndefined();
    const ids = result.memories.map((m) => m.id).sort();
    expect(ids).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    const byId = new Map(result.memories.map((m) => [m.id, m]));
    expect(byId.get("m2")?.valid_until).toBe(PAST);
  });
});

describe("RETR-011: fact versioning — remember write side", () => {
  it("persists valid_from/valid_until and the stored row obeys the recall views", async () => {
    const write = await rememberTool({
      key: "/validity/written",
      domain: "concept",
      attributes: {},
      embedding_text: "written with an expiry",
      author: "test@example.com",
      namespace: "recall-retr011",
      valid_until: PAST,
    });

    expect(write.success).toBe(true);

    // Current view: the expired write is NOT returned.
    const current = await recallTool({
      key: "/validity/written",
      namespace: "recall-retr011",
      limit: 10,
    });
    expect(current.memories).toEqual([]);
    expect(current.total).toBe(0);

    // Historical view: it IS returned, with valid_until intact.
    const historical = await recallTool({
      key: "/validity/written",
      namespace: "recall-retr011",
      historical: true,
      limit: 10,
    });
    expect(historical.memories).toHaveLength(1);
    expect(historical.memories[0].id).toBe(write.id);
    expect(historical.memories[0].valid_until).toBe(PAST);
  });

  it("a write without validity fields stays current (no regression)", async () => {
    const write = await rememberTool({
      key: "/validity/written-plain",
      domain: "concept",
      attributes: {},
      embedding_text: "plain write",
      author: "test@example.com",
      namespace: "recall-retr011",
    });

    expect(write.success).toBe(true);

    const current = await recallTool({
      key: "/validity/written-plain",
      namespace: "recall-retr011",
      limit: 10,
    });
    expect(current.memories).toHaveLength(1);
    expect(current.memories[0].id).toBe(write.id);
    expect(current.memories[0]).not.toHaveProperty("valid_until");
  });
});
