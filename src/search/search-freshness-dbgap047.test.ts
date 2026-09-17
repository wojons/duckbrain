/**
 * DB-GAP-047 Regression Tests: keyword-search freshness — a read never
 * requires a human `duckbrain search-index rebuild`.
 *
 * The sidecar is a cache (Q-7), so the READ path owns its freshness: when
 * the index is missing or predates the newest source write, the read
 * rebuilds it (bounded, single-flight) and then answers. These tests drive
 * the real thing — no mocks of the search layer, real scratch namespaces
 * under the DUCKBRAIN_NAMESPACES_PATH temp root, real DuckDB `fts` sidecars,
 * and the real Express route for the HTTP surface:
 *
 *   AC1  a fresh namespace + one row answers `contains=<token>` with the row
 *   AC2  a row written seconds earlier is found by `q=<token>` with NO
 *        manual rebuild anywhere in the sequence (the DB-GAP-047 board pin)
 *   AC3  a sidecar that predates the newest write is refreshed before
 *        answering — `meta.indexedAt` advances
 *   AC4  rebuilds are bounded (over-bound namespaces degrade, never build)
 *        and single-flight (concurrent readers share ONE rebuild)
 *   AC5  RETR-007/029 union semantics: an index-less namespace is still
 *        SKIPPED and reported — never rebuilt behind a union search
 *
 * Only the embedding-provider registry is mocked (to the unavailable case),
 * so `?q=` deterministically takes its keyword leg: this suite is about the
 * index's freshness, not about a host-local embedding model. Suite timeouts
 * are explicit because building an FTS sidecar loads the DuckDB extension.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createServer, Server } from "http";
import { createHttpServer } from "../cli/http";
import {
  autoBuildCount,
  autoBuildMaxRows,
  DEFAULT_AUTOBUILD_MAX_ROWS,
  ensureFreshIndex,
  indexFreshness,
  rebuildNamespaceIndex,
  SearchIndexMissingError,
  SEARCH_INDEX_DIR,
} from "./index";
import { keywordSearch, keywordSearchAllNamespaces } from "./query";

// File-scoped budget: read-path tests trigger real bounded rebuilds (DuckDB
// `fts` sidecars) plus an HTTP surface; several tests already carry explicit
// per-test timeouts. vi.setConfig makes the budget file-wide without
// touching vitest.config.ts.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock("../embedding/providers", async () => {
  const actual = await vi.importActual<typeof import("../embedding/providers")>(
    "../embedding/providers",
  );
  return {
    ...actual,
    // No embedding provider available → ?q= runs the keyword leg only.
    createAutoProviders: vi.fn().mockResolvedValue([]),
  };
});

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;

/** Fresh namespace, one row, index never built (AC1/AC2). */
const NS_READ = path.join(NS_ROOT, "dbgap047-read");
/** Indexed, then written to again — the stale case (AC3). */
const NS_STALE = path.join(NS_ROOT, "dbgap047-stale");
/** 3 rows, row bound 2 → must refuse (AC4). */
const NS_BIG = path.join(NS_ROOT, "dbgap047-overbound");
/** Indexed + written to again, over the bound → degrade, don't rebuild (AC4). */
const NS_STALE_BIG = path.join(NS_ROOT, "dbgap047-overbound-stale");
/** Two concurrent readers, no index → ONE rebuild (AC4). */
const NS_CONC = path.join(NS_ROOT, "dbgap047-concurrent");
/** Index-less namespace the union must skip, never build (AC5). */
const NS_UNION = path.join(NS_ROOT, "dbgap047-union-bare");
/** Does not exist — a read must not create it (guard). */
const NS_GHOST = path.join(NS_ROOT, "dbgap047-ghost");
/** Namespace driven through the HTTP route (AC1/AC2 live-ish path). */
const NS_HTTP = path.join(NS_ROOT, "dbgap047-http");

