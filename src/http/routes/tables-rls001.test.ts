/**
 * RLS-001 — row-level security over the REAL route stack.
 *
 * The grant model answers "may this principal touch this table?". This suite
 * proves the second question ("which ROWS?") on a table that declares
 *
 *   "policy": { "read": { "column": "owner", "equals": ".id" },
 *               "write": { "column": "owner", "equals": ".id" } }
 *
 * with TWO authenticated principals minted through the real auth middleware
 * (apikey mode, inline store, real x-api-key header — no test-only principal
 * seam):
 *
 *   - A writes 3 rows; B reads 0 of them, cannot PATCH or DELETE them, while
 *     A still sees its own 3 (AC-3);
 *   - a PATCH on a row B may not touch answers exactly what a PATCH on a
 *     MISSING row answers — `{updated:0}` — so the verb is not an existence
 *     oracle (AC-2);
 *   - a row that has no `owner` value is DENIED, not shared (AC-3);
 *   - every row-policy denial is audited with reason `row_policy`, distinct
 *     from the grant layer's `table_grant` (AC-4);
 *   - the change feed applies the same predicate: B's subscription receives
 *     none of A's rows (AC-2).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { authMiddleware } from "../../auth/middleware";
import type { DenialAuditEvent } from "../../auth/middleware";
import { invalidateTableRegistry } from "../../schema/table-registry";
import { createTableRoutes } from "./tables";
import { buildRowAllowed } from "./realtime";
import {
  createRealtimeFixture,
  createRecordingSink,
  type RealtimeFixture,
  type RecordingSink,
} from "../realtime/fixtures";
import { RealtimeHub, type Subscription } from "../realtime/hub";

const NS = "rls001-tenant";
const TABLE = "invoices";

let root = "";
let nsDir = "";

/** Denials the auth middleware / policy layer emitted during one request. */
let denials: DenialAuditEvent[] = [];

function schemaDocument(): string {
  return JSON.stringify({
    schemaVersion: 1,
    tables: {
      [TABLE]: {
        schemaVersion: 1,
        storage: { path: `tables/${TABLE}/current.jsonl` },
        rowShape: "object",
        keyColumns: ["id"],
        columns: [
          { name: "id", type: "string", nullable: false },
          { name: "owner", type: "string", nullable: true },
          { name: "amount", type: "int64", nullable: true },
        ],
        policy: {
          read: { column: "owner", equals: ".id" },
          write: { column: "owner", equals: ".id" },
        },
      },
    },
    views: {},
  });
}

function seedNamespace(): void {
  nsDir = path.join(root, NS);
  fs.mkdirSync(path.join(nsDir, "tables", TABLE), { recursive: true });
  fs.writeFileSync(path.join(nsDir, "schema.json"), schemaDocument(), "utf-8");
  fs.writeFileSync(
    path.join(nsDir, "tables", TABLE, "current.jsonl"),
    [
      JSON.stringify({ id: "legacy-1", owner: "alice", amount: "10" }),
      // A row that carries NO owner: the policy must deny it to everybody,
      // including alice, rather than treat the missing value as a match.
      JSON.stringify({ id: "orphan-1", amount: "99" }),
    ].join("\n") + "\n",
    "utf-8",
  );
}

function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(
    authMiddleware({
      type: "apikey",
      apiKeys: [
        // A and B hold the SAME table grant; only the row policy separates
        // them, so a passing read cannot be the grant layer's doing.
        { key: "alice-key", name: "alice", roles: ["admin" as const] },
        { key: "bob-key", name: "bob", roles: ["admin" as const] },
        // C is granted the table for reading only: the denial it gets must
        // carry `table_grant`, never `row_policy`.
        {
          key: "carol-key",
          name: "carol",
          // A non-admin role carries `tables.write`; the per-table grant then
          // narrows carol to READ, so the refusal is the grant layer's.
          roles: ["writer" as const],
          tableGrants: { [TABLE]: "read" as const },
        },
      ],
      auditDenial: (event) => void denials.push(event as DenialAuditEvent),
    }),
  );
  app.use("/api/ns/:ns/tables", createTableRoutes());
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  });
  return app;
}

