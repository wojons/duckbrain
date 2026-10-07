/**
 * DB-SUPA-5 AC-5 — row and authorization filtering.
 *
 * Named checks: `implicit table filter`,
 * `explicit unauthorized table is all-or-nothing`.
 *
 * The namespace lives in the config-derived namespaces root on purpose: the
 * route resolves declared tables through `listTables`, which is
 * config-derived and not injectable, so a fixture root the registry cannot see
 * would make the "implicit filter" assertion vacuous.
 */

import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { z } from "zod";
import { REALTIME_ROUTE_PATH, createRealtimeRoutes } from "./realtime";
import { RealtimeHub } from "../realtime/hub";
import { FileAuthStore, hashApiKey } from "../../auth/storeSchema";
import { createAuthBackend } from "../../auth/middleware";
import { TableSchemaRegistry } from "../../serialization/registry";
import {
  configNamespacesPath,
  createRealtimeFixture,
  memoryInput,
  openSseClient,
  principalMiddleware,
  startApp,
  writeDeclaredTable,
  type RealtimeFixture,
  type RunningApp,
} from "../realtime/fixtures";

const fixtures: RealtimeFixture[] = [];
const hubs: RealtimeHub[] = [];
const apps: RunningApp[] = [];
const authDirs: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const hub of hubs.splice(0)) hub.closeAll();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  for (const dir of authDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

const genericRow = z.object({ id: z.string() }).passthrough();

/** A principal granted `table_a` only — never `memories`, never `table_b`. */
function table_aPrincipal(ns: string): Record<string, unknown> {
  return {
    name: "table-a-reader",
    authenticated: true,
    namespaces: [ns],
    roles: ["analyst"],
    tableGrants: { table_a: "read" },
  };
}

async function scenario(): Promise<{
  fixture: RealtimeFixture;
  hub: RealtimeHub;
  app: RunningApp;
  registry: TableSchemaRegistry;
}> {
  const registry = new TableSchemaRegistry();
  const fixture = createRealtimeFixture("duckbrain-supa5-auth-", {
    root: configNamespacesPath(),
    namespace: "nsA",
    commitOnFlush: false,
    writerOptions: { registry },
  });
  fixtures.push(fixture);
  const { ns, nsPath } = fixture;
  registry.register(ns, "table_a", genericRow);
  registry.register(ns, "table_b", genericRow);
  writeDeclaredTable(nsPath, "table_a", {
    primary: "id",
    columns: ["id", "v"],
  });
  writeDeclaredTable(nsPath, "table_b", {
    primary: "id",
    columns: ["id", "v"],
  });

  const hub = new RealtimeHub({
    namespacesPath: fixture.root,
    pollIntervalMs: 60 * 60 * 1000,
    heartbeatMs: 60 * 60 * 1000,
  });
  hubs.push(hub);

  const app = express();
  app.use(express.json());
  app.use(principalMiddleware(table_aPrincipal(ns)));
  app.use(REALTIME_ROUTE_PATH, createRealtimeRoutes({ hub }));
  const running = await startApp(app);
  apps.push(running);

  // The changes themselves are written by `writeChanges()` so each test can
  // subscribe first and observe them as live delivery.
  return {
    fixture,
    hub,
    app: running,
    registry,
  };
}

/** Write the stage-1 (per-table) or stage-2 (live) changes, then commit. */
async function writeChanges(
  fixture: RealtimeFixture,
  hub: RealtimeHub,
  stage: 1 | 2,
): Promise<void> {
  const { ns } = fixture;
  const pairs: Array<[string, number]> =
    stage === 1
      ? [
          ["table_a", 1],
          ["table_a", 2],
          ["table_b", 1],
          ["table_b", 2],
        ]
      : [
          ["table_b", 3],
          ["table_a", 3],
        ];
  for (const [table, index] of pairs) {
    await fixture.writer.enqueue({
      ns,
      table,
      op: "insert",
      record: { id: `${table}-${index}`, v: index },
      principal: undefined,
      targetPath: `${table}/2026-09/current.jsonl`,
      partitionPath: `${table}/2026-09/`,
    });
  }
  if (stage === 1) await fixture.writer.enqueue(memoryInput(1, ns));
  fixture.commit(`test: auth filtering changes (stage ${stage})`);
  await hub.check(ns);
}

describe("DB-SUPA-5 authorization filtering", () => {
  it("implicit table filter", async () => {
    const { fixture, hub, app } = await scenario();
    const ns = fixture.ns;

    // Subscribe BEFORE the changes: nothing is committed yet, so the ready
    // control event reports a null head and the changes are live delivery.
    const client = await openSseClient(app.port, `/api/ns/${ns}/changes`);
    expect(client.status).toBe(200);
    await client.waitFor((c) => c.frames().length >= 1);
    expect(JSON.parse(client.frames()[0].data ?? "{}").head).toBeNull();

    // No `tables` parameter: the principal gets exactly the tables it may
    // read. `memories` and `table_b` are not among them.
    await writeChanges(fixture, hub, 1);
    await client.waitFor((c) => c.events().length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 120));

    const events = client.events();
    expect(events.map((event) => event.table)).toEqual(["table_a", "table_a"]);
    expect(events.map((event) => (event.row as { id: string }).id)).toEqual([
      "table_a-1",
      "table_a-2",
    ]);
    expect(hub.countFor(ns)).toBe(1);

    // Nothing about the gated tables leaks: not a row id, not a table name,
    // not a cursor, not a count, not a history boundary.
    const stream = client.text();
    expect(stream).not.toContain("table_b");
    expect(stream).not.toContain("memories");
    // Exactly the authorized table's changes: a leaked event would be a third.
    expect(events).toHaveLength(2);

    // The filter is re-applied to live delivery, not just to the replay: a
    // change written after the subscription and committed is filtered too.
    await writeChanges(fixture, hub, 2);
    await client.waitFor((c) => c.events().length >= 3);

    const after = client.events();
    expect(after.map((event) => (event.row as { id: string }).id)).toEqual([
      "table_a-1",
      "table_a-2",
      "table_a-3",
    ]);
    expect(client.text()).not.toContain("table_b-3");
    client.close();
  }, 30_000);

  it("explicit unauthorized table is all-or-nothing", async () => {
    const { fixture, hub, app } = await scenario();
    const ns = fixture.ns;

    for (const query of [
      "tables=table_b",
      "tables=table_a,table_b",
      "tables=memories",
    ]) {
      const client = await openSseClient(
        app.port,
        `/api/ns/${ns}/changes?${query}`,
      );
      const text = client.text();
      const status = client.status;
      client.close();

      expect({ query, status }).toEqual({ query, status: 403 });
      expect(JSON.parse(text).code).toBe("FORBIDDEN");
      expect(client.headers["content-type"]).toContain("application/json");
      // Denied BEFORE replay: no partial stream, no count, no cursor, no
      // history boundary and no confirmation that the table exists.
      expect(text).not.toContain("event:");
      expect(text).not.toContain("dbch1.");
      expect(text).not.toContain("table_b");
      expect(text).not.toContain("memories");
    }

    // The denials registered no subscription at all.
    expect(hub.countFor(ns)).toBe(0);
    expect(hub.subscriberCount).toBe(0);

    // Positive control: the authorized table alone is accepted, so the 403s
    // above are authorization, not a broken route.
    const allowed = await openSseClient(
      app.port,
      `/api/ns/${ns}/changes?tables=table_a`,
    );
    expect(allowed.status).toBe(200);
    await writeChanges(fixture, hub, 1);
    await allowed.waitFor((client) => client.events().length >= 2);
    expect(allowed.events().map((event) => event.table)).toEqual([
      "table_a",
      "table_a",
    ]);
    allowed.close();
  }, 30_000);

  it("revokes an idle SSE subscriber when the auth store reloads", async () => {
    const fixture = createRealtimeFixture("duckbrain-supa5-auth-reload-", {
      root: configNamespacesPath(),
      namespace: `auth-reload-${process.pid}-${Date.now()}`,
      commitOnFlush: false,
    });
    fixtures.push(fixture);

    const authDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-supa5-auth-store-"),
    );
    authDirs.push(authDir);
    const authFile = path.join(authDir, "auth.json");
    const token = "idle-reload-token";
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        apiKeys: [
          {
            keyHash: hashApiKey(token),
            name: "idle-reader",
            roles: ["analyst"],
            namespaces: [fixture.ns],
          },
        ],
      }) + "\n",
      { mode: 0o600 },
    );
    const store = new FileAuthStore(authFile);
    const principal = await createAuthBackend({
      type: "apikey",
      store,
    }).authenticate({ headers: { "x-api-key": token } } as never);

    const hub = new RealtimeHub({
      namespacesPath: fixture.root,
      pollIntervalMs: 25,
      heartbeatMs: 60 * 60 * 1000,
      authStore: store,
    });
    hubs.push(hub);

    const app = express();
    app.use(express.json());
    app.use(principalMiddleware(principal));
    app.use(REALTIME_ROUTE_PATH, createRealtimeRoutes({ hub }));
    const running = await startApp(app);
    apps.push(running);

    const client = await openSseClient(
      running.port,
      `/api/ns/${fixture.ns}/changes`,
    );
    expect(client.status).toBe(200);
    await client.waitFor((current) => current.frames().length >= 1);
    expect(hub.countFor(fixture.ns)).toBe(1);

    // No namespace write or wake call follows this edit. The hub's existing
    // poll interval must drive the auth-store reload and close the idle feed.
    fs.writeFileSync(authFile, JSON.stringify({ apiKeys: [] }) + "\n");
    const next = new Date(Date.now() + 1_000);
    fs.utimesSync(authFile, next, next);

    await client.waitFor(
      (current) =>
        current.frames().some((frame) => frame.event === "duckbrain.revoked.v1"),
      3_000,
    );
    await client.waitFor((current) => current.ended(), 3_000);
    expect(client.frames().filter((frame) => frame.event === "duckbrain.revoked.v1"))
      .toHaveLength(1);
    expect(hub.countFor(fixture.ns)).toBe(0);
  });
});
