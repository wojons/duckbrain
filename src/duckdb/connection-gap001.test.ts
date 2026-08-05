/**
 * GAP-001 Regression Tests: cross-process DuckDB file-lock contention
 *
 * Root cause: singleton connections opened <namespace>/duckdb.db in
 * read-write mode. DuckDB allows exactly ONE read-write handle per file,
 * so the first process to open a namespace (e.g. a fleet stdio MCP server)
 * held an exclusive lock and every other process (http daemon, other stdio
 * servers) got a silently-broken connection — DUCKDB_CONNECTION_LOST on
 * first query. Writes (JSONL appends) never touched the file, which is why
 * namespaces appeared "write-only".
 *
 * Fix: singleton connections open a per-process scratch file in os.tmpdir()
 * and never touch the namespace directory, so foreign read-write locks on
 * <namespace>/duckdb.db are irrelevant to readers.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  getDuckDBConnection,
  evictConnection,
  closeAllConnections,
} from "./connection";

describe("GAP-001: singleton connections use per-process scratch files", () => {
  let nsDir: string | null = null;

  afterEach(async () => {
    await closeAllConnections();
    if (nsDir) {
      fs.rmSync(nsDir, { recursive: true, force: true });
      nsDir = null;
    }
  });

  it("runs read_json queries without creating or opening <namespace>/duckdb.db", async () => {
    nsDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-gap001-"));
    const partDir = path.join(nsDir, "raw_note");
    fs.mkdirSync(partDir, { recursive: true });
    fs.writeFileSync(
      path.join(partDir, "chunk_1.jsonl"),
      JSON.stringify({
        id: "gap001-m1",
        key: "/gap001/test",
        domain: "raw_note",
        timestamp: new Date().toISOString(),
        author: "gap001",
        action: "add",
        embedding_text: "cross-namespace read regression",
        attributes: {},
      }) + "\n",
    );

    const db = getDuckDBConnection("singleton", nsDir);
    const jsonl = path.join(partDir, "chunk_1.jsonl").replace(/\\/g, "/");
    const rows = await new Promise<any[]>((resolve, reject) => {
      db.all(
        `SELECT key FROM read_json(['${jsonl}'], format='newline_delimited')`,
        (err: any, res: any) => (err ? reject(err) : resolve(res || [])),
      );
    });

    expect(rows.map((r) => r.key)).toContain("/gap001/test");

    // The fix: after a real query, the namespace's duckdb.db must NOT exist.
    // Old code created+locked it here; new code uses a tmpdir scratch file.
    expect(fs.existsSync(path.join(nsDir, "duckdb.db"))).toBe(false);
  });

  it("keeps singleton caching semantics (one instance per namespace path)", () => {
    const a = getDuckDBConnection("singleton", "gap001-ns-a");
    expect(getDuckDBConnection("singleton", "gap001-ns-a")).toBe(a);
    expect(getDuckDBConnection("singleton", "gap001-ns-b")).not.toBe(a);
  });

  it("recycles scratch files: eviction removes the cached instance", async () => {
    nsDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-gap001-evict-"));
    const first = getDuckDBConnection("singleton", nsDir);
    evictConnection(nsDir);
    const second = getDuckDBConnection("singleton", nsDir);
    expect(second).not.toBe(first);
    expect(getDuckDBConnection("singleton", nsDir)).toBe(second);
  });
});