const TOKEN_READ = "zqxwreadtokens";
const TOKEN_STALE = "zqxwstaletoken";
const TOKEN_CONC_A = "zqxwconcalpha";
const TOKEN_CONC_B = "zqxwconcbravo";
const TOKEN_BIG = "zqxwoverboundtoken";
const TOKEN_STALE_BIG_OLD = "zqxwstalebigold";
const TOKEN_STALE_BIG_NEW = "zqxwstalebignew";
const TOKEN_UNION = "zqxwuniontoken";
const TOKEN_HTTP_CONTAINS = "zqxwhttpcontainstoken";
const TOKEN_HTTP_QUERY = "zqxwhttpquerytoken";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function record(id: string, key: string, text: string, day: number): string {
  return JSON.stringify({
    id,
    key,
    domain: "raw_note",
    timestamp: `2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`,
    author: "dbgap047@test.local",
    action: "add",
    embedding_text: text,
    attributes: {},
  });
}

/** Write a namespace with a manifest and one JSONL partition. */
function writeNamespace(
  nsPath: string,
  rows: Array<{ id: string; key: string; text: string; day: number }>,
): void {
  const partition = path.join(nsPath, "concept", "2026-08");
  fs.mkdirSync(partition, { recursive: true });
  fs.writeFileSync(
    path.join(partition, "current.jsonl"),
    rows.map((r) => record(r.id, r.key, r.text, r.day)).join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(nsPath, "manifest.json"),
    JSON.stringify({
      partitions: ["concept/2026-08"],
      lastUpdated: new Date().toISOString(),
    }),
  );
}

/** Append one record to a namespace's partition file. */
function appendRow(
  nsPath: string,
  row: { id: string; key: string; text: string; day: number },
): string {
  const jsonl = path.join(nsPath, "concept", "2026-08", "current.jsonl");
  fs.appendFileSync(jsonl, record(row.id, row.key, row.text, row.day) + "\n");
  return jsonl;
}

beforeAll(() => {
  writeNamespace(NS_READ, [
    { id: "r1", key: "/read/one", text: `one row with ${TOKEN_READ}`, day: 1 },
  ]);
  writeNamespace(NS_STALE, [
    {
      id: "s1",
      key: "/stale/one",
      text: "first row, stale target comes later",
      day: 1,
    },
  ]);
  writeNamespace(NS_BIG, [
    {
      id: "b1",
      key: "/big/one",
      text: `over-bound row ${TOKEN_BIG} a`,
      day: 1,
    },
    {
      id: "b2",
      key: "/big/two",
      text: `over-bound row ${TOKEN_BIG} b`,
      day: 2,
    },
    {
      id: "b3",
      key: "/big/three",
      text: `over-bound row ${TOKEN_BIG} c`,
      day: 3,
    },
  ]);
  writeNamespace(NS_STALE_BIG, [
    {
      id: "sb1",
      key: "/big-stale/one",
      text: `the indexed over-bound row ${TOKEN_STALE_BIG_OLD}`,
      day: 1,
    },
  ]);
  writeNamespace(NS_CONC, [
    { id: "c1", key: "/conc/alpha", text: `alpha row ${TOKEN_CONC_A}`, day: 1 },
    { id: "c2", key: "/conc/bravo", text: `bravo row ${TOKEN_CONC_B}`, day: 2 },
  ]);
  writeNamespace(NS_UNION, [
    { id: "u1", key: "/union/one", text: `union row ${TOKEN_UNION}`, day: 1 },
  ]);
});

afterAll(() => {
  for (const ns of [
    NS_READ,
    NS_STALE,
    NS_BIG,
    NS_STALE_BIG,
    NS_CONC,
    NS_UNION,
    NS_HTTP,
  ]) {
    fs.rmSync(ns, { recursive: true, force: true });
  }
  fs.rmSync(NS_GHOST, { recursive: true, force: true });
});

