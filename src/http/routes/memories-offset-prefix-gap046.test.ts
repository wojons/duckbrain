/**
 * DB-GAP-046 Regression Tests: GET /api/memories ?prefix= + ?offset= returned
 * an EMPTY page for every offset >= limit.
 *
 * Live evidence (ops/dogfood-e2e.sh phase 7, two consecutive runs): 25 rows
 * under /dogfood/page-*, then prefix paging returned 10 rows at offset=0 and
 * 0 rows at offset=10 — while the same rows were provably present (an after=
 * probe returned all 25 and an offset=0 prefix list returned 10).
 *
 * Root cause (src/http/routes/memories.ts): the route asked recallTool for
 * `limit + 1` rows (the FIRST page only) and then applied the offset with a
 * JS `slice(offset, offset + limit)` on that already-truncated page. At
 * offset=10/limit=10 the slice started at index 10 of a 10-row array → [].
 * The offset was applied AFTER the query layer's LIMIT instead of inside it,
 * so it could never reach rows the LIMIT never fetched.
 *
 * These tests seed real namespaces (JSONL partition + manifest) under the
 * test-setup temp root and exercise the full pipeline: route → recallTool →
 * DuckDB. Seeding is a plain JSONL write — no HTTP write path and NO
 * DUCKBRAIN_* env mutation, so there is nothing to leak or restore; the
 * repo-root instance config is asserted byte-identical (GAP-022 AC1).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHttpServer } from "../../cli/http";
import { createServer, Server } from "http";
import fs from "fs";
import path from "path";

let server: Server;
let port: number;

interface HttpResponse {
  status: number;
  body: any;
}

function httpRequest(method: string, path: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const options: any = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        Host: "localhost",
        "Content-Type": "application/json",
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
    req.end();
  });
}

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const PARTITION_REL = "raw_note/2026-09";

// Primary shape (this brief): 25 rows under event/demo/<i>.
const NS_NAME = "gap046";
const NS = path.join(NS_ROOT, NS_NAME);
const PREFIX = "event/demo/";

// The exact production reproduction: 25 rows under /dogfood/page-<i>, paged
// with a LEADING-SLASH prefix.
const LIVE_NS_NAME = "gap046-live";
const LIVE_NS = path.join(NS_ROOT, LIVE_NS_NAME);
const LIVE_PREFIX = "/dogfood/page-";

const SEEDED = 25;
const PAGE = 10;

const REPO_CONFIG = path.join(process.cwd(), "duckbrain.config.json");

function readRepoConfig(): string | null {
  return fs.existsSync(REPO_CONFIG)
    ? fs.readFileSync(REPO_CONFIG, "utf-8")
    : null;
}

/**
 * Deterministic seed rows: distinct timestamps (so the newest-first ordering
 * is total) and stable ids/keys, so a page can be asserted EXACTLY — not just
 * by length. Newest-first order is <prefix>25 … <prefix>1.
 */
function seedMemory(prefix: string, i: number) {
  return {
    id: `gap046-${prefix}-${i}`,
    key: `${prefix}${i}`,
    domain: "raw_note",
    timestamp: `2026-09-01T00:00:${String(i).padStart(2, "0")}.000Z`,
    author: "gap046@test.local",
    action: "add",
    embedding_text: `DB-GAP-046 seed memory ${i}`,
    attributes: {},
  };
}

/** Newest-first expected key order for a seeded prefix. */
function expectedOrder(prefix: string): string[] {
  return Array.from({ length: SEEDED }, (_, idx) => `${prefix}${SEEDED - idx}`);
}

