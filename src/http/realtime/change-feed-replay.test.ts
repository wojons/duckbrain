/**
 * DB-SUPA-2 AC-2 (rework) — accepted REST table mutations are REAL change
 * records, so the DB-SUPA-5 change feed replays them.
 *
 * The gap this suite closes: `recordTableMutationAudit` used to write
 * marker-less accepted audit rows. `isChangeRecordCandidate` therefore
 * returned false and replay skipped every accepted PATCH/DELETE — an update
 * produced no change event and a delete produced no tombstone. The route now
 * emits a full change record (`contentHash` / `key` / `targetPath` /
 * `tombstone` / `schemaVersion`) for both operations.
 *
 * Everything here is real: a real namespace directory with a real git
 * repository, the real HTTP table routes, the real `NamespaceWriter` audit
 * append, a real namespace commit, and the real replay derivation through
 * `RealtimeHub`. Nothing asserts on a mocked change record.
 *
 * Physical shapes differ per operation, and the assertions pin both:
 *   - update — the record's hash names the POST-mutation line, resolved at the
 *     child commit;
 *   - delete — the row is removed from the data file, so the record's hash
 *     names the row as it existed at the parent commit (tombstone semantics:
 *     a row image plus declared key, never `row: null`).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createHttpServer } from "../../cli/http";
import { waitForNamespaceCommit } from "../../git/autocommit";
import {
  contentHashFor,
  isChangeRecordCandidate,
} from "../../serialization/changeRecord";
import { removeTempDirSafely } from "../../testing/race-safe-daemon";
import { AUDIT_DIR } from "../../serialization/auditLedger";
import {
  createRecordingSink,
  startApp,
  type RecordingSink,
  type RunningApp,
} from "./fixtures";
import { RealtimeHub, type Subscription } from "./hub";

const NS = "supa2-feed";

let root = "";
let nsPath = "";
let server: RunningApp;
let hub: RealtimeHub;
let sub: Subscription;
let sink: RecordingSink;
let logs: string[] = [];

function gitIn(args: string[]): string {
  return execFileSync("git", args, {
    cwd: nsPath,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function seedNamespace(): void {
  nsPath = path.join(root, NS);
  fs.mkdirSync(path.join(nsPath, "tables"), { recursive: true });
  fs.writeFileSync(
    path.join(nsPath, "schema.json"),
    JSON.stringify({
      schemaVersion: 1,
      tables: {
        widgets: {
          schemaVersion: 1,
          storage: { path: "tables/widgets.jsonl" },
          rowShape: "object",
          keyColumns: ["id"],
          columns: [
            { name: "id", type: "int64", nullable: false },
            { name: "name", type: "string", nullable: true },
            { name: "qty", type: "float64", nullable: true },
          ],
        },
      },
      views: {},
    }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(nsPath, "tables", "widgets.jsonl"),
    [
      JSON.stringify({ id: "1", name: "alpha", qty: 1.5 }),
      JSON.stringify({ id: "2", name: "beta", qty: 3 }),
    ].join("\n") + "\n",
    "utf-8",
  );
  gitIn(["init", "-q"]);
  gitIn(["config", "user.email", "test@example.local"]);
  gitIn(["config", "user.name", "Test"]);
  gitIn(["add", "-A"]);
  gitIn(["commit", "-q", "-m", "test: seed declared table"]);
}

async function mutate(
  method: "PATCH" | "DELETE",
  query: string,
  body?: object,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(
    server.url(`/api/ns/${NS}/tables/widgets?${query}`),
    {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep the raw text — a non-JSON body is itself the finding
  }
  return { status: response.status, body: parsed };
}

/** Every accepted audit line currently on disk, in ledger file order. */
function auditRows(): Array<Record<string, unknown>> {
  const dir = path.join(nsPath, AUDIT_DIR);
  const rows: Array<Record<string, unknown>> = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
    for (const line of fs.readFileSync(path.join(dir, name), "utf-8").split("\n")) {
      if (line.trim() === "") continue;
      rows.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return rows;
}

function changeEvents(): Array<Record<string, unknown>> {
  return sink.changeEvents();
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-supa2-feed-"));
  process.env.DUCKBRAIN_NAMESPACES_PATH = root;
  process.env.DUCKBRAIN_CONFIG_PATH = path.join(root, "duckbrain.config.json");
  seedNamespace();
  server = await startApp(createHttpServer({ authType: "none" }));
  hub = new RealtimeHub({
    namespacesPath: root,
    pollIntervalMs: 60 * 60 * 1000,
    heartbeatMs: 60 * 60 * 1000,
    log: (message) => logs.push(message),
  });
  sink = createRecordingSink();
  sub = await hub.subscribe(
    {
      ns: NS,
      principal: undefined,
      tables: ["widgets"],
      ops: ["insert", "update", "delete"],
      cursor: null,
      sink,
    },
    () => undefined,
  );
});

afterAll(async () => {
  sub?.close();
  hub?.closeAll();
  await server?.close();
  await removeTempDirSafely(root);
  logs = [];
});