describe("DB-GAP-047: index freshness", () => {
  it("classifies a namespace with no sidecar as missing", () => {
    const freshness = indexFreshness(NS_READ);
    expect(freshness.state).toBe("missing");
    expect(freshness.indexedAt).toBeNull();
    expect(freshness.indexedAtIso).toBeNull();
    // The source walk sees the row file (so the guard has something to bound).
    expect(freshness.newestSourceMtimeMs).toBeGreaterThan(0);
  });

  it("reports fresh immediately after a rebuild", async () => {
    await rebuildNamespaceIndex(NS_STALE);
    expect(indexFreshness(NS_STALE).state).toBe("fresh");
  }, 60000);

  it("reads the guard's default from the const, not the environment", () => {
    const prev = process.env.DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS;
    delete process.env.DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS;
    try {
      expect(autoBuildMaxRows()).toBe(DEFAULT_AUTOBUILD_MAX_ROWS);
      process.env.DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS = "7";
      expect(autoBuildMaxRows()).toBe(7);
      process.env.DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS = "not-a-number";
      expect(autoBuildMaxRows()).toBe(DEFAULT_AUTOBUILD_MAX_ROWS);
    } finally {
      if (prev === undefined)
        delete process.env.DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS;
      else process.env.DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS = prev;
    }
  });
});