/** Provision a namespace the way the dogfood harness does: partition + manifest. */
function seedNamespace(nsDir: string, prefix: string): void {
  const partitionDir = path.join(nsDir, PARTITION_REL);
  fs.mkdirSync(partitionDir, { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= SEEDED; i++) {
    lines.push(JSON.stringify(seedMemory(prefix, i)));
  }
  fs.writeFileSync(
    path.join(partitionDir, "current.jsonl"),
    lines.join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(nsDir, "manifest.json"),
    JSON.stringify({
      partitions: [PARTITION_REL],
      lastUpdated: new Date().toISOString(),
    }),
  );
}

function pageQuery(opts: {
  namespace: string;
  offset: number;
  prefix?: string;
}): string {
  const prefix = opts.prefix !== undefined ? `prefix=${opts.prefix}&` : "";
  return (
    `/api/memories?namespace=${opts.namespace}&${prefix}` +
    `limit=${PAGE}&offset=${opts.offset}`
  );
}

/** Fetch one page and assert the envelope + exact key order for it. */
async function expectPage(opts: {
  namespace: string;
  prefix?: string;
  offset: number;
  expected: string[];
}) {
  const { status, body } = await httpRequest(
    "GET",
    pageQuery({
      namespace: opts.namespace,
      offset: opts.offset,
      prefix: opts.prefix,
    }),
  );

  expect(status).toBe(200);
  expect(body.items.map((m: any) => m.key)).toEqual(opts.expected);
  expect(body.total).toBe(SEEDED);
  expect(body.offset).toBe(opts.offset);
  expect(body.limit).toBe(PAGE);
  return body;
}

describe("DB-GAP-046: GET /api/memories prefix + offset paging", () => {
  let configBefore: string | null;

  beforeAll(async () => {
    // GAP-022 AC1: the repo config file must be byte-identical after the run
    configBefore = readRepoConfig();

    seedNamespace(NS, PREFIX);
    seedNamespace(LIVE_NS, LIVE_PREFIX);

    const app = createHttpServer();
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") port = addr.port;
        resolve();
      });
    });
  });

  afterAll(() => {
    server.close();
    expect(readRepoConfig()).toBe(configBefore);
    fs.rmSync(NS, { recursive: true, force: true });
    fs.rmSync(LIVE_NS, { recursive: true, force: true });
  });

  it("offset=0 returns the first full page with more to come", async () => {
    const body = await expectPage({
      namespace: NS_NAME,
      prefix: PREFIX,
      offset: 0,
      expected: expectedOrder(PREFIX).slice(0, PAGE),
    });

    expect(body.items).toHaveLength(PAGE);
    expect(body.hasMore).toBe(true);
    expect(body.nextOffset).toBe(PAGE);
  });

  it("offset=10 returns the SECOND page (was 0 rows — the empty-page bug)", async () => {
    const body = await expectPage({
      namespace: NS_NAME,
      prefix: PREFIX,
      offset: 10,
      expected: expectedOrder(PREFIX).slice(PAGE, 2 * PAGE),
    });

    expect(body.items).toHaveLength(PAGE);
    expect(body.hasMore).toBe(true);
    expect(body.nextOffset).toBe(2 * PAGE);
  });

  it("offset=20 returns the final 5 rows with hasMore=false", async () => {
    const body = await expectPage({
      namespace: NS_NAME,
      prefix: PREFIX,
      offset: 20,
      expected: expectedOrder(PREFIX).slice(2 * PAGE),
    });

    expect(body.items).toHaveLength(SEEDED - 2 * PAGE);
    expect(body.hasMore).toBe(false);
    expect(body.nextOffset).toBeNull();
  });

  it("walking all three pages visits every row exactly once, in order", async () => {
    const seen: string[] = [];
    for (const offset of [0, 10, 20]) {
      const { body } = await httpRequest(
        "GET",
        pageQuery({ namespace: NS_NAME, offset, prefix: PREFIX }),
      );
      seen.push(...body.items.map((m: any) => m.key));
    }

    // No gaps, no overlap, no duplicate row across page boundaries.
    expect(seen).toEqual(expectedOrder(PREFIX));
    expect(new Set(seen).size).toBe(SEEDED);
  });

  it("control: the same paging WITHOUT prefix is consistent (offset is generic)", async () => {
    // The offset/limit interaction lives in the shared list path, so the
    // unprefixed listing must page identically — this namespace holds only
    // the 25 seeded rows.
    const order = expectedOrder(PREFIX);
    await expectPage({
      namespace: NS_NAME,
      offset: 0,
      expected: order.slice(0, PAGE),
    });
    await expectPage({
      namespace: NS_NAME,
      offset: 10,
      expected: order.slice(PAGE, 2 * PAGE),
    });
    await expectPage({
      namespace: NS_NAME,
      offset: 20,
      expected: order.slice(2 * PAGE),
    });
  });

  it("reproduces the live dogfood shape: 25 rows under /dogfood/page- page 10/10/5", async () => {
    const order = expectedOrder(LIVE_PREFIX);

    const first = await expectPage({
      namespace: LIVE_NS_NAME,
      prefix: LIVE_PREFIX,
      offset: 0,
      expected: order.slice(0, PAGE),
    });
    expect(first.hasMore).toBe(true);

    const second = await expectPage({
      namespace: LIVE_NS_NAME,
      prefix: LIVE_PREFIX,
      offset: 10,
      expected: order.slice(PAGE, 2 * PAGE),
    });
    expect(second.hasMore).toBe(true);

    const third = await expectPage({
      namespace: LIVE_NS_NAME,
      prefix: LIVE_PREFIX,
      offset: 20,
      expected: order.slice(2 * PAGE),
    });
    expect(third.hasMore).toBe(false);
    expect(third.nextOffset).toBeNull();
  });

  it("offset past the last row is a legitimately empty page (hasMore=false, total intact)", async () => {
    const body = await expectPage({
      namespace: NS_NAME,
      prefix: PREFIX,
      offset: 30,
      expected: [],
    });

    expect(body.items).toHaveLength(0);
    expect(body.total).toBe(SEEDED);
    expect(body.hasMore).toBe(false);
    expect(body.nextOffset).toBeNull();
  });

  it("rejects a negative or non-numeric offset with 400 VALIDATION_ERROR", async () => {
    for (const raw of ["-1", "abc"]) {
      const { status, body } = await httpRequest(
        "GET",
        `/api/memories?namespace=${NS_NAME}&limit=${PAGE}&offset=${raw}`,
      );
      expect(status).toBe(400);
      expect(body.code).toBe("VALIDATION_ERROR");
    }
  });
});