interface HttpResult {
  status: number;
  body: any;
  headers: Record<string, string | string[] | undefined>;
}

function req(
  method: string,
  requestPath: string,
  opts: { key?: string | null; body?: unknown; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http = require("http") as typeof import("http");
  const app = createApp();
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      const headers: Record<string, string> = {
        Host: "localhost",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.key === null || opts.key === undefined ? {} : { "x-api-key": opts.key }),
        ...(opts.headers ?? {}),
      };
      const clientReq = http.request(
        { hostname: "127.0.0.1", port, path: requestPath, method, headers },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk.toString()));
          res.on("end", () => {
            server.close();
            let parsed: any = data;
            try {
              parsed = JSON.parse(data);
            } catch {
              // non-JSON body — keep the raw text
            }
            resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
          });
        },
      );
      clientReq.on("error", (error: Error) => {
        server.close();
        reject(error);
      });
      if (opts.body !== undefined) clientReq.write(JSON.stringify(opts.body));
      clientReq.end();
    });
  });
}

const BASE = `/api/ns/${NS}/tables/${TABLE}`;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-rls001-"));
  process.env.DUCKBRAIN_NAMESPACES_PATH = root;
  process.env.DUCKBRAIN_CONFIG_PATH = path.join(root, "duckbrain.config.json");
  seedNamespace();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  invalidateTableRegistry();
  denials = [];
});

