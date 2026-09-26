/**
 * DB-SUPA-5 — the replay path applies the same subscriber allow-lists as the
 * live path (DF-0925-01).
 *
 * A resuming consumer that reconnects with a cursor and an `ops=`/`tables=`
 * subset must see the replay filtered exactly like the live subscription: the
 * live fan-out filters (`subscriber.tables` / `subscriber.ops`), so a replay
 * that pushes every derived frame leaks committed history outside the
 * subscriber's blast radius — e.g. `ops=delete` replaying every historical
 * insert.
 *
 * Named checks: `ops=delete replay drops the historical inserts`,
 * `ops=insert replay drops the delete`, `tables= replay drops other tables`,
 * `unfiltered replay is unchanged (back-compat)`.
 *
 * Every position under test is a real dbch1 cursor over real namespace
 * commits; the resuming subscription replays strictly after its boundary, the
 * same contract `realtime-replay.test.ts` pins for the unfiltered case.
 */

import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { TableSchemaRegistry } from "../../serialization/registry";
import { RealtimeHub, type Subscription } from "../realtime/hub";
import {
  createRecordingSink,
  createRealtimeFixture,
  memoryInput,
  tombstoneInput,
  writeDeclaredTable,
  type RealtimeFixture,
  type RealtimeFixtureOptions,
} from "../realtime/fixtures";
import type { ChangeOperation } from "../../serialization/changeRecord";

const fixtures: RealtimeFixture[] = [];
const hubs: RealtimeHub[] = [];
const subs: Subscription[] = [];

