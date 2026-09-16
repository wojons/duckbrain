/**
 * DB-SUPA-5 AC-1 / AC-4 — end-to-end change stream over real HTTP.
 *
 * Named checks: `insert update delete stream`,
 * `two clients receive identical ordered positions`,
 * `reconnect is at-least-once`.
 *
 * Two real SSE clients talk to a real Express server over loopback; writes go
 * through the real `NamespaceWriter`; commits are real namespace commits; the
 * restart check tears the server down and brings a fresh one (and a fresh hub)
 * up against the same namespace repository before resuming from a captured
 * event id.
 */

import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import type { MemoryType } from "../../schema/memory";
import { REALTIME_ROUTE_PATH, createRealtimeRoutes } from "./realtime";
import { RealtimeHub } from "../realtime/hub";
import { CHANGE_EVENT_REQUIRED_FIELDS } from "../realtime/wire";
import {
  createRealtimeFixture,
  memoryInput,
  openSseClient,
  principalMiddleware,
  startApp,
  tombstoneInput,
  type RealtimeFixture,
  type RunningApp,
} from "../realtime/fixtures";

const fixtures: RealtimeFixture[] = [];
const hubs: RealtimeHub[] = [];
const apps: RunningApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const hub of hubs.splice(0)) hub.closeAll();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function server(existing?: RealtimeFixture): Promise<{
  fixture: RealtimeFixture;
  hub: RealtimeHub;
  app: RunningApp;
  feed: (query: string) => string;
}> {
  const fixture =
    existing ??
    createRealtimeFixture("duckbrain-supa5-e2e-", { commitOnFlush: false });
  if (!existing) fixtures.push(fixture);
  const hub = new RealtimeHub({
    namespacesPath: fixture.root,
    pollIntervalMs: 60 * 60 * 1000,
    heartbeatMs: 60 * 60 * 1000,
  });
  hubs.push(hub);

  const app = express();
  app.use(express.json());
  app.use(principalMiddleware(undefined));
  app.use(REALTIME_ROUTE_PATH, createRealtimeRoutes({ hub }));
  const running = await startApp(app);
  apps.push(running);

  return {
    fixture,
    hub,
    app: running,
    feed: (query: string) =>
      `/api/ns/${fixture.ns}/changes${query === "" ? "" : `?${query}`}`,
  };
}