describe("DB-GAP-047: bounded, single-flight rebuild-before-answer", () => {
  it("AC1: a fresh namespace answers a keyword read without a manual rebuild", async () => {
    expect(indexFreshness(NS_READ).state).toBe("missing");

    const res = await keywordSearch(NS_READ, TOKEN_READ, { limit: 10 });

    expect(res.total).toBe(1);
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0].id).toBe("r1");
    expect(res.memories[0].snippet).toContain(TOKEN_READ);
    expect(typeof res.memories[0].score).toBe("number");
    // The read materialised the sidecar it needed, and knows it is fresh.
    expect(
      fs.existsSync(path.join(NS_READ, SEARCH_INDEX_DIR, "fts.duckdb")),
    ).toBe(true);
    expect(indexFreshness(NS_READ).state).toBe("fresh");
    // ...and it rebuilt exactly once.
    expect(autoBuildCount(NS_READ)).toBe(1);

    // A second read on the now-fresh sidecar does NOT rebuild.
    const again = await keywordSearch(NS_READ, TOKEN_READ, { limit: 10 });
    expect(again.total).toBe(1);
    expect(autoBuildCount(NS_READ)).toBe(1);
  }, 60000);

  it("AC3: refreshes a sidecar that predates the newest write", async () => {
    const before = indexFreshness(NS_STALE);
    expect(before.state).toBe("fresh");
    const indexedAtBefore = before.indexedAt;
    expect(indexedAtBefore).not.toBeNull();

    // Let the wall clock pass the previous indexedAt, then append the row
    // and pin its mtime just past the index — deterministic staleness (no
    // reliance on mtime resolution).
    await sleep(15);
    const jsonl = appendRow(NS_STALE, {
      id: "s2",
      key: "/stale/two",
      text: `the pin row ${TOKEN_STALE}`,
      day: 2,
    });
    const pinned = new Date((indexedAtBefore as number) + 1);
    fs.utimesSync(jsonl, pinned, pinned);

    const stale = indexFreshness(NS_STALE);
    expect(stale.state).toBe("stale");
    expect(stale.indexedAt).toBe(indexedAtBefore);

    const res = await keywordSearch(NS_STALE, TOKEN_STALE, { limit: 10 });

    expect(res.total).toBe(1);
    expect(res.memories[0].id).toBe("s2");
    expect(res.memories[0].snippet).toContain(TOKEN_STALE);

    // The answer was served from a REFRESHED sidecar: indexedAt advanced,
    // the new row is in it, and the namespace is fresh again.
    expect(
      fs.existsSync(path.join(NS_STALE, SEARCH_INDEX_DIR, "meta.json")),
    ).toBe(true);
    const meta = JSON.parse(
      fs.readFileSync(
        path.join(NS_STALE, SEARCH_INDEX_DIR, "meta.json"),
        "utf8",
      ),
    ) as { indexedAt: string; rowCount: number };
    expect(Date.parse(meta.indexedAt)).toBeGreaterThan(
      indexedAtBefore as number,
    );
    expect(meta.rowCount).toBe(2);
    expect(indexFreshness(NS_STALE).state).toBe("fresh");
    expect(autoBuildCount(NS_STALE)).toBe(1);
  }, 60000);

  it("AC4: concurrent readers on a missing sidecar share ONE rebuild", async () => {
    expect(indexFreshness(NS_CONC).state).toBe("missing");
    expect(autoBuildCount(NS_CONC)).toBe(0);

    const [alpha, bravo] = await Promise.all([
      keywordSearch(NS_CONC, TOKEN_CONC_A, { limit: 10 }),
      keywordSearch(NS_CONC, TOKEN_CONC_B, { limit: 10 }),
    ]);

    expect(alpha.memories.map((m) => m.id)).toEqual(["c1"]);
    expect(bravo.memories.map((m) => m.id)).toEqual(["c2"]);
    // Two readers, one rebuild — the single-flight promise map.
    expect(autoBuildCount(NS_CONC)).toBe(1);
  }, 60000);

  it("AC4: refuses an over-bound namespace without rebuilding", async () => {
    let refused: Error | null = null;
    try {
      await keywordSearch(NS_BIG, TOKEN_BIG, {
        limit: 10,
        autoBuildMaxRows: 2,
      });
    } catch (error) {
      refused = error as Error;
    }

    // The refusal IS the pre-change error path, and it names the bound.
    expect(refused).toBeInstanceOf(SearchIndexMissingError);
    expect(refused?.message).toContain("search-index rebuild");
    expect(refused?.message).toContain("auto-build skipped");
    expect(refused?.message).toContain("more than 2 source rows");
    expect(refused?.message).toContain("DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS=2");
    // Nothing was written for the refused namespace.
    expect(fs.existsSync(path.join(NS_BIG, SEARCH_INDEX_DIR))).toBe(false);
    expect(autoBuildCount(NS_BIG)).toBe(0);
    expect(indexFreshness(NS_BIG).state).toBe("missing");
  });

  it("AC4: an over-bound namespace with a STALE index degrades — answers from the old index, never rebuilds", async () => {
    // The pre-change behavior for a namespace the guard refuses: use whatever
    // index exists (a refusal must never turn a working read into an error).
    await rebuildNamespaceIndex(NS_STALE_BIG);
    const indexedAt = JSON.parse(
      fs.readFileSync(
        path.join(NS_STALE_BIG, SEARCH_INDEX_DIR, "meta.json"),
        "utf8",
      ),
    ).indexedAt as string;
    await sleep(15);
    const jsonl = appendRow(NS_STALE_BIG, {
      id: "sb2",
      key: "/big-stale/two",
      text: `the newest over-bound row ${TOKEN_STALE_BIG_NEW}`,
      day: 2,
    });
    const pinned = new Date(Date.parse(indexedAt) + 1);
    fs.utimesSync(jsonl, pinned, pinned);
    expect(indexFreshness(NS_STALE_BIG).state).toBe("stale");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const old = await keywordSearch(NS_STALE_BIG, TOKEN_STALE_BIG_OLD, {
        limit: 10,
        autoBuildMaxRows: 1,
      });
      const fresh = await keywordSearch(NS_STALE_BIG, TOKEN_STALE_BIG_NEW, {
        limit: 10,
        autoBuildMaxRows: 1,
      });

      // Answered from the stale index — no throw, no rebuild, no new row.
      expect(old.memories.map((m) => m.id)).toEqual(["sb1"]);
      expect(fresh.total).toBe(0);
      expect(autoBuildCount(NS_STALE_BIG)).toBe(0);
      const after = JSON.parse(
        fs.readFileSync(
          path.join(NS_STALE_BIG, SEARCH_INDEX_DIR, "meta.json"),
          "utf8",
        ),
      ).indexedAt as string;
      expect(after).toBe(indexedAt);
      // ...and the degradation is announced, not silent.
      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).includes("could not be refreshed"),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  }, 60000);

  it("AC4: honours the env bound the same way", async () => {
    const prev = process.env.DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS;
    process.env.DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS = "1";
    try {
      const result = await ensureFreshIndex(NS_BIG);
      expect(result.rebuilt).toBe(false);
      expect(result.reason).toContain("DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS=1");
      // The bound is enforced exactly: 3 rows over a bound of 1.
      expect(result.freshness.state).toBe("missing");
    } finally {
      if (prev === undefined)
        delete process.env.DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS;
      else process.env.DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS = prev;
    }
    expect(fs.existsSync(path.join(NS_BIG, SEARCH_INDEX_DIR))).toBe(false);
  });

  it("AC5: the all-namespaces union still SKIPS an index-less namespace", async () => {
    const res = await keywordSearchAllNamespaces(NS_ROOT, TOKEN_UNION, {
      namespaces: [path.basename(NS_UNION)],
    });

    // RETR-007 contract untouched: skipped + reported, never rebuilt.
    expect(res.memories).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.namespacesSearched).toEqual([]);
    expect(res.namespacesSkipped).toEqual([path.basename(NS_UNION)]);
    expect(fs.existsSync(path.join(NS_UNION, SEARCH_INDEX_DIR))).toBe(false);
    expect(autoBuildCount(NS_UNION)).toBe(0);
  }, 60000);

  it("never materialises a sidecar (or a directory) for a namespace that does not exist", async () => {
    await expect(keywordSearch(NS_GHOST, "anything")).rejects.toThrow(
      /namespace directory not found/,
    );
    expect(fs.existsSync(NS_GHOST)).toBe(false);
  });
});