afterEach(() => {
  for (const sub of subs.splice(0)) sub.close();
  for (const hub of hubs.splice(0)) hub.closeAll();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function fixtureFor(
  writerOptions?: RealtimeFixtureOptions["writerOptions"],
): RealtimeFixture {
  const fixture = createRealtimeFixture("duckbrain-supa5-replay-filter-", {
    commitOnFlush: false,
    ...(writerOptions ? { writerOptions } : {}),
  });
  fixtures.push(fixture);
  return fixture;
}

function hubFor(fixture: RealtimeFixture): RealtimeHub {
  const hub = new RealtimeHub({
    namespacesPath: fixture.root,
    pollIntervalMs: 60 * 60 * 1000,
    heartbeatMs: 60 * 60 * 1000,
  });
  hubs.push(hub);
  return hub;
}

function subscribe(
  hub: RealtimeHub,
  ns: string,
  ops: ChangeOperation[],
  tables: string[],
  cursor: string | null,
): Promise<{
  sink: ReturnType<typeof createRecordingSink>;
  sub: Subscription;
}> {
  const sink = createRecordingSink();
  return hub
    .subscribe(
      { ns, principal: undefined, tables, ops, cursor, sink },
      () => undefined,
    )
    .then((sub) => {
      subs.push(sub);
      return { sink, sub };
    });
}

function opsOf(events: Array<Record<string, unknown>>): string[] {
  return events.map((event) => String(event.op));
}

function idsOf(events: Array<Record<string, unknown>>): string[] {
  return events.map((event) => String((event.row as { id: string }).id));
}

describe("DB-SUPA-5 replay allow-lists (DF-0925-01)", () => {
  it("ops=delete replay drops the historical inserts", async () => {
    const fixture = fixtureFor();
    const hub = hubFor(fixture);
    const { ns } = fixture;

    // Live delivery for the full allow-list, attached before any commit.
    const all = await subscribe(
      hub,
      ns,
      ["insert", "update", "delete"],
      ["memories"],
      null,
    );

    // Commit 1: one insert (the replay boundary lives here). Commit 2: three
    // more inserts plus one delete — the blast radius a delete-only consumer
    // must not see on resume.
    const first = memoryInput(1, ns);
    await fixture.writer.enqueue(first);
    fixture.commit("test: boundary commit");
    await hub.check(ns);
    const inserts = [2, 3, 4].map((index) => memoryInput(index, ns));
    for (const input of inserts) await fixture.writer.enqueue(input);
    const tombstone = tombstoneInput(first.record as never, ns);
    await fixture.writer.enqueue(tombstone);
    fixture.commit("test: mixed inserts + delete commit");
    await hub.check(ns);

    const live = all.sink.changeEvents();
    expect(opsOf(live)).toEqual([
      "insert",
      "insert",
      "insert",
      "insert",
      "delete",
    ]);
    const boundary = String(live[0].cursor);

    const resumed = await subscribe(
      hub,
      ns,
      ["delete"],
      ["memories"],
      boundary,
    );
    const replayed = resumed.sink.changeEvents();
    // Exactly one delete, nothing else: the three historical inserts never
    // leave the feed on a delete-only replay.
    expect(opsOf(replayed)).toEqual(["delete"]);
    expect(idsOf(replayed)).toEqual([(first.record as { id: string }).id]);
    // It is the same committed position the live subscriber saw.
    expect(replayed[0].cursor).toBe(String(live[4].cursor));
  }, 30_000);

  it("ops=insert replay drops the delete", async () => {
    const fixture = fixtureFor();
    const hub = hubFor(fixture);
    const { ns } = fixture;

    const all = await subscribe(
      hub,
      ns,
      ["insert", "update", "delete"],
      ["memories"],
      null,
    );

    await fixture.writer.enqueue(memoryInput(1, ns));
    fixture.commit("test: boundary commit");
    await hub.check(ns);
    const inserts = [2, 3, 4].map((index) => memoryInput(index, ns));
    for (const input of inserts) await fixture.writer.enqueue(input);
    const tombstone = tombstoneInput(inserts[0].record as never, ns);
    await fixture.writer.enqueue(tombstone);
    fixture.commit("test: mixed inserts + delete commit");
    await hub.check(ns);

    const live = all.sink.changeEvents();
    expect(live).toHaveLength(5);
    const boundary = String(live[0].cursor);

    const resumed = await subscribe(
      hub,
      ns,
      ["insert"],
      ["memories"],
      boundary,
    );
    const replayed = resumed.sink.changeEvents();
    // All three inserts in committed order — and NOT the delete.
    expect(opsOf(replayed)).toEqual(["insert", "insert", "insert"]);
    expect(idsOf(replayed)).toEqual(idsOf(live.slice(1, 4)));
    expect(replayed.map((event) => event.cursor)).toEqual(
      live.slice(1, 4).map((event) => String(event.cursor)),
    );
    expect(JSON.stringify(replayed)).not.toContain('"op":"delete"');
    expect(JSON.stringify(replayed)).not.toContain('"tombstone":true');
  }, 30_000);

  it("tables= replay drops other tables", async () => {
    const registry = new TableSchemaRegistry();
    const fixture = fixtureFor({ registry });
    const hub = hubFor(fixture);
    const { ns, nsPath } = fixture;
    registry.register(
      ns,
      "table_a",
      z.object({ id: z.string() }).passthrough(),
    );
    writeDeclaredTable(nsPath, "table_a", {
      primary: "id",
      columns: ["id", "v"],
    });

    const all = await subscribe(
      hub,
      ns,
      ["insert", "update", "delete"],
      ["memories", "table_a"],
      null,
    );

    // Commit 1: one memories row (the boundary). Commit 2: both tables,
    // interleaved — the cross-table rows a table_a-only consumer must not see.
    await fixture.writer.enqueue(memoryInput(1, ns));
    fixture.commit("test: boundary commit");
    await hub.check(ns);
    await fixture.writer.enqueue(memoryInput(2, ns));
    await fixture.writer.enqueue({
      ns,
      table: "table_a",
      op: "insert",
      record: { id: "table_a-1", v: 1 },
      principal: undefined,
      targetPath: "table_a/2026-09/current.jsonl",
      partitionPath: "table_a/2026-09/",
    });
    await fixture.writer.enqueue(memoryInput(3, ns));
    await fixture.writer.enqueue({
      ns,
      table: "table_a",
      op: "insert",
      record: { id: "table_a-2", v: 2 },
      principal: undefined,
      targetPath: "table_a/2026-09/current.jsonl",
      partitionPath: "table_a/2026-09/",
    });
    fixture.commit("test: mixed-table commit");
    await hub.check(ns);

    const live = all.sink.changeEvents();
    expect(live).toHaveLength(5);
    expect(live.map((event) => String(event.table))).toEqual([
      "memories",
      "memories",
      "table_a",
      "memories",
      "table_a",
    ]);
    const boundary = String(live[0].cursor);

    const resumed = await subscribe(
      hub,
      ns,
      ["insert", "update", "delete"],
      ["table_a"],
      boundary,
    );
    const replayed = resumed.sink.changeEvents();
    // Only the table_a rows, in committed order — no memories row leaks.
    expect(replayed.map((event) => String(event.table))).toEqual([
      "table_a",
      "table_a",
    ]);
    expect(idsOf(replayed)).toEqual(["table_a-1", "table_a-2"]);
    expect(JSON.stringify(replayed)).not.toContain("memories");
  }, 30_000);

  it("unfiltered replay is unchanged (back-compat)", async () => {
    const fixture = fixtureFor();
    const hub = hubFor(fixture);
    const { ns } = fixture;

    const all = await subscribe(
      hub,
      ns,
      ["insert", "update", "delete"],
      ["memories"],
      null,
    );

    await fixture.writer.enqueue(memoryInput(1, ns));
    fixture.commit("test: boundary commit");
    await hub.check(ns);
    const second = memoryInput(2, ns);
    const tombstone = tombstoneInput(second.record as never, ns);
    await fixture.writer.enqueue(second);
    await fixture.writer.enqueue(tombstone);
    fixture.commit("test: mixed-ops commit");
    await hub.check(ns);

    const live = all.sink.changeEvents();
    expect(opsOf(live)).toEqual(["insert", "insert", "delete"]);
    const boundary = String(live[0].cursor);

    const resumed = await subscribe(
      hub,
      ns,
      ["insert", "update", "delete"],
      ["memories"],
      boundary,
    );
    const replayed = resumed.sink.changeEvents();
    // Strictly after the boundary, everything the feed derived, unfiltered.
    expect(opsOf(replayed)).toEqual(opsOf(live.slice(1)));
    expect(idsOf(replayed)).toEqual(idsOf(live.slice(1)));
    expect(replayed.map((event) => event.cursor)).toEqual(
      live.slice(1).map((event) => String(event.cursor)),
    );
    expect(replayed.map((event) => event.position)).toEqual(
      live.slice(1).map((event) => event.position),
    );
  }, 30_000);
});
