/**
 * DB-SUPA-5 AC-1 — v1 wire shape.
 *
 * Named check: `v1 event schema and tombstone row image`.
 *
 * The events under test are produced by the real pipeline: a real
 * `NamespaceWriter` flush appends the accepted change records to the
 * committed `_audit` ledger, a real namespace git commit publishes them, and
 * the hub derives the wire events from the parent→child ledger diff. Nothing
 * here hand-writes an event payload.
 */

import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { commitTimeIso } from "../../git/ledger";
import {
  CHANGE_EVENT_REQUIRED_FIELDS,
  CHANGE_EVENT_NAME,
  OVERFLOW_EVENT_NAME,
  READY_EVENT_NAME,
  REVOKED_EVENT_NAME,
} from "../realtime/wire";
import { RealtimeHub } from "../realtime/hub";
import type { MemoryType } from "../../schema/memory";
import {
  createRecordingSink,
  createRealtimeFixture,
  memoryInput,
  tombstoneInput,
  type RecordingSink,
  type RealtimeFixture,
} from "../realtime/fixtures";

/**
 * The v1 payload contract, declared independently of the implementation so a
 * field rename in `wire.ts` cannot silently pass this suite. Unknown fields
 * are ignored (v1 consumers must tolerate them); required fields may not be
 * omitted.
 */
const ChangeEventV1Schema = z.object({
  version: z.literal(1),
  cursor: z.string().min(1),
  namespace: z.string().min(1),
  table: z.string().min(1),
  op: z.enum(["insert", "update", "delete"]),
  row: z.unknown(),
  position: z.object({
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    ordinal: z.number().int().positive(),
  }),
  committedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  tombstone: z.boolean(),
  schemaVersion: z.number().int().positive(),
  key: z.record(z.string(), z.unknown()),
});

const fixtures: RealtimeFixture[] = [];
const hubs: RealtimeHub[] = [];