describe("DB-SUPA-5 realtime end to end", () => {
  it("insert update delete stream", async () => {
    const { fixture, hub, app, feed } = await server();
    const { ns } = fixture;
    const client = await openSseClient(app.port, feed("tables=memories"));
    expect(client.status).toBe(200);
    await client.waitFor((c) => c.frames().length >= 1);
    expect(client.frames()[0].event).toBe("duckbrain.ready.v1");

    // ---- insert ----------------------------------------------------------
    const insertInput = memoryInput(1, ns);
    const record = insertInput.record as MemoryType;
    const inserted = await fixture.writer.enqueue(insertInput);
    expect(inserted.ok).toBe(true);
    fixture.commit("test: e2e insert");
    await hub.check(ns);
    await client.waitFor((c) => c.events().length >= 1);

    const added = client.events()[0];
    // The full required v1 schema, field by field.
    for (const field of CHANGE_EVENT_REQUIRED_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(added, field)).toBe(true);
    }
    expect(added.version).toBe(1);
    expect(added.namespace).toBe(ns);
    expect(added.table).toBe("memories");
    expect(added.op).toBe("insert");
    expect(added.tombstone).toBe(false);
    expect(added.schemaVersion).toBe(1);
    expect((added.row as { id: string }).id).toBe(record.id);
    expect((added.key as { id: string }).id).toBe(record.id);
    expect((added.position as { commit: string }).commit).toBe(fixture.head());
    expect((added.position as { ordinal: number }).ordinal).toBe(1);
    expect(Number.isNaN(Date.parse(String(added.committedAt)))).toBe(false);
    // The SSE `id` is the cursor, verbatim.
    const insertFrame = client
      .frames()
      .filter((frame) => frame.event === "duckbrain.change.v1")[0];
    expect(insertFrame.id).toBe(added.cursor);

    // ---- update ----------------------------------------------------------
    const updateInput = memoryInput(1, ns, {
      op: "update",
      record: { ...record, embedding_text: "record 1 updated" },
    });
    const updated = await fixture.writer.enqueue(updateInput);
    expect(updated.ok).toBe(true);
    fixture.commit("test: e2e update");
    await hub.check(ns);
    await client.waitFor((c) => c.events().length >= 2);

    const changed = client.events()[1];
    expect(changed.op).toBe("update");
    expect(changed.tombstone).toBe(false);
    expect((changed.row as { embedding_text: string }).embedding_text).toBe(
      "record 1 updated",
    );
    expect((changed.key as { id: string }).id).toBe(record.id);

    // ---- delete ----------------------------------------------------------
    const removed = await fixture.writer.enqueue(tombstoneInput(record, ns));
    expect(removed.ok).toBe(true);
    fixture.commit("test: e2e delete");
    await hub.check(ns);
    await client.waitFor((c) => c.events().length >= 3);

    const deleted = client.events()[2];
    expect(deleted.op).toBe("delete");
    // A delete is a tombstone row image plus its key — never `row: null`.
    expect(deleted.tombstone).toBe(true);
    expect(deleted.row).not.toBeNull();
    expect((deleted.row as { action: string }).action).toBe("tombstone");
    expect((deleted.key as { id: string }).id).toBe(record.id);

    // Three commits, three positions, one change each, oldest first.
    const positions = client
      .events()
      .map((event) => event.position as { commit: string; ordinal: number });
    expect(positions.map((position) => position.ordinal)).toEqual([1, 1, 1]);
    expect(new Set(positions.map((position) => position.commit)).size).toBe(3);
    client.close();
  }, 45_000);

  it("two clients receive identical ordered positions", async () => {
    const { fixture, hub, app, feed } = await server();
    const { ns } = fixture;
    const first = await openSseClient(app.port, feed("tables=memories"));
    const second = await openSseClient(app.port, feed("tables=memories"));
    await first.waitFor((c) => c.frames().length >= 1);
    await second.waitFor((c) => c.frames().length >= 1);

    await fixture.writer.enqueue(memoryInput(1, ns));
    await fixture.writer.enqueue(memoryInput(2, ns));
    fixture.commit("test: e2e two clients");
    await hub.check(ns);

    await first.waitFor((c) => c.events().length >= 2);
    await second.waitFor((c) => c.events().length >= 2);

    // Identical cursors and identical positions on both connections, in the
    // same order — one namespace, one committed total order.
    expect(first.cursors()).toEqual(second.cursors());
    expect(first.events().map((event) => event.position)).toEqual(
      second.events().map((event) => event.position),
    );
    expect(
      first
        .events()
        .map((event) => (event.position as { ordinal: number }).ordinal),
    ).toEqual([1, 2]);
    expect(new Set(first.cursors()).size).toBe(2);

    first.close();
    second.close();
  }, 45_000);

  it("reconnect is at-least-once", async () => {
    const { fixture, hub, app, feed } = await server();
    const { ns } = fixture;
    const live = await openSseClient(app.port, feed("tables=memories"));
    await live.waitFor((c) => c.frames().length >= 1);

    await fixture.writer.enqueue(memoryInput(1, ns));
    fixture.commit("test: e2e resume one");
    await hub.check(ns);
    await live.waitFor((c) => c.events().length >= 1);
    const firstCursor = String(live.events()[0].cursor);

    const secondInput = memoryInput(2, ns);
    await fixture.writer.enqueue(secondInput);
    fixture.commit("test: e2e resume two");
    await hub.check(ns);
    await live.waitFor((c) => c.events().length >= 2);
    const secondEvent = live.events()[1];
    live.close();

    // ---- server restart --------------------------------------------------
    // A brand-new server, brand-new hub, same namespace repository: nothing
    // the feed needs lives in process memory, so the client's stored cursor is
    // the whole recovery contract.
    await app.close();
    hub.closeAll();
    const restarted = await server(fixture);
    const resumed = await openSseClient(
      restarted.app.port,
      restarted.feed(`tables=memories&cursor=${encodeURIComponent(firstCursor)}`),
    );
    expect(resumed.status).toBe(200);
    await resumed.waitFor((c) => c.events().length >= 1);

    const replayed = resumed.events()[0];
    // Strictly after the stored cursor: the second committed change arrives
    // with the position and cursor it had on the first server. Resuming from
    // an earlier persisted cursor would re-deliver an older event instead —
    // that is the at-least-once allowance, not a second delivery here.
    expect(replayed.cursor).toBe(secondEvent.cursor);
    expect(replayed.position).toEqual(secondEvent.position);
    expect(replayed.cursor).not.toBe(firstCursor);

    // Live delivery continues on the same resumed connection.
    const thirdInput = memoryInput(3, ns);
    await fixture.writer.enqueue(thirdInput);
    fixture.commit("test: e2e after restart");
    await restarted.hub.check(ns);
    await resumed.waitFor((c) => c.events().length >= 2);

    const afterRestart = resumed.events()[1];
    expect(afterRestart.op).toBe("insert");
    expect((afterRestart.row as { id: string }).id).toBe(
      (thirdInput.record as MemoryType).id,
    );
    expect(afterRestart.cursor).not.toBe(replayed.cursor);
    resumed.close();
  }, 60_000);
});