describe("DB-SUPA-2 AC-2: table mutations are replayed change records", () => {
  it("accepted PATCH replays as an update change record for the new row image", async () => {
    const patched = await mutate("PATCH", "pk=eq.1", { qty: 9 });
    expect({ status: patched.status, body: patched.body }).toEqual({
      status: 200,
      body: { updated: 1 },
    });

    // The audit row really is a change record — the marker set is present and
    // `isChangeRecordCandidate` (replay's own filter) accepts it.
    const updateRow = auditRows().find(
      (row) => row.op === "update" && row.table === "widgets",
    );
    expect(updateRow).toBeDefined();
    expect(typeof updateRow!.contentHash).toBe("string");
    expect(isChangeRecordCandidate(updateRow!)).toBe(true);
    expect(updateRow!.targetPath).toBe("tables/widgets.jsonl");
    expect(updateRow!.key).toEqual({ id: "1" });
    expect(updateRow!.tombstone).toBe(false);
    expect(updateRow!.schemaVersion).toBe(1);

    // The hash names a line that really is in the data file at the child
    // commit — that is the whole point of storing a digest instead of a row.
    const dataLine = fs
      .readFileSync(path.join(nsPath, "tables", "widgets.jsonl"), "utf-8")
      .split("\n")
      .find((line) => line.includes('"id":"1"'))!;
    expect(updateRow!.contentHash).toBe(contentHashFor(dataLine));

    await waitForNamespaceCommit(nsPath);
    await hub.check(NS);

    const events = changeEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.op).toBe("update");
    expect(events[0]!.table).toBe("widgets");
    expect(events[0]!.tombstone).toBe(false);
    expect(events[0]!.key).toEqual({ id: "1" });
    expect(events[0]!.row).toMatchObject({ id: "1", name: "alpha", qty: 9 });
    expect(events[0]!.schemaVersion).toBe(1);
  }, 60_000);

  it("accepted DELETE replays as a tombstone entry carrying the last row image", async () => {
    // Row 2 was committed by the seed, and the PATCH commit above is the
    // parent of the commit this delete lands in, so the tombstone's hash names
    // a row image that was genuinely committed before the removal.
    const before = changeEvents().length;
    const deleted = await mutate("DELETE", "pk=eq.2");
    expect({ status: deleted.status, body: deleted.body }).toEqual({
      status: 200,
      body: { deleted: 1 },
    });

    const deleteRow = auditRows().find(
      (row) => row.op === "delete" && row.table === "widgets",
    );
    expect(deleteRow).toBeDefined();
    expect(isChangeRecordCandidate(deleteRow!)).toBe(true);
    expect(deleteRow!.tombstone).toBe(true);
    expect(deleteRow!.key).toEqual({ id: "2" });
    expect(deleteRow!.targetPath).toBe("tables/widgets.jsonl");

    await waitForNamespaceCommit(nsPath);
    await hub.check(NS);

    const events = changeEvents();
    expect(events).toHaveLength(before + 1);
    const tombstoneEvent = events[events.length - 1]!;
    expect(tombstoneEvent.op).toBe("delete");
    expect(tombstoneEvent.tombstone).toBe(true);
    expect(tombstoneEvent.key).toEqual({ id: "2" });
    // Tombstone semantics: a row image, never `null`.
    expect(tombstoneEvent.row).toMatchObject({ id: "2", name: "beta" });
    expect(tombstoneEvent.row).not.toBeNull();

    // And the row really is gone from the committed data file.
    const onDisk = fs.readFileSync(
      path.join(nsPath, "tables", "widgets.jsonl"),
      "utf-8",
    );
    expect(onDisk).not.toContain('"id":"2"');
    expect(onDisk).toContain('"id":"1"');
  }, 60_000);

  it("two rewrites of one row inside a single commit window do not poison the feed", async () => {
    // Both PATCHes land before any commit fires, so ONE commit carries two
    // update records while the data file keeps only the final line. That is
    // the supersession case: neither record may turn the feed into
    // CHANGELOG_CORRUPT (which would close the subscription permanently).
    const before = changeEvents().length;
    expect((await mutate("PATCH", "pk=eq.1", { qty: 11 })).status).toBe(200);
    expect((await mutate("PATCH", "pk=eq.1", { qty: 12 })).status).toBe(200);

    await waitForNamespaceCommit(nsPath);
    await hub.check(NS);

    expect(logs.join("\n")).not.toMatch(/corrupt/i);
    expect(sink.closed).toBe(false);

    const events = changeEvents().slice(before);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.op === "update")).toBe(true);
    // The final record for the key carries the final committed row image.
    expect(events[events.length - 1]!.row).toMatchObject({ id: "1", qty: 12 });

    const onDisk = fs
      .readFileSync(path.join(nsPath, "tables", "widgets.jsonl"), "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(onDisk).toHaveLength(1);
    expect(JSON.parse(onDisk[0]!)).toMatchObject({ id: "1", qty: 12 });
  }, 60_000);
});
