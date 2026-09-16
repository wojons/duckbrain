/**
 * DB-SUPA-5 AC-6 — bounded fan-out and liveness.
 *
 * Named checks: `slow subscriber overflow is isolated`,
 * `heartbeat and close cleanup`.
 *
 * The slow subscriber is a real sink whose write returns backpressure (the
 * fixture's deliberately slow response sink), driven through the real hub —
 * queue bounds are exercised, not inferred from a spy.
 */

import { describe, it, expect, afterEach } from "vitest";
import { getConfig } from "../../config";
import { RealtimeHub, type Subscription } from "../realtime/hub";
import { OVERFLOW_EVENT_NAME } from "../realtime/wire";
import {
  createRecordingSink,
  createRealtimeFixture,
  delay,
  memoryInput,
  type RecordingSink,
  type RealtimeFixture,
} from "../realtime/fixtures";

const fixtures: RealtimeFixture[] = [];
const hubs: RealtimeHub[] = [];
const subs: Subscription[] = [];

afterEach(() => {
  for (const sub of subs.splice(0)) sub.close();
  for (const hub of hubs.splice(0)) hub.closeAll();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function newFixture(): RealtimeFixture {
  const fixture = createRealtimeFixture("duckbrain-supa5-fanout-", {
    commitOnFlush: false,
  });
  fixtures.push(fixture);
  return fixture;
}

function newHub(fixture: RealtimeFixture, overrides = {}): RealtimeHub {
  const hub = new RealtimeHub({
    namespacesPath: fixture.root,
    pollIntervalMs: 60 * 60 * 1000,
    heartbeatMs: 60 * 60 * 1000,
    ...overrides,
  });
  hubs.push(hub);
  return hub;
}

async function subscribe(hub: RealtimeHub, ns: string, sink: RecordingSink) {
  const sub = await hub.subscribe(
    {
      ns,
      principal: undefined,
      tables: ["memories"],
      ops: ["insert", "update", "delete"],
      cursor: null,
      sink,
    },
    () => undefined,
  );
  subs.push(sub);
  return sub;
}

async function commitRows(
  fixture: RealtimeFixture,
  hub: RealtimeHub,
  count: number,
  start = 1,
): Promise<void> {
  for (let index = start; index < start + count; index += 1) {
    await fixture.writer.enqueue(memoryInput(index, fixture.ns));
  }
  fixture.commit(`test: fanout rows ${start}..${start + count - 1}`);
  await hub.check(fixture.ns);
}

describe("DB-SUPA-5 bounded fan-out", () => {
  it("slow subscriber overflow is isolated", async () => {
    const fixture = newFixture();
    // Two queued events per subscriber: the bound under test.
    const hub = newHub(fixture, { maxQueueEvents: 2 });
    const { ns } = fixture;

    const healthy = createRecordingSink();
    const slow = createRecordingSink();

    await subscribe(hub, ns, healthy);
    await subscribe(hub, ns, slow);
    expect(hub.countFor(ns)).toBe(2);

    // One committed change is delivered to both, so the slow subscriber has a
    // LAST DELIVERED CURSOR before it stops draining.
    await commitRows(fixture, hub, 1);
    await delay(50);
    expect(healthy.changeEvents().map((event) => event.op)).toEqual(["insert"]);
    expect(slow.changeEvents().map((event) => event.op)).toEqual(["insert"]);
    expect(slow.changeEvents()).toHaveLength(1);

    // Now the slow client stops draining: every further write buffers. Four
    // more changes fill the two-event queue and then trip the bound.
    slow.blocking = true;
    await commitRows(fixture, hub, 4, 2);

    // The healthy subscriber continues in order...
    expect(healthy.changeEvents().map((event) => event.op)).toEqual([
      "insert",
      "insert",
      "insert",
      "insert",
      "insert",
    ]);
    // Positions are per-commit ordinals: the first change arrived in its own
    // commit, the next four in the second commit.
    expect(
      healthy
        .changeEvents()
        .map((event) => (event.position as { ordinal: number }).ordinal),
    ).toEqual([1, 1, 2, 3, 4]);

    // ...while only the slow one gets the overflow control event carrying its
    // last delivered cursor, and its connection closes.
    const overflow = slow
      .sse()
      .filter((frame) => frame.event === OVERFLOW_EVENT_NAME);
    expect(overflow).toHaveLength(1);
    // The overflow reports the last cursor actually handed to that sink: the
    // event whose write returned backpressure and started the stall.
    const slowEvents = slow.changeEvents();
    const lastDelivered = String(slowEvents[slowEvents.length - 1].cursor);
    expect(JSON.parse(overflow[0].data ?? "{}")).toEqual({
      version: 1,
      namespace: ns,
      cursor: lastDelivered,
    });
    expect(overflow[0].id).toBeNull();
    expect(slow.closed).toBe(true);
    expect(slow.drained).toBe(1);
    // The overflow ended the stream and dropped the queue: the stalled
    // subscriber never receives the queued rows, and only one overflow frame
    // is emitted.
    expect(slowEvents).toHaveLength(2);
    expect(
      slowEvents.map(
        (event) => (event.position as { ordinal: number }).ordinal,
      ),
    ).toEqual([1, 1]);
    expect(slow.text().split(OVERFLOW_EVENT_NAME)).toHaveLength(2);

    // The healthy subscriber is unaffected and still registered.
    expect(hub.countFor(ns)).toBe(1);
    expect(hub.subscriberCount).toBe(1);

    // It keeps working after the overflow: the next commit still arrives.
    await commitRows(fixture, hub, 1, 6);
    await delay(50);
    expect(healthy.changeEvents()).toHaveLength(6);
    expect(
      healthy.changeEvents()[5].position as { ordinal: number; commit: string },
    ).toMatchObject({ ordinal: 1 });

    // A byte bound behaves the same way, independently of the event count.
    // The bound is measured from a real change frame: it fits one queued
    // frame but never two, so the overflow is caused by bytes, not count.
    const frameBytes = Math.max(
      ...healthy
        .frames!.filter((frame) => frame.includes("duckbrain.change.v1"))
        .map((frame) => Buffer.byteLength(frame)),
    );
    const byteFixture = newFixture();
    const byteHub = newHub(byteFixture, {
      maxQueueEvents: 1000,
      maxQueueBytes: Math.floor(frameBytes * 1.5),
    });
    const byteSlow = createRecordingSink(true);
    const byteHealthy = createRecordingSink();
    await subscribe(byteHub, byteFixture.ns, byteSlow);
    await subscribe(byteHub, byteFixture.ns, byteHealthy);
    await commitRows(byteFixture, byteHub, 4);
    expect(
      byteSlow.sse().filter((frame) => frame.event === OVERFLOW_EVENT_NAME),
    ).toHaveLength(1);
    expect(byteHealthy.changeEvents()).toHaveLength(4);
    expect(
      byteHealthy
        .changeEvents()
        .map((event) => (event.position as { ordinal: number }).ordinal),
    ).toEqual([1, 2, 3, 4]);
    expect(byteHub.countFor(byteFixture.ns)).toBe(1);
  }, 30_000);

  it("heartbeat and close cleanup", async () => {
    const fixture = newFixture();
    const hub = newHub(fixture, { heartbeatMs: 40 });
    const { ns } = fixture;

    // The documented default interval is 15 seconds.
    expect(getConfig(".").realtime.heartbeatMs).toBe(15_000);

    const live = createRecordingSink();
    const liveSub = await subscribe(hub, ns, live);
    await delay(120);

    const comments = live
      .sse()
      .filter((frame) => frame.comment !== null)
      .map((frame) => frame.comment);
    expect(comments.length).toBeGreaterThanOrEqual(2);
    for (const comment of comments) expect(comment).toBe("heartbeat");
    // A heartbeat is a comment frame: no event, no data, no SSE id.
    for (const frame of live.sse().filter((f) => f.comment !== null)) {
      expect(frame.event).toBeNull();
      expect(frame.data).toBeNull();
      expect(frame.id).toBeNull();
    }
    expect(live.changeEvents()).toHaveLength(0);

    // A subscriber that is not draining gets no heartbeat: the hub never
    // writes into a pending queue.
    const stalled = createRecordingSink(true);
    const stalledSub = await subscribe(hub, ns, stalled);
    const stalledBefore = stalled.frames.length;
    await delay(150);
    expect(stalled.frames.length).toBe(stalledBefore);
    expect(
      stalled.sse().filter((frame) => frame.comment !== null),
    ).toHaveLength(0);

    // Pending queue state is dropped and the timer removed on close.
    await commitRows(fixture, hub, 1);
    const liveFramesAfterCommit = live.frames.length;
    expect(live.changeEvents()).toHaveLength(1);
    expect(hub.countFor(ns)).toBe(2);

    liveSub.close();
    stalledSub.close();
    expect(hub.countFor(ns)).toBe(0);
    expect(liveSub.closed).toBe(true);
    expect(stalledSub.closed).toBe(true);
    // Idempotent: closing an already-closed subscription cannot double-remove
    // or corrupt the feed state.
    liveSub.close();
    stalledSub.close();
    expect(hub.countFor(ns)).toBe(0);

    // No heartbeat or queued frame arrives after the close removed the state.
    await delay(150);
    expect(live.frames.length).toBe(liveFramesAfterCommit);
    expect(stalled.frames.length).toBe(stalledBefore);

    // Reconnecting rebuilds clean state and works.
    const again = createRecordingSink();
    await subscribe(hub, ns, again);
    expect(hub.countFor(ns)).toBe(1);
    expect(hub.namespaceCount).toBe(1);
    await commitRows(fixture, hub, 1, 2);
    await delay(50);
    expect(again.changeEvents()).toHaveLength(1);
  }, 30_000);
});
