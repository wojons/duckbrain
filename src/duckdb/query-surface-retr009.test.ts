/**
 * RETR-009 tests: read-only SQL query surface (src/duckdb/query-surface.ts).
 *
 * Covers:
 *   - SELECT with LIKE works read-only over a real namespace fixture
 *   - latest-per-id dedup + tombstone exclusion (recall parity)
 *   - injection safety: every mutating keyword family rejected, multiple
 *     statements rejected, namespace-escaping table functions rejected
 *     (query(), read_json_auto, read_text, ...)
 *   - LIMIT auto-cap: no-LIMIT appended, oversized clamped, LIMIT ALL and
 *     LIMIT expressions rejected, subquery-only LIMIT still capped
 *   - read_json_auto + columns override: duplicate-key attributes rows do
 *     NOT SIGABRT (DOGFOOD-010/018/019 crash class)
 *   - saved templates expand and produce correct results
 *   - the namespace directory is never written to
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  runReadOnlyQuery,
  validateReadOnlySql,
  applyLimitCap,
  resolveQueryTemplate,
  collectNamespaceJsonl,
  ReadOnlyQueryError,
  QUERY_MAX_ROWS,
  QUERY_TEMPLATES,
} from "./query-surface";

let tmpRoot: string;
let nsPath: string;

/** Write a single memory row to a JSONL file under the fixture namespace. */
function writeRow(relPath: string, row: Record<string, unknown>): void {
  const full = path.join(nsPath, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.appendFileSync(full, JSON.stringify(row) + "\n");
}

function row(
  id: string,
  key: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id,
    key,
    domain: "config",
    timestamp: "2026-08-01T00:00:00.000Z",
    author: "test@example.com",
    action: "add",
    embedding_text: "body",
    attributes: {},
    ...overrides,
  };
}

/** Build a fixture namespace with 1005 distinct live rows (cap pressure). */
function seedLargeNamespace(): void {
  for (let i = 0; i < QUERY_MAX_ROWS + 5; i++) {
    writeRow(
      "config/2026-08/current.jsonl",
      row(`bulk-${i}`, `/bulk/key-${i}`, {
        timestamp: `2026-08-01T00:00:0${String(i % 10).padStart(2, "0")}.000Z`,
      }),
    );
  }
}

