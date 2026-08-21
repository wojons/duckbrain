/**
 * DB-GAP-035 regression tests: the keys read path survives one torn JSONL
 * line.
 *
 * Live incident (canary GAP-010, persisted since 08-18): a torn write in
 * namespaces/coding-hermes/event/2026-08/10000.jsonl — TWO JSON records
 * concatenated on one line (the first record's id truncated mid-UUID, the
 * second record intact) — made every read_json call without
 * ignore_errors=true abort with `Invalid Input Error: Malformed JSON ...`,
 * so GET /api/keys 500ed for every consumer (PM picker state, my-project
 * canary check #4, MCP recall).
 *
 * Fix: list_keys reads with read_json(..., ignore_errors=true) — one
 * malformed line is skipped (NULL row, filtered out by the WHERE clause)
 * instead of aborting the whole query — and GET /health surfaces the
 * failure via keys_error (probeKeysStore) instead of a false green.
 *
 * The fixture replicates the live torn line byte-for-byte in shape:
 * `{"id":"<truncated-uuid>` concatenated with a complete record.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { listKeysTool, probeKeysStore } from "./list_keys";

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const NS_NAME = "dbgap035-torn";

/** Complete record used as the intact half of the torn line. */
const intactRecord = {
  id: "6853a05e-7f31-4f32-bcb2-70cedf177d70",
  key: "/fleet/events/255422",
  domain: "event",
  timestamp: "2026-08-21T12:00:00.000Z",
  author: "test@example.com",
  action: "add",
  embedding_text: "DB-GAP-035 torn-line fixture",
  attributes: {},
};

/** The live torn-write shape: truncated first record + intact second record. */
const tornLine = `{"id":"66db7ec5-d847-4f23-864a${JSON.stringify(intactRecord)}`;

beforeEach(() => {
  const nsPath = path.join(NS_ROOT, NS_NAME);
  fs.mkdirSync(path.join(nsPath, "event", "2026-08"), { recursive: true });
  fs.writeFileSync(
    path.join(nsPath, "manifest.json"),
    JSON.stringify({
      partitions: ["event/2026-08"],
      lastUpdated: new Date().toISOString(),
    }),
    "utf-8",
  );
  // Torn line FIRST — the strongest case: schema inference and the query
  // must both survive a malformed opening line.
  fs.writeFileSync(
    path.join(nsPath, "event", "2026-08", "current.jsonl"),
    `${tornLine}\n${JSON.stringify(intactRecord)}\n`,
    "utf-8",
  );
});

afterEach(() => {
  fs.rmSync(path.join(NS_ROOT, NS_NAME), { recursive: true, force: true });
});

describe("DB-GAP-035: list_keys survives a torn JSONL line", () => {
  it("returns the intact keys with no error", async () => {
    const result = await listKeysTool({
      prefix: "/",
      maxDepth: 3,
      limit: 10,
      offset: 0,
      namespace: NS_NAME,
    });

    // The query must NOT abort on the malformed line.
    expect(result.error).toBeUndefined();
    // The intact record's key is still visible.
    expect(result.keys).toContain("/fleet/events/255422");
  });
});

describe("DB-GAP-035: probeKeysStore (health)", () => {
  it("returns null when the store answers despite a torn line", async () => {
    expect(await probeKeysStore(NS_NAME)).toBeNull();
  });

  it("returns a short error string when the namespace is missing", async () => {
    const err = await probeKeysStore("dbgap035-does-not-exist");
    expect(typeof err).toBe("string");
    expect(err!.length).toBeLessThanOrEqual(200);
    expect(err).toContain("does not exist");
  });
});