describe("RLS-001: row policy on the data verbs", () => {
  it("A's three rows are visible to A and invisible to B; totals agree", async () => {
    for (const id of ["a-1", "a-2", "a-3"]) {
      const inserted = await req("POST", BASE, {
        key: "alice-key",
        body: { id, owner: "alice", amount: "5" },
      });
      expect(inserted.status).toBe(201);
    }

    const alice = await req("GET", `${BASE}?order=id.asc`, {
      key: "alice-key",
      headers: { Prefer: "count=exact" },
    });
    expect(alice.status).toBe(200);
    // Alice's readable set is exactly the rows she owns — her three inserts
    // plus the seeded `legacy-1` — and never `orphan-1`, which names no owner.
    expect(alice.body.map((row: any) => row.id)).toEqual([
      "a-1",
      "a-2",
      "a-3",
      "legacy-1",
    ]);
    expect(alice.headers["x-total-count"]).toBe("4");

    const bob = await req("GET", `${BASE}?order=id.asc`, {
      key: "bob-key",
      headers: { Prefer: "count=exact" },
    });
    expect(bob.status).toBe(200);
    expect(bob.body).toEqual([]);
    // The count is computed inside the SAME WHERE clause: B cannot learn how
    // many rows exist by asking for an exact count.
    expect(bob.headers["x-total-count"]).toBe("0");
  });

  it("B's PATCH/DELETE of A's row change nothing and look like a MISSING row", async () => {
    const existing = await req("PATCH", `${BASE}?pk=eq.a-1`, {
      key: "bob-key",
      body: { amount: "1" },
    });
    const missing = await req("PATCH", `${BASE}?pk=eq.does-not-exist`, {
      key: "bob-key",
      body: { amount: "1" },
    });
    expect(existing.status).toBe(200);
    expect(existing.body).toEqual({ updated: 0 });
    // AC-2: identical shape — no existence oracle.
    expect(existing.body).toEqual(missing.body);
    expect(existing.status).toBe(missing.status);

    const deleted = await req("DELETE", `${BASE}?pk=eq.a-1`, { key: "bob-key" });
    const deleteMissing = await req("DELETE", `${BASE}?pk=eq.does-not-exist`, {
      key: "bob-key",
    });
    expect(deleted.body).toEqual({ deleted: 0 });
    expect(deleted.body).toEqual(deleteMissing.body);

    // A patch that tries to take the row by rewriting the owner is refused
    // too: the row on disk is not bob's, so the write policy denies it before
    // the owner column is even considered.
    const steal = await req("PATCH", `${BASE}?pk=eq.a-1`, {
      key: "bob-key",
      body: { owner: "bob" },
    });
    expect(steal.body).toEqual({ updated: 0 });

    // A's row survived both attempts and is still readable by A.
    const alice = await req("GET", `${BASE}?id=eq.a-1`, { key: "alice-key" });
    expect(alice.body).toHaveLength(1);
    expect(alice.body[0]).toMatchObject({ id: "a-1", owner: "alice", amount: "5" });
  });

  it("A can patch and delete its own row", async () => {
    const patched = await req("PATCH", `${BASE}?pk=eq.a-2`, {
      key: "alice-key",
      body: { amount: "42" },
    });
    expect(patched.body).toEqual({ updated: 1 });
    const deleted = await req("DELETE", `${BASE}?pk=eq.a-3`, { key: "alice-key" });
    expect(deleted.body).toEqual({ deleted: 1 });
  });

  it("refuses a write that names another principal as the owner (403 + audited)", async () => {
    const stolen = await req("POST", BASE, {
      key: "bob-key",
      body: { id: "b-1", owner: "alice", amount: "7" },
    });
    expect(stolen.status).toBe(403);
    expect(stolen.body.code).toBe("FORBIDDEN");
    expect(stolen.body.error).toMatch(/outside principal 'bob' row policy/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(denials.at(-1)).toMatchObject({
      table: TABLE,
      ns: NS,
      principal: "bob",
      reason: "row_policy",
      outcome: "denied",
    });

    // A row with no owner at all is refused for every principal.
    const ownerless = await req("POST", BASE, {
      key: "bob-key",
      body: { id: "b-2", amount: "7" },
    });
    expect(ownerless.status).toBe(403);
    expect(ownerless.body.error).toMatch(/has no 'owner' value/);
  });

  it("PUT cannot replace another principal's row, and A can replace its own", async () => {
    const refused = await req("PUT", `${BASE}/a-1`, {
      key: "bob-key",
      body: { owner: "bob", amount: "0" },
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/row policy/);

    const own = await req("PUT", `${BASE}/a-1`, {
      key: "alice-key",
      body: { owner: "alice", amount: "11" },
    });
    expect(own.status).toBe(200);
    expect(own.body.row).toMatchObject({ id: "a-1", amount: "11" });
  });

  it("denies a row with NO policy column, and audits it as row_policy", async () => {
    // `orphan-1` carries no owner. Alice matches nothing on a filtered read of
    // it; B's unfiltered read must not include it either.
    const bob = await req("GET", `${BASE}?order=id.asc`, { key: "bob-key" });
    expect(bob.body.map((row: any) => row.id)).not.toContain("orphan-1");
    const alice = await req("GET", `${BASE}?order=id.asc`, { key: "alice-key" });
    expect(alice.body.map((row: any) => row.id)).not.toContain("orphan-1");
    // Reading ONLY the orphan is a fully-denied read: the audit names it.
    const onlyOrphan = await req("GET", `${BASE}?id=eq.orphan-1`, { key: "alice-key" });
    expect(onlyOrphan.body).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(denials.at(-1)).toMatchObject({
      table: TABLE,
      principal: "alice",
      reason: "row_policy",
    });
  });

  it("keeps row_policy distinct from table_grant in the audit", async () => {
    // carol holds no WRITE table grant: the refusal is the grant layer's.
    const denied = await req("PATCH", `${BASE}?pk=eq.a-1`, {
      key: "carol-key",
      body: { amount: "3" },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/no write grant for table/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(denials.at(-1)).toMatchObject({ principal: "carol", reason: "table_grant" });
    expect(denials.some((event) => event.reason === "row_policy")).toBe(false);
  });

  it("refuses a policy that names a column the table does not declare", async () => {
    const rejected = await req("POST", `${BASE}/declare`, {
      key: "alice-key",
      body: {
        columns: [
          { name: "id", type: "varchar" },
          { name: "owner", type: "varchar" },
        ],
        policy: { read: { column: "tenant", equals: ".id" } },
        force: true,
      },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/not a declared column/);
  });
});

// ---------------------------------------------------------------------------
// change feed
// ---------------------------------------------------------------------------

describe("RLS-001: the change feed applies the same row policy", () => {
  let fixture: RealtimeFixture;
  let feedNs: string;
  let feedNsPath: string;
  let hub: RealtimeHub;
  let subs: Subscription[] = [];
  let sinks: RecordingSink[] = [];

  const FEED_NS = "rls001-feed";
  const FEED_TABLE = "invoices";

  beforeAll(() => {
    // The table registry is config-derived (DUCKBRAIN_NAMESPACES_PATH), so the
    // feed namespace must live under the SAME root the routes read.
    fixture = createRealtimeFixture("duckbrain-rls001-feed-", {
      namespace: FEED_NS,
      root,
      // Commit explicitly below: the suite decides exactly when a batch
      // becomes a committed change the feed can derive.
      commitOnFlush: false,
    });
    feedNs = fixture.ns;
    feedNsPath = fixture.nsPath;
    fs.writeFileSync(
      path.join(feedNsPath, "schema.json"),
      JSON.stringify({
        schemaVersion: 1,
        tables: {
          [FEED_TABLE]: {
            schemaVersion: 1,
            storage: { path: `tables/${FEED_TABLE}/current.jsonl` },
            rowShape: "object",
            keyColumns: ["id"],
            columns: [
              { name: "id", type: "string", nullable: false },
              { name: "owner", type: "string", nullable: true },
            ],
            policy: { read: { column: "owner", equals: ".id" } },
          },
        },
        views: {},
      }),
      "utf-8",
    );
    fs.mkdirSync(path.join(feedNsPath, "tables", FEED_TABLE), { recursive: true });
    fs.writeFileSync(path.join(feedNsPath, "tables", FEED_TABLE, "current.jsonl"), "", "utf-8");
    fixture.commit("test: seed the row-policy table");
    hub = new RealtimeHub({
      namespacesPath: fixture.root,
      pollIntervalMs: 60 * 60 * 1000,
      heartbeatMs: 60 * 60 * 1000,
      log: () => undefined,
    });
    invalidateTableRegistry();
  });

  afterAll(async () => {
    for (const sub of subs) sub.close();
    hub?.closeAll();
    fixture?.cleanup();
  });

  async function subscribeAs(name: string): Promise<RecordingSink> {
    const principal = { name, authenticated: true };
    const sink = createRecordingSink();
    const rowAllowed = buildRowAllowed(feedNs, [FEED_TABLE], principal);
    const sub = await hub.subscribe(
      {
        ns: feedNs,
        principal,
        tables: [FEED_TABLE],
        ops: ["insert", "update", "delete"],
        cursor: null,
        rowAllowed,
        sink,
      },
      () => undefined,
    );
    subs.push(sub);
    sinks.push(sink);
    return sink;
  }

  it("delivers A's own inserted rows to A and NONE of them to B", async () => {
    const aliceSink = await subscribeAs("alice");
    const bobSink = await subscribeAs("bob");

    // Two real writes through the single writer: one owned by alice, one by
    // bob, plus a row that names no owner at all.
    for (const row of [
      { id: "f-1", owner: "alice" },
      { id: "f-2", owner: "bob" },
      { id: "f-3" },
    ]) {
      const result = await fixture.writer.enqueue({
        ns: feedNs,
        table: FEED_TABLE,
        op: "insert",
        record: row,
        principal: { name: row.owner ?? "nobody", authenticated: true },
        targetPath: `tables/${FEED_TABLE}/current.jsonl`,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    }
    await fixture.writer.flush();
    fixture.commit("test: three ownership-class rows");
    await hub.check(feedNs);

    const aliceIds = () =>
      aliceSink
        .changeEvents()
        .map((event: any) => event.row?.id)
        .filter((id: unknown): id is string => typeof id === "string");
    const bobIds = () =>
      bobSink
        .changeEvents()
        .map((event: any) => event.row?.id)
        .filter((id: unknown): id is string => typeof id === "string");

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !aliceIds().includes("f-1")) {
      await hub.check(feedNs);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(aliceIds()).toContain("f-1");
    // alice gets NOTHING of bob's row and NOTHING of the ownerless row.
    expect(aliceIds()).not.toContain("f-2");
    expect(aliceIds()).not.toContain("f-3");
    // bob gets his own row only.
    expect(bobIds()).toContain("f-2");
    expect(bobIds()).not.toContain("f-1");
  });
});
