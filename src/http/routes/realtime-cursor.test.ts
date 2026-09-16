/**
 * DB-SUPA-5 AC-3 — committed cursor, not sequence.
 *
 * Named checks: `does not publish pre-commit sequence`,
 * `cursor replays after process restart without secret state`,
 * `tampered or unreachable cursor is invalid`.
 *
 * Every cursor under test is one the real feed issued; the tampering cases are
 * built from the documented canonical form.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { MemoryType } from "../../schema/memory";
import type { WriteResult } from "../../serialization/types";
import {
  canonicalCursorJson,
  CURSOR_PREFIX,
  decodeCursor,
  encodeCursor,
  RealtimeError,
} from "../realtime/cursor";
import { RealtimeHub, type Subscription } from "../realtime/hub";
import {
  createRecordingSink,
  createRealtimeFixture,
  memoryInput,
  type RealtimeFixture,
} from "../realtime/fixtures";

const fixtures: RealtimeFixture[] = [];
const hubs: RealtimeHub[] = [];

afterEach(() => {
  for (const hub of hubs.splice(0)) hub.closeAll();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function fixtureWithWriter(commitOnFlush = false): RealtimeFixture {
  const fixture = createRealtimeFixture("duckbrain-supa5-cursor-", {
    commitOnFlush,
  });
  fixtures.push(fixture);
  return fixture;
}

/** A hub with no shared process state beyond the namespace repository. */
function hubFor(fixture: RealtimeFixture): RealtimeHub {
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
  cursor: string | null = null,
  tables: string[] = ["memories"],
): Promise<{ sink: ReturnType<typeof createRecordingSink>; sub: Subscription }> {
  const sink = createRecordingSink();
  const sub = await hub.subscribe(
    { ns, principal: undefined, tables, ops: ["insert", "update", "delete"], cursor, sink },
    () => undefined,
  );
  return { sink, sub };
}

async function subscribeError(
  hub: RealtimeHub,
  ns: string,
  cursor: string,
  tables: string[] = ["memories"],
): Promise<RealtimeError> {
  try {
    await hub.subscribe(
      {
        ns,
        principal: undefined,
        tables,
        ops: ["insert", "update", "delete"],
        cursor,
        sink: createRecordingSink(),
      },
      () => undefined,
    );
  } catch (error) {
    expect(error).toBeInstanceOf(RealtimeError);
    return error as RealtimeError;
  }
  throw new Error(`expected subscription with cursor '${cursor}' to fail`);
}

