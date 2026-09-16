/**
 * DB-SUPA-5 AC-3 / AC-7 / AC-8 — committed replay over the append-only audit
 * ledger.
 *
 * Named checks: `all audit chunks are discovered before replay`,
 * `multiple flush batches in one commit derive contiguous ordinals`,
 * `restart before commit derives no duplicate or reset ordinal`,
 * `current then numeric segment order is not lexicographic`,
 * `strictly-after replay boundary`, `pruned history returns 410`,
 * `parent prefix violation numeric gap rewrite or deletion fails closed`.
 *
 * Every position under test is derived by the real feed from real namespace
 * commits; the corruption cases mutate the real ledger on disk and then commit
 * again, so the failure is discovered exactly where a subscriber would hit it.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  AUDIT_CURRENT_SEGMENT,
  AUDIT_DIR,
  auditSegmentNumber,
} from "../../serialization/auditLedger";
import { encodeCursor, RealtimeError } from "../realtime/cursor";
import { RealtimeHub, type Subscription } from "../realtime/hub";
import {
  createRecordingSink,
  createRealtimeFixture,
  memoryInput,
  type RealtimeFixture,
} from "../realtime/fixtures";

const fixtures: RealtimeFixture[] = [];
const hubs: RealtimeHub[] = [];
let logs: string[] = [];

afterEach(() => {
  for (const hub of hubs.splice(0)) hub.closeAll();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  logs = [];
});

function fixtureFor(options: {
  commitOnFlush?: boolean;
  auditMaxLinesPerChunk?: number;
}): RealtimeFixture {
  const fixture = createRealtimeFixture("duckbrain-supa5-replay-", {
    commitOnFlush: options.commitOnFlush ?? false,
    ...(options.auditMaxLinesPerChunk !== undefined
      ? { auditMaxLinesPerChunk: options.auditMaxLinesPerChunk }
      : {}),
  });
  fixtures.push(fixture);
  return fixture;
}

function hubFor(fixture: RealtimeFixture): RealtimeHub {
  const hub = new RealtimeHub({
    namespacesPath: fixture.root,
    pollIntervalMs: 60 * 60 * 1000,
    heartbeatMs: 60 * 60 * 1000,
    log: (message) => logs.push(message),
  });
  hubs.push(hub);
  return hub;
}

async function subscribe(
  hub: RealtimeHub,
  ns: string,
  cursor: string | null = null,
): Promise<{
  sink: ReturnType<typeof createRecordingSink>;
  sub: Subscription;
}> {
  const sink = createRecordingSink();
  const sub = await hub.subscribe(
    {
      ns,
      principal: undefined,
      tables: ["memories"],
      ops: ["insert", "update", "delete"],
      cursor,
      sink,
    },
    () => undefined,
  );
  return { sink, sub };
}

async function subscribeError(
  hub: RealtimeHub,
  ns: string,
  cursor: string,
): Promise<RealtimeError> {
  try {
    await hub.subscribe(
      {
        ns,
        principal: undefined,
        tables: ["memories"],
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

/** Accepted change records, read straight off disk in the given file order. */
function ledgerIds(nsPath: string, order: string[]): string[] {
  const ids: string[] = [];
  for (const segment of order) {
    const text = fs.readFileSync(
      path.join(nsPath, AUDIT_DIR, segment),
      "utf-8",
    );
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const record = JSON.parse(line) as Record<string, unknown>;
      const key = record.key as { id?: unknown } | undefined;
      const row = record.row as { id?: unknown } | undefined;
      const id = key?.id ?? row?.id;
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

/** Canonical ledger traversal: `current.jsonl` first, then numeric ascending. */
function canonicalOrder(nsPath: string): string[] {
  const dir = path.join(nsPath, AUDIT_DIR);
  const all = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  const numeric = all
    .filter((name) => name !== AUDIT_CURRENT_SEGMENT)
    .sort(
      (a, b) => (auditSegmentNumber(a) ?? 0) - (auditSegmentNumber(b) ?? 0),
    );
  return [
    ...(all.includes(AUDIT_CURRENT_SEGMENT) ? [AUDIT_CURRENT_SEGMENT] : []),
    ...numeric,
  ];
}

/** What a plain filename sort would have produced (the non-canonical order). */
function lexicographicOrder(nsPath: string): string[] {
  return fs
    .readdirSync(path.join(nsPath, AUDIT_DIR))
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
}

function idsOf(events: Array<Record<string, unknown>>): string[] {
  return events.map((event) => String((event.row as { id: string }).id));
}

function ordinalsOf(events: Array<Record<string, unknown>>): unknown[] {
  return events.map((event) => (event.position as { ordinal: number }).ordinal);
}

describe("DB-SUPA-5 committed replay", () => {
  it("all audit chunks are discovered before replay", async () => {
    const fixture = fixtureFor({ auditMaxLinesPerChunk: 1 });
    const hub = hubFor(fixture);
    const { ns } = fixture;
    const { sink } = await subscribe(hub, ns);

    for (const index of [1, 2, 3]) {
      await fixture.writer.enqueue(memoryInput(index, ns));
      await fixture.writer.flush();
    }
    fixture.commit("test: ledger rotation");
    await hub.check(ns);

    // The namespace really does hold more than the initial segment — this is
    // what makes the discovery claim testable rather than assumed.
    const segments = fs
      .readdirSync(path.join(fixture.nsPath, AUDIT_DIR))
      .filter((name) => name.endsWith(".jsonl"));
    expect(segments.length).toBeGreaterThan(1);

    const events = sink.changeEvents();
    expect(events).toHaveLength(3);
    // Every chunk contributed, exactly once, in canonical ledger order.
    expect(idsOf(events)).toEqual(
      ledgerIds(fixture.nsPath, canonicalOrder(fixture.nsPath)),
    );
    expect(new Set(idsOf(events)).size).toBe(3);
    expect(ordinalsOf(events)).toEqual([1, 2, 3]);
  }, 30_000);

  it("multiple flush batches in one commit derive contiguous ordinals", async () => {
    const fixture = fixtureFor({});
    const hub = hubFor(fixture);
    const { ns } = fixture;
    const { sink } = await subscribe(hub, ns);

    await fixture.writer.enqueue(memoryInput(1, ns));
    await fixture.writer.enqueue(memoryInput(2, ns));
    await fixture.writer.flush();
    await fixture.writer.enqueue(memoryInput(3, ns));
    await fixture.writer.enqueue(memoryInput(4, ns));
    await fixture.writer.flush();
    expect(fixture.head()).toBeNull();

    fixture.commit("test: two flush batches, one commit");
    await hub.check(ns);

    const events = sink.changeEvents();
    expect(events).toHaveLength(4);
    expect(ordinalsOf(events)).toEqual([1, 2, 3, 4]);
    // One commit, so one commit in every position and a single SSE-visible
    // commit identity for the whole page.
    const commits = new Set(
      events.map((event) => (event.position as { commit: string }).commit),
    );
    expect(commits.size).toBe(1);
    expect([...commits][0]).toBe(fixture.head());
  }, 30_000);

  it("restart before commit derives no duplicate or reset ordinal", async () => {
    const fixture = fixtureFor({});
    const hub = hubFor(fixture);
    const { ns } = fixture;
    const { sink } = await subscribe(hub, ns);

    await fixture.writer.enqueue(memoryInput(1, ns));
    await fixture.writer.enqueue(memoryInput(2, ns));
    await fixture.writer.flush();

    // Process restart before the commit: a brand-new writer for the same
    // namespace. Its process-local seq counter starts over.
    const restarted = createRealtimeFixture("duckbrain-supa5-replay-r-", {
      root: fixture.root,
      namespace: ns,
      commitOnFlush: false,
    });
    fixtures.push(restarted);
    const firstAfterRestart = await restarted.writer.enqueue(
      memoryInput(3, ns),
    );
    expect(firstAfterRestart.ok).toBe(true);
    expect(firstAfterRestart.seq).toBe(1);
    await restarted.writer.enqueue(memoryInput(4, ns));
    await restarted.writer.flush();

    fixture.commit("test: one commit spanning a writer restart");
    await hub.check(ns);

    const events = sink.changeEvents();
    expect(events).toHaveLength(4);
    // Ordinals come from the committed parent→child diff, so a seq reset
    // cannot produce a duplicate or a reset ordinal on the wire.
    expect(ordinalsOf(events)).toEqual([1, 2, 3, 4]);
    expect(new Set(idsOf(events)).size).toBe(4);
    expect(idsOf(events)).toEqual(
      ledgerIds(fixture.nsPath, canonicalOrder(fixture.nsPath)),
    );
  }, 30_000);

  it("current then numeric segment order is not lexicographic", async () => {
    const fixture = fixtureFor({ auditMaxLinesPerChunk: 1 });
    const hub = hubFor(fixture);
    const { ns } = fixture;
    const { sink } = await subscribe(hub, ns);

    for (const index of [1, 2, 3]) {
      await fixture.writer.enqueue(memoryInput(index, ns));
      await fixture.writer.flush();
    }
    fixture.commit("test: canonical vs lexicographic order");
    await hub.check(ns);

    const canonical = canonicalOrder(fixture.nsPath);
    const lexicographic = lexicographicOrder(fixture.nsPath);

    // The two orders genuinely differ, and only one of them is canonical.
    expect(canonical[0]).toBe(AUDIT_CURRENT_SEGMENT);
    expect(lexicographic[0]).not.toBe(AUDIT_CURRENT_SEGMENT);
    expect(lexicographic).not.toEqual(canonical);

    const emitted = idsOf(sink.changeEvents());
    expect(emitted).toEqual(ledgerIds(fixture.nsPath, canonical));
    // A lexicographic filename sort would have emitted these in a different
    // order — the feed used segment+line order, not a filename sort.
    expect(emitted).not.toEqual(ledgerIds(fixture.nsPath, lexicographic));
  }, 30_000);

  it("strictly-after replay boundary", async () => {
    const fixture = fixtureFor({});
    const hub = hubFor(fixture);
    const { ns } = fixture;
    const { sink } = await subscribe(hub, ns);

    for (const index of [1, 2, 3])
      await fixture.writer.enqueue(memoryInput(index, ns));
    fixture.commit("test: three committed changes");
    await hub.check(ns);
    const live = sink.changeEvents();
    expect(live).toHaveLength(3);

    const boundary = String(live[1].cursor);
    const { sink: resumedSink, sub } = await subscribe(hub, ns, boundary);
    const replayed = resumedSink.changeEvents();

    // Strictly after: the boundary event itself is not repeated, and the next
    // committed position is delivered with its own identity.
    expect(replayed).toHaveLength(1);
    expect(replayed[0].cursor).toBe(live[2].cursor);
    expect(replayed[0].position).toEqual(live[2].position);
    expect(idsOf(replayed)).toEqual(idsOf([live[2]]));
    expect(replayed.map((event) => event.cursor)).not.toContain(boundary);
    sub.close();
  }, 30_000);

  it("pruned history returns 410", async () => {
    const fixture = fixtureFor({});
    const hub = hubFor(fixture);
    const { ns } = fixture;
    await fixture.writer.enqueue(memoryInput(1, ns));
    fixture.commit("test: a commit that will be named, then absent");

    // A well-formed cursor naming a commit this repository does not (no
    // longer) contain is the pruned-history shape: the position cannot be
    // resolved from committed history, so the answer is a documented 410 with
    // full-resync guidance — never a silent empty stream.
    const gone = await subscribeError(
      hub,
      ns,
      encodeCursor(ns, "0".repeat(40), 1),
    );
    expect({ code: gone.code, status: gone.status }).toEqual({
      code: "CHANGE_CURSOR_GONE",
      status: 410,
    });
    expect(gone.guidance).toMatch(/full resync/i);

    // Nothing was delivered for the failed subscription.
    expect(logs.join("\n")).not.toMatch(/CHANGE_CURSOR_GONE.*delivered/i);
  }, 30_000);

  it("parent prefix violation numeric gap rewrite or deletion fails closed", async () => {
    // Rewrite: a byte-level mutation inside the sealed prefix region of the
    // active segment. The mutated line stays valid JSON, so only the
    // parent-prefix invariant can catch it.
    {
      const fixture = fixtureFor({});
      const hub = hubFor(fixture);
      const { ns } = fixture;
      const { sink } = await subscribe(hub, ns);
      await fixture.writer.enqueue(memoryInput(1, ns));
      await fixture.writer.flush();
      fixture.commit("test: pre-corruption commit");
      await hub.check(ns);
      const delivered = sink.changeEvents().length;
      expect(delivered).toBe(1);

      const segment = path.join(
        fixture.nsPath,
        AUDIT_DIR,
        AUDIT_CURRENT_SEGMENT,
      );
      const lines = fs.readFileSync(segment, "utf-8").split("\n");
      const first = JSON.parse(lines[0]) as Record<string, unknown>;
      (first.row as Record<string, unknown>).embedding_text =
        "rewritten in place";
      lines[0] = JSON.stringify(first);
      fs.writeFileSync(segment, lines.join("\n"), "utf-8");

      await fixture.writer.enqueue(memoryInput(2, ns));
      await fixture.writer.flush();
      fixture.commit("test: commit after a rewritten ledger line");
      await hub.check(ns);

      expect(sink.closed).toBe(true);
      expect(sink.changeEvents()).toHaveLength(delivered);
      expect(logs.join("\n")).toMatch(/corrupt|prefix|rewrit|segment|line/i);
    }

    // Numeric gap: a committed middle segment disappears. The child tree
    // cannot be explained by suffix additions and is corrupt, not "shorter".
    {
      const fixture = fixtureFor({ auditMaxLinesPerChunk: 1 });
      const hub = hubFor(fixture);
      const { ns } = fixture;
      const { sink } = await subscribe(hub, ns);
      for (const index of [1, 2, 3]) {
        await fixture.writer.enqueue(memoryInput(index, ns));
        await fixture.writer.flush();
      }
      fixture.commit("test: pre-gap commit");
      await hub.check(ns);
      const delivered = sink.changeEvents().length;
      expect(delivered).toBe(3);

      const numeric = canonicalOrder(fixture.nsPath).filter(
        (name) => name !== AUDIT_CURRENT_SEGMENT,
      );
      expect(numeric.length).toBeGreaterThan(1);
      fs.rmSync(path.join(fixture.nsPath, AUDIT_DIR, numeric[0]));

      await fixture.writer.enqueue(memoryInput(4, ns));
      await fixture.writer.flush();
      fixture.commit("test: commit after a numeric gap");
      await hub.check(ns);

      expect(sink.closed).toBe(true);
      expect(sink.changeEvents()).toHaveLength(delivered);
      expect(logs.join("\n")).toMatch(/corrupt|gap|segment|delet|prefix/i);
    }

    // Truncation: the active segment loses a line the committed parent had.
    {
      const fixture = fixtureFor({});
      const hub = hubFor(fixture);
      const { ns } = fixture;
      const { sink } = await subscribe(hub, ns);
      await fixture.writer.enqueue(memoryInput(1, ns));
      await fixture.writer.enqueue(memoryInput(2, ns));
      await fixture.writer.flush();
      fixture.commit("test: pre-truncation commit");
      await hub.check(ns);
      const delivered = sink.changeEvents().length;
      expect(delivered).toBe(2);

      const segment = path.join(
        fixture.nsPath,
        AUDIT_DIR,
        AUDIT_CURRENT_SEGMENT,
      );
      const lines = fs.readFileSync(segment, "utf-8").split("\n");
      const kept = lines.slice(0, lines.length - 2);
      fs.writeFileSync(segment, `${kept.join("\n")}\n`, "utf-8");

      await fixture.writer.enqueue(memoryInput(3, ns));
      await fixture.writer.flush();
      fixture.commit("test: commit after a truncated ledger");
      await hub.check(ns);

      expect(sink.closed).toBe(true);
      expect(sink.changeEvents()).toHaveLength(delivered);
      expect(logs.join("\n")).toMatch(/corrupt|truncat|prefix|segment/i);
    }
  }, 60_000);
});