describe("DB-GAP-047: HTTP read paths answer without a manual rebuild", () => {
  let server: Server;
  let port: number;

  interface HttpResponse {
    status: number;
    body: any;
  }

  function httpRequest(
    method: string,
    p: string,
    body?: unknown,
  ): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const http = require("http");
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const options: any = {
        hostname: "127.0.0.1",
        port,
        path: p,
        method,
        headers: {
          Host: "localhost",
          "Content-Type": "application/json",
          ...(payload !== undefined
            ? { "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
      };
      const req = http.request(options, (res: any) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  beforeAll(async () => {
    const app = createHttpServer();
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") port = addr.port;
        resolve();
      });
    });
  }, 30000);

  afterAll(() => {
    server.close();
    fs.rmSync(NS_HTTP, { recursive: true, force: true });
  });

  it("AC1: ?contains=<token> returns 200 with the row on a fresh namespace (was 500)", async () => {
    // The write creates the namespace: no sidecar exists yet.
    const written = await httpRequest(
      "POST",
      `/api/memories?namespace=${path.basename(NS_HTTP)}`,
      {
        key: "/http/contains",
        domain: "raw_note",
        content: `a row written through HTTP with ${TOKEN_HTTP_CONTAINS}`,
      },
    );
    expect(written.status).toBe(201);
    expect(indexFreshness(NS_HTTP).state).toBe("missing");

    const { status, body } = await httpRequest(
      "GET",
      `/api/memories?namespace=${path.basename(NS_HTTP)}&contains=${TOKEN_HTTP_CONTAINS}`,
    );

    // The regression: this used to be
    // 500 {"error":"Keyword search failed: No keyword search index ..."}.
    expect(status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(written.body.id);
    expect(body.items[0].content).toContain(TOKEN_HTTP_CONTAINS);
    expect(body.items[0].snippet).toContain(TOKEN_HTTP_CONTAINS);
    expect(body.error).toBeUndefined();
    expect(indexFreshness(NS_HTTP).state).toBe("fresh");
  }, 60000);

  it("AC2 (pin): ?q=<token> finds a row written seconds earlier — no manual rebuild", async () => {
    const written = await httpRequest(
      "POST",
      `/api/memories?namespace=${path.basename(NS_HTTP)}`,
      {
        key: "/http/pin",
        domain: "raw_note",
        content: `the pin row written seconds ago ${TOKEN_HTTP_QUERY}`,
      },
    );
    expect(written.status).toBe(201);

    const { status, body } = await httpRequest(
      "GET",
      `/api/memories?namespace=${path.basename(NS_HTTP)}&q=${TOKEN_HTTP_QUERY}&limit=10`,
    );

    expect(status).toBe(200);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.map((m: any) => m.id)).toContain(written.body.id);
  }, 60000);
});