describe("DB-SUPA-5 cursor semantics", () => {
  it("does not publish pre-commit sequence", async () => {
    const fixture = fixtureWithWriter();
    const hub = hubFor(fixture);
    const { ns } = fixture;

    const { sink } = await subscribe(hub, ns);

    // Accepted writes with a process-local seq, no commit yet.
    const inputs = [1, 2, 3].map((index) => memoryInput(index, ns));
    const ids = inputs.map((input) => (input.record as MemoryType).id);
    const results: WriteResult[] = [];
    for (const input of inputs) results.push(await fixture.writer.enqueue(input));
    for (const result of results) expect(result.ok).toBe(true);
    expect(results.map((result) => result.seq)).toEqual([1, 2, 3]);
    expect(fixture.head()).toBeNull();

    // Polling the feed while the rows are uncommitted is a no-op.
    await hub.check(ns);
    await hub.check(ns);

    expect(sink.changeEvents()).toHaveLength(0);
    // Nothing to resume from: the ready event reports no committed head and no
    // frame carries an SSE id, so no resumable cursor exists pre-commit.
    const ready = sink.sse()[0];
    expect(ready.event).toBe("duckbrain.ready.v1");
    expect(JSON.parse(ready.data ?? "{}").head).toBeNull();
    for (const frame of sink.sse()) expect(frame.id).toBeNull();
    expect(sink.text()).not.toContain(CURSOR_PREFIX);
    // The process-local seq never appears on the wire either.
    expect(sink.text()).not.toMatch(/"seq"/);

    // Committing publishes all three, in ledger order, with derived ordinals.
    fixture.commit("test: pre-commit invisibility");
    await hub.check(ns);
    const events = sink.changeEvents();
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.position)).toMatchObject([
      { ordinal: 1 },
      { ordinal: 2 },
      { ordinal: 3 },
    ]);
    for (const event of events) {
      const decoded = decodeCursor(String(event.cursor));
      expect(decoded).not.toBeNull();
      expect(decoded!.commit).toBe(fixture.head());
      // A cursor carries the committed position only — never a serializer seq.
      expect(decoded!.ordinal).toBeLessThanOrEqual(3);
    }
    // Ordinals are commit-diff derived, not the serializer's seq ordering by
    // luck: the same rows read straight off the ledger agree, in write order.
    expect(events.map((event) => (event.row as { id: string }).id)).toEqual(ids);
  }, 30_000);

  it("cursor replays after process restart without secret state", async () => {
    const fixture = fixtureWithWriter();
    const { ns } = fixture;
    const first = hubFor(fixture);
    const { sink } = await subscribe(first, ns);

    await fixture.writer.enqueue(memoryInput(1, ns));
    await fixture.writer.enqueue(memoryInput(2, ns));
    fixture.commit("test: batch one");
    await first.check(ns);

    const before = sink.changeEvents();
    expect(before).toHaveLength(2);
    const captured = String(before[1].cursor);
    first.closeAll();

    // The cursor is fully self-describing: canonical JSON of the committed
    // position, base64url encoded, with no signature, HMAC or key identifier.
    const payload = Buffer.from(
      captured.slice(CURSOR_PREFIX.length),
      "base64url",
    ).toString("utf-8");
    expect(payload).toBe(
      canonicalCursorJson(
        ns,
        String((before[1].position as { commit: string }).commit),
        (before[1].position as { ordinal: number }).ordinal,
      ),
    );
    expect(payload).not.toMatch(/hmac|signature|kid|secret|token/i);
    expect(decodeCursor(captured)).toEqual({
      ns,
      commit: String((before[1].position as { commit: string }).commit),
      ordinal: (before[1].position as { ordinal: number }).ordinal,
    });

    // "Restart": a brand-new hub instance and a brand-new writer (its seq
    // counter starts over at 1) resume from the stored cursor and see
    // strictly-after committed changes only.
    const restartedHub = hubFor(fixture);
    const restartedWriter = createRealtimeFixture("duckbrain-supa5-cursor-r-", {
      root: fixture.root,
      namespace: ns,
      commitOnFlush: false,
    }).writer;
    await restartedWriter.enqueue(memoryInput(3, ns));
    await restartedWriter.enqueue(memoryInput(4, ns));
    fixture.commit("test: batch two after restart");

    const resumed = await subscribe(restartedHub, ns, captured);
    const replayed = resumed.sink.changeEvents();
    expect(replayed).toHaveLength(2);
    // No duplicate of the cursor's own event, no gap: contiguous commit-diff
    // ordinals from the same new commit.
    expect(replayed.map((event) => (event.position as { ordinal: number }).ordinal))
      .toEqual([1, 2]);
    expect(replayed.map((event) => (event.row as { id: string }).id).length).toBe(2);
    expect(replayed.map((event) => event.cursor)).not.toContain(captured);
    expect(
      (replayed[0].position as { commit: string }).commit,
    ).toBe(fixture.head());
    // And the ready head advances to the latest committed cursor.
    const ready = resumed.sink.sse()[0];
    expect(JSON.parse(ready.data ?? "{}").head).toBe(
      String(replayed[replayed.length - 1].cursor),
    );

    resumed.sub.close();
  }, 30_000);

  it("tampered or unreachable cursor is invalid", async () => {
    const fixture = fixtureWithWriter();
    const { ns } = fixture;
    const hub = hubFor(fixture);

    // Subscribe BEFORE the write: a fresh subscriber anchors on the committed
    // head at connect time, so the commit under test is live delivery.
    const { sink, sub } = await subscribe(hub, ns);
    await fixture.writer.enqueue(memoryInput(1, ns));
    fixture.commit("test: cursor provenance");
    await hub.check(ns);
    const events = sink.changeEvents();
    expect(events).toHaveLength(1);
    const good = String(events[0].cursor);
    const commit = String((events[0].position as { commit: string }).commit);
    sub.close();

    // The untampered cursor is accepted.
    const accepted = await subscribe(hub, ns, good);
    accepted.sub.close();

    // Byte-level tamper inside the base64url payload.
    const tampered = `${CURSOR_PREFIX}${
      good[CURSOR_PREFIX.length] === "A" ? "B" : "A"
    }${good.slice(CURSOR_PREFIX.length + 1)}`;
    expect(tampered).not.toBe(good);

    // A cursor for a position this commit never contained.
    const impossible = encodeCursor(ns, commit, 99);

    // Non-canonical encodings a client must never construct: wrong version,
    // wrong namespace, whitespace/key-order drift, missing padding-free form.
    const wrongVersion = `${CURSOR_PREFIX}${Buffer.from(
      canonicalCursorJson(ns, commit, 1).replace('"v":1', '"v":2'),
      "utf-8",
    ).toString("base64url")}`;
    const wrongNamespace = encodeCursor(`${ns}-other`, commit, 1);
    const nonCanonical = `${CURSOR_PREFIX}${Buffer.from(
      JSON.stringify({ ordinal: 1, commit, ns, v: 1 }),
      "utf-8",
    ).toString("base64url")}`;
    const spaced = `${CURSOR_PREFIX}${Buffer.from(
      canonicalCursorJson(ns, commit, 1).replace(",", ", "),
      "utf-8",
    ).toString("base64url")}`;
    const padded = `${good}==`;
    const notACursor = "1";

    for (const bad of [
      tampered,
      impossible,
      wrongVersion,
      wrongNamespace,
      nonCanonical,
      spaced,
      padded,
      notACursor,
      CURSOR_PREFIX,
    ]) {
      const error = await subscribeError(hub, ns, bad);
      expect({ cursor: bad, code: error.code, status: error.status }).toEqual({
        cursor: bad,
        code: "INVALID_CURSOR",
        status: 400,
      });
      // Cursor validation grants no access and never leaks a position.
      expect(error.message).not.toContain(CURSOR_PREFIX);
    }

    // A commit that exists but is NOT on the reachable first-parent history of
    // HEAD is unreachable, and is invalid rather than replayed.
    fixture.git(["checkout", "-q", "-b", "side"]);
    fixture.git([
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=test",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "side commit",
    ]);
    const sideCommit = fixture.git(["rev-parse", "HEAD"]);
    fixture.git(["checkout", "-q", "-"]);
    expect(fixture.head()).not.toBe(sideCommit);
    const unreachable = await subscribeError(
      hub,
      ns,
      encodeCursor(ns, sideCommit, 1),
    );
    expect(unreachable.code).toBe("INVALID_CURSOR");
    expect(unreachable.status).toBe(400);

    // A commit the repository no longer contains is a documented 410, not a
    // silent empty stream: the client must full-resync.
    const gone = await subscribeError(
      hub,
      ns,
      encodeCursor(ns, "0".repeat(40), 1),
    );
    expect(gone.code).toBe("CHANGE_CURSOR_GONE");
    expect(gone.status).toBe(410);
    expect(gone.guidance).toMatch(/full resync/i);

    // A rewritten (pruned) commit: capture a live cursor, amend HEAD so that
    // commit stops being reachable, then resume from the captured cursor.
    const live = await subscribe(hub, ns);
    await fixture.writer.enqueue(memoryInput(2, ns));
    fixture.commit("test: second commit");
    const secondHead = fixture.head()!;
    await hub.check(ns);
    const secondEvents = live.sink.changeEvents();
    expect(secondEvents).toHaveLength(1);
    expect(String(secondEvents[0].cursor)).toBe(
      encodeCursor(
        ns,
        secondHead,
        (secondEvents[0].position as { ordinal: number }).ordinal,
      ),
    );
    live.sub.close();

    fixture.git([
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=test",
      "commit",
      "-q",
      "--amend",
      "-m",
      "test: rewritten",
    ]);
    expect(fixture.head()).not.toBe(secondHead);
    const rewritten = await subscribeError(
      hub,
      ns,
      String(secondEvents[0].cursor),
    );
    // The commit object the cursor named is still in the repository but no
    // longer on the reachable history: invalid, never silently skipped.
    expect(["INVALID_CURSOR", "CHANGE_CURSOR_GONE"]).toContain(rewritten.code);
    expect([400, 410]).toContain(rewritten.status);
  }, 30_000);
});
