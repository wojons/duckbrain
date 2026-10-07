/**
 * OBS-DUCKBRAIN-001 unit tests: per-route read ledger module.
 *
 * Covers append + rotation + read-back aggregation over arbitrary historical
 * windows (including windows entirely older than any process's uptime — the
 * acceptance criterion for queryability), route normalization, namespace
 * attribution, the no-secrets guarantee, and the malformed-line contract.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createReadLedgerStore,
  readReadRows,
  aggregateReadRows,
  normalizeReadRoute,
  readRowNamespace,
  flushReadLedgerForTests,
  ReadRowSchema,
  readsSegmentName,
  readsSegmentNumber,
  READS_DIR,
  READS_FILE,
  READS_MAX_BYTES,
} from "./readLedger";
import { isReadsQuerySurface } from "./middleware/readLedger";

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-readledger-"));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

const nsRoot = (): string => scratch;

describe("readLedger store: append + read-back", () => {
  it("appends one JSONL row per read and reads them back chronologically", async () => {
    const store = createReadLedgerStore(nsRoot());
    await store.append({
      ts: "2026-10-01T10:00:00.000Z",
      route: "GET /api/memories",
      method: "GET",
      ns: null,
      status: 200,
      dur_ms: 12,
    });
    await store.append({
      ts: "2026-10-02T10:00:00.000Z",
      route: "GET /activity",
      method: "GET",
      ns: "research",
      status: 200,
      dur_ms: 3,
    });
    await flushReadLedgerForTests();

    const { rows, skippedMalformed, filesRead } = readReadRows(nsRoot());
    expect(rows).toHaveLength(2);
    expect(rows[0].route).toBe("GET /api/memories");
    expect(rows[0].ns).toBeNull();
    expect(rows[1].route).toBe("GET /activity");
    expect(rows[1].ns).toBe("research");
    expect(skippedMalformed).toBe(0);
    expect(filesRead).toEqual([READS_FILE]);
  });

  it("writes rows with 0600 file mode into .duckbrain-audit/reads.jsonl", async () => {
    const store = createReadLedgerStore(nsRoot());
    await store.append({
      ts: new Date().toISOString(),
      route: "GET /api/keys",
      method: "GET",
      ns: null,
      status: 200,
      dur_ms: 1,
    });
    await flushReadLedgerForTests();

    const file = path.join(scratch, READS_DIR, READS_FILE);
    expect(fs.existsSync(file)).toBe(true);
    // umask can only NARROW the requested mode; assert the secret-relevant
    // group/other bits never survive.
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it("seals segments monotonically when the bound is exceeded and keeps all rows queryable", async () => {
    const store = createReadLedgerStore(nsRoot(), { maxBytes: 300 });
    for (let i = 0; i < 16; i++) {
      await store.append({
        ts: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
        route: "GET /api/memories",
        method: "GET",
        ns: null,
        status: 200,
        dur_ms: i,
      });
    }
    await flushReadLedgerForTests();

    const dir = path.join(scratch, READS_DIR);
    const names = fs.readdirSync(dir).sort();
    // Two+ sealed segments plus the active file, in monotonic order.
    const sealed = names.filter((n) => readsSegmentNumber(n) !== null);
    expect(sealed.length).toBeGreaterThanOrEqual(2);
    expect(sealed).toEqual([...sealed].sort()); // zero-padded: lexicographic == numeric
    expect(fs.statSync(path.join(dir, READS_FILE)).size).toBeLessThanOrEqual(300);

    // No row is ever lost to rotation — the reads.0001 rm-overwrite failure
    // mode (single .1 slot) cannot happen by construction.
    const { rows, filesRead } = readReadRows(nsRoot());
    expect(rows).toHaveLength(16);
    expect(filesRead[0]).toBe(readsSegmentName(1));
    expect(filesRead[filesRead.length - 1]).toBe(READS_FILE);
    expect(filesRead).toEqual([...filesRead].sort());
  });

  it("rejects a row that violates the schema and logs instead of appending", async () => {
    const logged: string[] = [];
    const store = createReadLedgerStore(nsRoot(), {
      log: (m) => logged.push(m),
    });
    await store.append({
      ts: "not-a-timestamp",
      route: "GET /api/memories",
      method: "GET",
      ns: null,
      status: 99999,
      dur_ms: -5,
    } as any);
    await flushReadLedgerForTests();

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("read ledger append failed");
    const { rows } = readReadRows(nsRoot());
    expect(rows).toHaveLength(0);
  });
});

describe("normalizeReadRoute", () => {
  it("records the documented read routes, GET and HEAD", () => {
    expect(normalizeReadRoute("GET", "/api/memories")).toBe("GET /api/memories");
    expect(normalizeReadRoute("HEAD", "/api/memories")).toBe("HEAD /api/memories");
    expect(normalizeReadRoute("GET", "/api/memories/key//a/b/secret-key")).toBe(
      "GET /api/memories/key/:key",
    );
    expect(normalizeReadRoute("GET", "/api/memories/abc123")).toBe("GET /api/memories/:id");
    expect(normalizeReadRoute("GET", "/api/keys")).toBe("GET /api/keys");
    expect(normalizeReadRoute("GET", "/api/keys/flat")).toBe("GET /api/keys/flat");
    expect(normalizeReadRoute("GET", "/api/namespaces")).toBe("GET /api/namespaces");
    expect(normalizeReadRoute("GET", "/api/ns/research/tables")).toBe("GET /api/ns/:ns/tables");
    expect(normalizeReadRoute("GET", "/api/ns/research/tables/notes")).toBe(
      "GET /api/ns/:ns/tables/:table",
    );
    expect(normalizeReadRoute("GET", "/activity")).toBe("GET /activity");
    expect(normalizeReadRoute("GET", "/api/events/research")).toBe("GET /api/events/:ns");
    expect(normalizeReadRoute("GET", "/api/events/research/stats")).toBe(
      "GET /api/events/:ns/stats",
    );
  });

  it("strips real values: the normalized route never contains the key", () => {
    const route = normalizeReadRoute("GET", "/api/memories/key/alpha/beta");
    expect(route).not.toContain("alpha");
    expect(route).not.toContain("beta");
  });

  it("folds trailing slashes like Express non-strict routing", () => {
    expect(normalizeReadRoute("GET", "/api/keys/")).toBe("GET /api/keys");
    expect(normalizeReadRoute("GET", "/activity///")).toBe("GET /activity");
  });

  it("never records writes, metrics, or unknown routes", () => {
    expect(normalizeReadRoute("POST", "/api/memories")).toBeNull();
    expect(normalizeReadRoute("PUT", "/api/memories/abc")).toBeNull();
    expect(normalizeReadRoute("DELETE", "/api/keys")).toBeNull();
    expect(normalizeReadRoute("GET", "/health")).toBeNull();
    expect(normalizeReadRoute("GET", "/stats")).toBeNull();
    expect(normalizeReadRoute("GET", "/api/reads")).toBeNull();
    expect(normalizeReadRoute("GET", "/api/compaction")).toBeNull();
    expect(normalizeReadRoute("GET", "/namespaces")).toBeNull(); // legacy mount not in the read set
    expect(normalizeReadRoute("GET", "/api/unknown")).toBeNull();
    expect(normalizeReadRoute("GET", "/api/ns/research/changes")).toBeNull(); // realtime SSE
    expect(normalizeReadRoute("GET", "/api/ns/research/openapi.json")).toBeNull();
  });

  it("never lets a query string reach the recorded route", () => {
    const route = normalizeReadRoute("GET", "/api/memories?q=top+secret&token=x");
    expect(route).toBe("GET /api/memories");
    expect(route).not.toContain("secret");
    expect(route).not.toContain("token");
  });
});

describe("readRowNamespace", () => {
  it("prefers the path namespace, then ?namespace=, else null", () => {
    expect(readRowNamespace("/api/events/research", {})).toBe("research");
    expect(readRowNamespace("/api/ns/research/tables", {})).toBe("research");
    expect(readRowNamespace("/api/memories", { namespace: "alpha" })).toBe("alpha");
    expect(readRowNamespace("/api/memories", {})).toBeNull();
    expect(readRowNamespace("/api/memories", { namespace: "" })).toBeNull();
    expect(readRowNamespace("/api/memories", { namespace: ["a", "b"] })).toBeNull();
  });

  it("URL-decodes path namespaces and survives malformed encoding", () => {
    expect(readRowNamespace("/api/events/my%20ns", {})).toBe("my ns");
    expect(readRowNamespace("/api/events/100%-bad", {})).toBe("100%-bad");
  });
});

describe("aggregateReadRows (query over arbitrary windows)", () => {
  const seed = async (): Promise<void> => {
    const store = createReadLedgerStore(nsRoot());
    const rows = [
      { ts: "2026-01-01T00:00:00.000Z", route: "GET /api/memories", method: "GET", ns: null, status: 200, dur_ms: 10 },
      { ts: "2026-03-01T00:00:00.000Z", route: "GET /api/memories", method: "GET", ns: "alpha", status: 200, dur_ms: 20 },
      { ts: "2026-05-01T00:00:00.000Z", route: "GET /activity", method: "GET", ns: null, status: 404, dur_ms: 5 },
      { ts: "2026-09-30T23:59:59.000Z", route: "GET /api/keys", method: "GET", ns: null, status: 200, dur_ms: 7 },
    ];
    for (const row of rows) await store.append(row);
    await flushReadLedgerForTests();
  };

  it("aggregates per-route counts with status breakdown over the whole ledger", async () => {
    await seed();
    const agg = aggregateReadRows(nsRoot());
    expect(agg.total).toBe(4);
    expect(agg.routes.map((r) => [r.route, r.count])).toEqual([
      ["GET /api/memories", 2],
      ["GET /activity", 1],
      ["GET /api/keys", 1],
    ]);
    expect(agg.by_status).toEqual({ "200": 3, "404": 1 });
    const memories = agg.routes.find((r) => r.route === "GET /api/memories");
    expect(memories?.statuses).toEqual({ "200": 2 });
    expect(agg.skipped_malformed).toBe(0);
  });

  it("filters to a historical window entirely older than process uptime", async () => {
    await seed();
    // Process started ~now (2026-10+); the window is Jan–Feb 2026 — older
    // than uptime by many months. The disk-backed ledger still answers.
    const agg = aggregateReadRows(nsRoot(), {
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
    });
    expect(agg.total).toBe(1);
    expect(agg.routes[0].route).toBe("GET /api/memories");
    expect(agg.window.from).toBe("2026-01-01T00:00:00.000Z");
    expect(agg.window.to).toBe("2026-02-01T00:00:00.000Z");
  });

  it("bounds are inclusive on both edges", async () => {
    await seed();
    const agg = aggregateReadRows(nsRoot(), {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-01T00:00:00.000Z",
    });
    expect(agg.total).toBe(1);
  });

  it("filters by route template and by ns", async () => {
    await seed();
    const byRoute = aggregateReadRows(nsRoot(), { route: "GET /api/memories" });
    expect(byRoute.total).toBe(2);
    const byNs = aggregateReadRows(nsRoot(), { ns: "alpha" });
    expect(byNs.total).toBe(1);
    expect(byNs.routes[0].route).toBe("GET /api/memories");
  });

  it("confinement: ungranted namespaces are excluded, null-ns rows stay visible", async () => {
    await seed();
    // Seed: 3 null-ns rows + 1 alpha row. The only ns-bearing row IS alpha.
    const all = aggregateReadRows(nsRoot());
    expect(all.total).toBe(4);
    // Granted "alpha" → the alpha row stays AND every null-ns row stays
    // (they carry no namespace name at all, so nothing can be leaked).
    const granted = aggregateReadRows(nsRoot(), { visibleNamespaces: ["alpha"] });
    expect(granted.total).toBe(4);
    expect(granted.total).toBe(all.total);
    // Ungranted "beta" → exactly the one alpha-foreign row disappears.
    const other = aggregateReadRows(nsRoot(), { visibleNamespaces: ["beta"] });
    expect(other.total).toBe(all.total - 1);
  });

  it("skips malformed lines without dying and reports the count", async () => {
    const dir = path.join(scratch, READS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, READS_FILE),
      [
        JSON.stringify({
          ts: "2026-02-02T00:00:00.000Z",
          route: "GET /api/keys",
          method: "GET",
          ns: null,
          status: 200,
          dur_ms: 1,
        }),
        "{ torn line",
        "",
      ].join("\n") + "\n",
      "utf-8",
    );
    const agg = aggregateReadRows(nsRoot());
    expect(agg.total).toBe(1);
    expect(agg.skipped_malformed).toBe(1);
    expect(agg.files_read).toEqual([READS_FILE]);
  });

  it("answers an empty/absent ledger with a clean zero aggregate", () => {
    const agg = aggregateReadRows(nsRoot());
    expect(agg.total).toBe(0);
    expect(agg.routes).toEqual([]);
    expect(agg.files_read).toEqual([]);
    expect(agg.skipped_malformed).toBe(0);
  });
});

describe("secrets guarantee", () => {
  it("a serialized row contains no key values, query strings, tokens, or content", async () => {
    const store = createReadLedgerStore(nsRoot());
    await store.append({
      ts: "2026-10-06T00:00:00.000Z",
      route: "GET /api/memories/key/:key",
      method: "GET",
      ns: null,
      status: 200,
      dur_ms: 4,
    });
    await flushReadLedgerForTests();

    const raw = fs.readFileSync(
      path.join(scratch, READS_DIR, READS_FILE),
      "utf-8",
    );
    const parsed = ReadRowSchema.parse(JSON.parse(raw.trim()));
    expect(Object.keys(parsed).sort()).toEqual(
      ["dur_ms", "method", "ns", "route", "status", "ts"].sort(),
    );
    expect(raw).not.toContain("super-secret-key-value");
    expect(raw).not.toContain("?q=");
    expect(raw).not.toContain("Bearer");
    expect(raw).not.toContain("sk-");
  });
});

describe("isReadsQuerySurface", () => {
  it("matches the query surface with or without trailing slash", () => {
    expect(isReadsQuerySurface("/api/reads")).toBe(true);
    expect(isReadsQuerySurface("/api/reads?from=2026-01-01")).toBe(true);
    expect(isReadsQuerySurface("/api/reads/")).toBe(true);
    expect(isReadsQuerySurface("/api/memories")).toBe(false);
    expect(isReadsQuerySurface("/api/readsx")).toBe(false);
  });
});

describe("bound constants", () => {
  it("mirror the server denial ledger budget", () => {
    expect(READS_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});