afterEach(() => {
  for (const hub of hubs.splice(0)) hub.closeAll();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function fixtureWithWriter(
  commitOnFlush = false,
): RealtimeFixture {
  const fixture = createRealtimeFixture("duckbrain-supa5-wire-", {
    commitOnFlush,
  });
  fixtures.push(fixture);
  return fixture;
}

function hubFor(fixture: RealtimeFixture): RealtimeHub {
  // Observe commits by explicit `check()` calls: deterministic beats a timer.
  const hub = new RealtimeHub({
    namespacesPath: fixture.root,
    pollIntervalMs: 60 * 60 * 1000,
    heartbeatMs: 60 * 60 * 1000,
  });
  hubs.push(hub);
  return hub;
}

async function subscribe(
  hub: RealtimeHub,
  ns: string,
  tables: string[] = ["memories"],
): Promise<RecordingSink> {
  const sink = createRecordingSink();
  await hub.subscribe(
    {
      ns,
      principal: undefined,
      tables,
      ops: ["insert", "update", "delete"],
      cursor: null,
      sink,
    },
    () => undefined,
  );
  return sink;
}

describe("DB-SUPA-5 change feed wire contract", () => {
  it("v1 event schema and tombstone row image", async () => {
    const fixture = fixtureWithWriter();
    const hub = hubFor(fixture);
    const { ns } = fixture;

    const sink = await subscribe(hub, ns);

    // The ready control event is emitted first, carries no SSE id, and reports
    // the latest committed head only (null — nothing is committed yet).
    const ready = sink.sse().filter((frame) => frame.event === READY_EVENT_NAME);
    expect(ready).toHaveLength(1);
    expect(JSON.parse(ready[0].data ?? "{}")).toEqual({
      version: 1,
      namespace: ns,
      head: null,
    });
    expect(ready[0].id).toBeNull();
    expect(sink.frames[0]).toBe(sink.frames[0]); // first frame is the ready frame
    expect(sink.sse()[0].event).toBe(READY_EVENT_NAME);

    // One declared table (`memories`), one insert, one update, one delete —
    // all accepted by the real serializer, all committed together.
    const insert = memoryInput(1, ns);
    const inserted = insert.record as MemoryType;
    const insertedId = inserted.id;
    const updated: MemoryType = {
      ...inserted,
      embedding_text: "record 1 updated",
      timestamp: new Date().toISOString(),
    };

    const insertResult = await fixture.writer.enqueue(insert);
    const updateResult = await fixture.writer.enqueue(
      memoryInput(1, ns, { op: "update", record: updated }),
    );
    const tombstone = tombstoneInput(updated, ns);
    const deleteResult = await fixture.writer.enqueue(tombstone);

    expect(insertResult.ok).toBe(true);
    expect(updateResult.ok).toBe(true);
    expect(deleteResult.ok).toBe(true);

    // No commit has happened yet: the accepted writes are pending and no
    // change event may be published for them.
    expect(fixture.head()).toBeNull();
    expect(sink.changeEvents()).toHaveLength(0);

    fixture.commit("test: supa5 wire insert/update/delete");
    const head = fixture.head();
    expect(head).toMatch(/^[0-9a-f]{40}$/);

    await hub.check(ns);

    const events = sink.changeEvents();
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.op)).toEqual([
      "insert",
      "update",
      "delete",
    ]);

    for (const event of events) {
      const validated = ChangeEventV1Schema.safeParse(event);
      expect(validated.error?.issues ?? []).toEqual([]);
      expect(validated.success).toBe(true);

      // Every required field is present on the wire payload.
      for (const field of CHANGE_EVENT_REQUIRED_FIELDS) {
        expect(Object.prototype.hasOwnProperty.call(event, field)).toBe(true);
      }
      expect(event.version).toBe(1);
      expect(event.namespace).toBe(ns);
      expect(event.table).toBe("memories");
      expect(event.schemaVersion).toBe(1);
      expect((event.position as { commit: string }).commit).toBe(head);
      expect(event.committedAt).toBe(commitTimeIso(fixture.nsPath, head!));
      expect(event.row).not.toBeNull();
    }

    // Contiguous one-based ordinals derived from the commit's ledger diff, in
    // physical `_audit/current.jsonl` line order.
    expect(events.map((event) => (event.position as { ordinal: number }).ordinal))
      .toEqual([1, 2, 3]);

    // Each event's SSE id equals its cursor, and the cursor is opaque ASCII v1.
    const cursors = sink.cursors();
    expect(cursors).toEqual(events.map((event) => event.cursor));
    for (const cursor of cursors) {
      expect(typeof cursor).toBe("string");
      expect(cursor.startsWith("dbch1.")).toBe(true);
      expect(/^[\x20-\x7e]+$/.test(cursor)).toBe(true);
    }

    // Keys: the built-in `memories` compatibility key is `{ id }`.
    for (const event of events) {
      expect(event.key).toEqual({ id: insertedId });
    }

    // Insert/update carry the post-operation row image, not a tombstone.
    expect(events[0].tombstone).toBe(false);
    expect((events[0].row as MemoryType).embedding_text).toBe("record 1");
    expect(events[1].tombstone).toBe(false);
    expect((events[1].row as MemoryType).embedding_text).toBe(
      "record 1 updated",
    );

    // The delete is a tombstone row image plus declared key — never `row: null`.
    expect(events[2].tombstone).toBe(true);
    const deleteRow = events[2].row as MemoryType;
    expect(deleteRow).not.toBeNull();
    expect(typeof deleteRow).toBe("object");
    expect(deleteRow.action).toBe("tombstone");
    expect(deleteRow.id).toBe(insertedId);
    expect((events[2].key as { id: string }).id).toBe(insertedId);

    // The data row the event points at really exists in the committed tree.
    const dataBody = fixture.git([
      "show",
      `${head}:${(insert as { targetPath: string }).targetPath}`,
    ]);
    expect(dataBody).toContain(`"id":"${insertedId}"`);

    // Reserved `transaction` is optional: a v1 consumer ignores unknown fields
    // and a payload that omits a required field is NOT a valid v1 event.
    expect(
      ChangeEventV1Schema.safeParse({ ...events[0], transaction: "batch-1" })
        .success,
    ).toBe(true);
    const { row: _omitted, ...withoutRow } = events[0];
    expect(ChangeEventV1Schema.safeParse(withoutRow).success).toBe(false);

    // Frame names are exactly the four versioned control/change names: the
    // change frame is the only one carrying a payload of row data.
    expect(CHANGE_EVENT_NAME).toBe("duckbrain.change.v1");
    expect(READY_EVENT_NAME).toBe("duckbrain.ready.v1");
    expect(OVERFLOW_EVENT_NAME).toBe("duckbrain.overflow.v1");
    expect(REVOKED_EVENT_NAME).toBe("duckbrain.revoked.v1");

    // The serializer's process-local `seq` never reaches the wire.
    for (const event of events) {
      expect(Object.prototype.hasOwnProperty.call(event, "seq")).toBe(false);
      expect(JSON.stringify(event)).not.toContain('"seq"');
    }
  }, 30_000);
});