/** Read every file under the fixture namespace (for the no-writes proof). */
function snapshotNamespace(): Record<string, string> {
  const snap: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else snap[full] = fs.readFileSync(full, "utf8");
    }
  };
  walk(nsPath);
  return snap;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "retr009-"));
  nsPath = path.join(tmpRoot, "ns");
  fs.mkdirSync(path.join(nsPath, "event", "2026-08"), { recursive: true });
  fs.mkdirSync(path.join(nsPath, "config", "2026-08"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("RETR-009: read-only SELECT over a namespace", () => {
  it("SELECT with LIKE works read-only and returns parsed attributes", async () => {
    writeRow(
      "event/2026-08/current.jsonl",
      row("r2", "/incidents/2026-08-14", {
        attributes: { date: "2026-08-14", kind: "incident" },
      }),
    );
    writeRow(
      "event/2026-08/current.jsonl",
      row("r3", "/incidents/2026-08-15", {
        attributes: { date: "2026-08-15", kind: "incident" },
      }),
    );
    writeRow(
      "config/2026-08/current.jsonl",
      row("r1", "/projects/alpha/status"),
    );

    const result = await runReadOnlyQuery(
      nsPath,
      "SELECT key, timestamp, attributes FROM memories WHERE key LIKE '/incidents/%' ORDER BY key",
    );

    expect(result.count).toBe(2);
    expect(result.rows.map((r) => r.key)).toEqual([
      "/incidents/2026-08-14",
      "/incidents/2026-08-15",
    ]);
    expect(result.rows[0]!.attributes).toEqual({
      date: "2026-08-14",
      kind: "incident",
    });
    expect(result.truncated).toBe(true); // no LIMIT → auto-capped
  });

  it("applies latest-per-id dedup and excludes tombstones (recall parity)", async () => {
    writeRow(
      "config/2026-08/current.jsonl",
      row("r1", "/projects/alpha/status", {
        timestamp: "2026-08-01T00:00:00.000Z",
      }),
    );
    writeRow(
      "config/2026-08/current.jsonl",
      row("r1", "/projects/alpha/status", {
        timestamp: "2026-08-02T00:00:00.000Z",
        embedding_text: "updated body",
      }),
    );
    writeRow(
      "config/2026-08/current.jsonl",
      row("r4", "/projects/gone", { action: "tombstone" }),
    );

    const result = await runReadOnlyQuery(
      nsPath,
      "SELECT id, key, embedding_text FROM memories ORDER BY id",
    );

    expect(result.count).toBe(1);
    expect(result.rows[0]!.id).toBe("r1");
    expect(result.rows[0]!.embedding_text).toBe("updated body");
  });

  it("read_json_auto + columns override survives duplicate-key attributes (no SIGABRT)", async () => {
    // RFC 8259 duplicate keys — the DOGFOOD-010/018/019 crash trigger for
    // bare read_json_auto (MAP inference → native throw → std::terminate).
    // The surface must return the row, not abort the process. Written as a
    // RAW string: JSON.parse/stringify would silently collapse the dupes.
    fs.appendFileSync(
      path.join(nsPath, "config/2026-08/current.jsonl"),
      '{"id":"dupe","key":"/dupe/key","domain":"config","timestamp":"2026-08-01T00:00:00.000Z","author":"test@example.com","action":"add","embedding_text":"body","attributes":{"a":1,"a":2}}\n',
    );

    const result = await runReadOnlyQuery(
      nsPath,
      "SELECT key, attributes FROM memories",
    );
    expect(result.count).toBe(1);
    expect(result.rows[0]!.key).toBe("/dupe/key");
    // attributes arrives as raw JSON text then parses to an object
    expect(result.rows[0]!.attributes).toEqual({ a: 2 });
  });

  it("never writes to the namespace directory", async () => {
    writeRow(
      "config/2026-08/current.jsonl",
      row("r1", "/projects/alpha/status"),
    );
    writeRow(
      "config/2026-08/current.jsonl",
      row("r2", "/incidents/2026-08-14"),
    );
    const before = snapshotNamespace();

    await runReadOnlyQuery(
      nsPath,
      "SELECT * FROM memories WHERE key LIKE '/%'",
    );
    await runReadOnlyQuery(nsPath, "SELECT count(*) AS c FROM memories");

    expect(snapshotNamespace()).toEqual(before);
  });

  it("returns an empty result for a namespace with no jsonl files", async () => {
    const emptyNs = path.join(tmpRoot, "empty-ns");
    fs.mkdirSync(emptyNs, { recursive: true });
    const result = await runReadOnlyQuery(emptyNs, "SELECT * FROM memories");
    expect(result.count).toBe(0);
    expect(result.rows).toEqual([]);
  });

  it("collectNamespaceJsonl skips .git/.embeddings/.search and walks subdirs", () => {
    writeRow("event/2026-08/current.jsonl", row("a", "/k/a"));
    writeRow("config/2026-08/current.jsonl", row("b", "/k/b"));
    writeRow("config/2026-08/other.jsonl", row("c", "/k/c"));
    fs.mkdirSync(path.join(nsPath, ".git"), { recursive: true });
    fs.writeFileSync(path.join(nsPath, ".git", "x.jsonl"), "{}");
    fs.mkdirSync(path.join(nsPath, ".embeddings"), { recursive: true });
    fs.writeFileSync(path.join(nsPath, ".embeddings", "y.jsonl"), "{}");
    fs.mkdirSync(path.join(nsPath, ".search"), { recursive: true });
    fs.writeFileSync(path.join(nsPath, ".search", "z.jsonl"), "{}");

    const files = collectNamespaceJsonl(nsPath);
    expect(files.length).toBe(3);
    expect(files.every((f) => f.endsWith(".jsonl"))).toBe(true);
    expect(files.some((f) => f.includes(".git"))).toBe(false);
    expect(files.some((f) => f.includes(".embeddings"))).toBe(false);
    expect(files.some((f) => f.includes(".search"))).toBe(false);
  });

  it("WITH ... SELECT statements are allowed and execute", async () => {
    writeRow(
      "config/2026-08/current.jsonl",
      row("r1", "/projects/alpha/status"),
    );
    const result = await runReadOnlyQuery(
      nsPath,
      "WITH recent AS (SELECT key FROM memories WHERE key LIKE '/projects/%') SELECT key FROM recent",
    );
    expect(result.rows.map((r) => r.key)).toEqual(["/projects/alpha/status"]);
  });
});

describe("RETR-009: injection safety — mutating statements rejected", () => {
  const MUTATING: Array<[string, string]> = [
    ["INSERT", "INSERT INTO memories (id, key) VALUES ('x', '/x')"],
    ["UPDATE", "UPDATE memories SET key = '/hacked'"],
    ["DELETE", "DELETE FROM memories"],
    ["CREATE", "CREATE TABLE x (id VARCHAR)"],
    ["DROP", "DROP TABLE memories"],
    ["ALTER", "ALTER TABLE memories ADD COLUMN x VARCHAR"],
    ["ATTACH", "ATTACH '/tmp/db.duckdb' AS other"],
    ["DETACH", "DETACH other"],
    ["COPY TO", "COPY (SELECT 1) TO '/tmp/out.csv'"],
    ["COPY FROM", "COPY memories FROM '/tmp/in.csv'"],
    ["PRAGMA", "PRAGMA create_fts_index('memories', 'id', 'text')"],
    ["VACUUM", "VACUUM"],
    ["CALL", "CALL pragma_database_size()"],
    ["INSTALL", "INSTALL httpfs"],
    ["LOAD", "LOAD httpfs"],
    ["SET", "SET memory_limit = '1GB'"],
    ["EXPORT", "EXPORT DATABASE '/tmp/db'"],
    ["IMPORT", "IMPORT DATABASE '/tmp/db'"],
    ["BEGIN", "BEGIN TRANSACTION"],
    ["COMMIT", "COMMIT"],
    ["ROLLBACK", "ROLLBACK"],
  ];

  it.each(MUTATING)("rejects %s", async (_label, sql) => {
    expect(() => validateReadOnlySql(sql)).toThrow(ReadOnlyQueryError);
  });

  it("rejects multiple ;-separated statements", () => {
    expect(() => validateReadOnlySql("SELECT 1; DROP TABLE memories")).toThrow(
      /single SQL statement/,
    );
    expect(() => validateReadOnlySql("SELECT 1; SELECT 2")).toThrow(
      /single SQL statement/,
    );
  });

  it("allows a trailing semicolon on a single statement", async () => {
    writeRow(
      "config/2026-08/current.jsonl",
      row("r1", "/projects/alpha/status"),
    );
    const result = await runReadOnlyQuery(nsPath, "SELECT key FROM memories;");
    expect(result.count).toBe(1);
  });

  it("rejects non-SELECT first keywords", () => {
    expect(() => validateReadOnlySql("VALUES (1)")).toThrow(
      /only read-only SELECT/,
    );
    expect(() => validateReadOnlySql("DESCRIBE memories")).toThrow(
      /only read-only SELECT/,
    );
    expect(() => validateReadOnlySql("EXPLAIN SELECT 1")).toThrow(
      /only read-only SELECT/,
    );
  });

  it("rejects empty statements", () => {
    expect(() => validateReadOnlySql("   ")).toThrow(/Empty SQL/);
    expect(() => validateReadOnlySql(";")).toThrow(/Empty SQL/);
  });

  it("does not false-positive on keywords inside string literals", async () => {
    writeRow(
      "config/2026-08/current.jsonl",
      row("r1", "/projects/alpha/status", {
        embedding_text: "INSERT INTO memories VALUES (1)",
      }),
    );
    const result = await runReadOnlyQuery(
      nsPath,
      "SELECT key FROM memories WHERE embedding_text LIKE '%INSERT INTO memories%'",
    );
    expect(result.count).toBe(1);
  });

  it("does not false-positive on keywords inside comments", () => {
    expect(() =>
      validateReadOnlySql("SELECT 1 -- DROP TABLE memories"),
    ).not.toThrow();
    expect(() =>
      validateReadOnlySql("/* DELETE FROM x */ SELECT 1"),
    ).not.toThrow();
  });
});

describe("RETR-009: namespace scoping — escaping table functions rejected", () => {
  it.each([
    ["query() nested SQL", "SELECT * FROM query('SELECT 1')"],
    ["query() in FROM with alias", "SELECT * FROM query('DELETE FROM x') AS q"],
    [
      "read_json_auto direct path",
      "SELECT * FROM read_json_auto('/tmp/x.jsonl')",
    ],
    ["read_json direct path", "SELECT * FROM read_json('/tmp/x.jsonl')"],
    ["read_csv direct path", "SELECT * FROM read_csv('/tmp/x.csv')"],
    [
      "read_parquet direct path",
      "SELECT * FROM read_parquet('/tmp/x.parquet')",
    ],
    ["read_text direct path", "SELECT * FROM read_text('/etc/hostname')"],
    ["glob escape", "SELECT * FROM glob('/tmp/*')"],
    ["sqlite_scan", "SELECT * FROM sqlite_scan('/tmp/x.db', 't')"],
  ])("rejects %s", async (_label, sql) => {
    expect(() => validateReadOnlySql(sql)).toThrow(
      /escapes the namespace scope/,
    );
  });

  it("allows scalar json/string functions over the view", () => {
    expect(() =>
      validateReadOnlySql(
        "SELECT key, json_extract_string(attributes, '$.kind') FROM memories WHERE key LIKE '/incidents/%'",
      ),
    ).not.toThrow();
  });
});

describe("RETR-009: LIMIT auto-cap (GAP-023/024 doctrine)", () => {
  beforeEach(() => seedLargeNamespace());

  it("appends LIMIT cap when the statement has no LIMIT", async () => {
    const { sql, capped } = applyLimitCap("SELECT key FROM memories");
    expect(capped).toBe(true);
    expect(sql.endsWith(`LIMIT ${QUERY_MAX_ROWS}`)).toBe(true);
  });

  it("returns at most QUERY_MAX_ROWS for an uncapped statement", async () => {
    const result = await runReadOnlyQuery(nsPath, "SELECT key FROM memories");
    expect(result.count).toBe(QUERY_MAX_ROWS);
    expect(result.truncated).toBe(true);
  });

  it("clamps an oversized numeric LIMIT", async () => {
    const result = await runReadOnlyQuery(
      nsPath,
      `SELECT key FROM memories LIMIT ${QUERY_MAX_ROWS * 1000}`,
    );
    expect(result.count).toBe(QUERY_MAX_ROWS);
    expect(result.truncated).toBe(true);
  });

  it("keeps a small numeric LIMIT", async () => {
    const result = await runReadOnlyQuery(
      nsPath,
      "SELECT key FROM memories LIMIT 5",
    );
    expect(result.count).toBe(5);
    expect(result.truncated).toBe(false);
  });

  it("rejects LIMIT ALL (would bypass the cap)", () => {
    expect(() => applyLimitCap("SELECT key FROM memories LIMIT ALL")).toThrow(
      /LIMIT must be a numeric literal/,
    );
  });

  it("rejects non-numeric LIMIT expressions", () => {
    expect(() => applyLimitCap("SELECT key FROM memories LIMIT 2+3")).toThrow(
      /LIMIT must be a numeric literal/,
    );
    expect(() =>
      applyLimitCap("SELECT key FROM memories LIMIT (SELECT 1)"),
    ).toThrow(/LIMIT must be a numeric literal/);
  });

  it("caps statements whose only LIMIT sits inside a subquery", async () => {
    // Inner LIMIT 5 is at paren depth > 0, so the top-level cap must still
    // be appended: 5 × 1005 cross join rows → capped at QUERY_MAX_ROWS.
    const result = await runReadOnlyQuery(
      nsPath,
      "SELECT * FROM (SELECT * FROM memories LIMIT 5) a CROSS JOIN memories b",
    );
    expect(result.count).toBe(QUERY_MAX_ROWS);
    expect(result.truncated).toBe(true);
  });

  it("inserts LIMIT before a top-level OFFSET without one", async () => {
    const { sql, capped } = applyLimitCap("SELECT key FROM memories OFFSET 2");
    expect(capped).toBe(true);
    expect(sql).toBe(
      `SELECT key FROM memories LIMIT ${QUERY_MAX_ROWS} OFFSET 2`,
    );
    const result = await runReadOnlyQuery(
      nsPath,
      "SELECT key FROM memories OFFSET 2",
    );
    expect(result.count).toBe(QUERY_MAX_ROWS);
  });

  it("respects a caller-provided smaller cap", async () => {
    const result = await runReadOnlyQuery(
      nsPath,
      "SELECT key FROM memories",
      42,
    );
    expect(result.count).toBe(42);
    expect(result.truncated).toBe(true);
  });
});

describe("RETR-009: saved query templates", () => {
  it("registers the three board templates", () => {
    expect(Object.keys(QUERY_TEMPLATES).sort()).toEqual([
      "cost-series",
      "incidents-by-day",
      "per-project-status",
    ]);
  });

  it("rejects unknown template names with the available list", () => {
    expect(() => resolveQueryTemplate("nope")).toThrow(
      /Unknown template 'nope'/,
    );
    expect(() => resolveQueryTemplate("nope")).toThrow(/incidents-by-day/);
  });

  it("incidents-by-day groups /incidents/YYYY-MM-DD keys per day", async () => {
    writeRow("event/2026-08/current.jsonl", row("i1", "/incidents/2026-08-14"));
    writeRow("event/2026-08/current.jsonl", row("i2", "/incidents/2026-08-15"));
    writeRow("event/2026-08/current.jsonl", row("i3", "/incidents/2026-08-15"));
    writeRow(
      "event/2026-08/current.jsonl",
      row("x1", "/projects/alpha/status"),
    );

    const template = resolveQueryTemplate("incidents-by-day");
    expect(template.defaultNamespace).toBe("hermes-telemetry");
    const result = await runReadOnlyQuery(nsPath, template.sql);

    expect(result.count).toBe(2);
    expect(result.rows[0]!.day).toBe("2026-08-15");
    expect(result.rows[0]!.incidents).toBe(2);
    expect(result.rows[1]!.day).toBe("2026-08-14");
  });

  it("per-project-status extracts the latest status row per project", async () => {
    const body = JSON.stringify({
      priority: 8,
      enabled: true,
      last_tick: "2026-08-07T04:23:13-05:00",
    });
    writeRow(
      "config/2026-08/current.jsonl",
      row("p1", "/fleet/projects/alpha/status", { embedding_text: body }),
    );
    // Status writes carry fresh ids per write (upsert-by-key) — the view's
    // id-dedup keeps every write, so the template must pick the latest: a
    // SECOND alpha write with a NEWER timestamp must win.
    writeRow(
      "config/2026-08/current.jsonl",
      row("p1b", "/fleet/projects/alpha/status", {
        embedding_text: JSON.stringify({
          priority: 9,
          enabled: true,
          last_tick: "2026-08-09T00:00:00-05:00",
        }),
        timestamp: "2026-08-03T00:00:00.000Z",
      }),
    );
    writeRow(
      "config/2026-08/current.jsonl",
      row("p2", "/fleet/projects/beta/status", {
        embedding_text: JSON.stringify({ priority: 2, enabled: false }),
      }),
    );
    // Plain-text bodies (e.g. consensus 'idle tick #N' lines) must project
    // NULLs — json_extract on malformed JSON throws, json_valid guards it.
    writeRow(
      "config/2026-08/current.jsonl",
      row("p3", "/fleet/projects/gamma/status", {
        embedding_text: "Consensus fleet status: idle tick #3, cooldown ...",
      }),
    );

    const template = resolveQueryTemplate("per-project-status");
    expect(template.defaultNamespace).toBe("coding-hermes");
    const result = await runReadOnlyQuery(nsPath, template.sql);

    expect(result.count).toBe(3);
    const byProject = Object.fromEntries(
      result.rows.map((r) => [r.project, r]),
    );
    expect(byProject["alpha"]!.priority).toBe("9");
    expect(byProject["alpha"]!.enabled).toBe("true");
    expect(byProject["alpha"]!.last_tick).toBe("2026-08-09T00:00:00-05:00");
    expect(byProject["beta"]!.enabled).toBe("false");
    expect(byProject["gamma"]!.priority).toBeNull();
    expect(byProject["gamma"]!.enabled).toBeNull();
  });

  it("cost-series extracts the daily estimated cost from /usage/ rows", async () => {
    const usage = JSON.stringify({
      totals: { estimated_cost_usd: 11.08, api_calls: 14925 },
    });
    writeRow(
      "config/2026-08/current.jsonl",
      row("u1", "/usage/2026-08-17", {
        attributes: { date: "2026-08-17", kind: "usage" },
        embedding_text: usage,
      }),
    );
    writeRow(
      "config/2026-08/current.jsonl",
      row("u2", "/usage/2026-08-18", {
        attributes: { date: "2026-08-18", kind: "usage" },
        embedding_text: JSON.stringify({ totals: { estimated_cost_usd: 9.5 } }),
      }),
    );

    const template = resolveQueryTemplate("cost-series");
    expect(template.defaultNamespace).toBe("hermes-telemetry");
    const result = await runReadOnlyQuery(nsPath, template.sql);

    expect(result.count).toBe(2);
    expect(result.rows[0]!.day).toBe("2026-08-17");
    expect(result.rows[0]!.cost_usd).toBe(11.08);
    expect(result.rows[1]!.cost_usd).toBe(9.5);
  });
});
