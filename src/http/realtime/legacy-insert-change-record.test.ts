/**
 * HARDEN-DUCKBRAIN-001 (gate audit 2026-11-06) — the legacy `.table.json`
 * declaration path must produce DB-SUPA-5 change records for INSERT too.
 *
 * Reproduced defect: `insertTableRows()` served `.table.json` tables through a
 * plain file append with no change record, while PATCH and DELETE wrote one.
 * Two consequences, both covered here:
 *   1. the change feed silently never replayed an insert for those tables;
 *   2. an insert deleted inside ONE commit window left a tombstone naming a
 *      row image that exists at neither the child nor the parent ref, and
 *      REPLAY-BIRTH-DEATH-001's guard recognises that only as a MATCHED PAIR
 *      (same table + key + content hash) — with no birth record the pair can
 *      never form, so `deriveCommitChanges` threw `CHANGELOG_CORRUPT` and the
 *      namespace feed was dead for every subscriber, permanently.
 *
 * Everything here is real: a real namespace git repository, the real HTTP
 * table routes, the real NamespaceWriter audit append, a real commit and the
 * real replay derivation.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createHttpServer } from "../../cli/http";
import { waitForNamespaceCommit } from "../../git/autocommit";
import { contentHashFor } from "../../serialization/changeRecord";
import { removeTempDirSafely } from "../../testing/race-safe-daemon";
import { AUDIT_DIR } from "../../serialization/auditLedger";
import { invalidateRealtimeTableCache } from "../routes/realtime";
import {
  createRecordingSink,
  startApp,
  type RecordingSink,
  type RunningApp,
} from "./fixtures";
import { RealtimeHub, type Subscription } from "./hub";

const NS = "legacy-insert-feed";

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
  // LEGACY declaration: `tables/<table>.table.json`, the shape that takes the
  // direct-append branch of insertTableRows (no schema.json, no serializer).
  fs.writeFileSync(
    path.join(nsPath, "tables", "widgets.table.json"),
    JSON.stringify({
      name: "widgets",
      format: "jsonl-objects",
      glob: "tables/widgets.jsonl",
      primary: "id",
      schemaVersion: 1,
      columns: [
        { name: "id", type: "varchar" },
        { name: "name", type: "varchar" },
        { name: "qty", type: "double" },
      ],
    }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(nsPath, "tables", "widgets.jsonl"),
    [JSON.stringify({ id: "1", name: "alpha", qty: 1.5 })].join("\n") + "\n",
    "utf-8",
  );
  invalidateRealtimeTableCache();
  gitIn(["init", "-q"]);
  gitIn(["config", "user.email", "test@example.local"]);
  gitIn(["config", "user.name", "Test"]);
  gitIn(["add", "-A"]);
  gitIn(["commit", "-q", "-m", "test: seed legacy declared table"]);
}

async function call(
  method: "POST" | "DELETE",
  query: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(
    server.url(`/api/ns/${NS}/tables/widgets${query}`),
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

function auditRows(): Array<Record<string, unknown>> {
  const dir = path.join(nsPath, AUDIT_DIR);
  if (!fs.existsSync(dir)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
    for (const line of fs
      .readFileSync(path.join(dir, name), "utf-8")
      .split("\n")) {
      if (line.trim() === "") continue;
      rows.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return rows;
}

function rowsFor(id: string): Array<Record<string, unknown>> {
  return auditRows().filter(
    (row) => (row.key as { id?: string } | undefined)?.id === id,
  );
}

/** The exact committed line for `id`, or null when the row is gone. */
function committedLine(id: string): string | null {
  const file = path.join(nsPath, "tables", "widgets.jsonl");
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    if ((JSON.parse(line) as { id?: string }).id === id) return line;
  }
  return null;
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-legacy-insert-feed-"));
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

describe("legacy `.table.json` inserts are DB-SUPA-5 change records", () => {
  it("an accepted insert appends a change record and replays as a change event", async () => {
    const created = await call("POST", "", { id: "2", name: "beta", qty: 2.5 });
    expect({ status: created.status, body: created.body }).toEqual({
      status: 201,
      body: { inserted: 1 },
    });

    // The birth record exists, names the appended bytes and is not a tombstone.
    const records = rowsFor("2");
    expect(records).toHaveLength(1);
    const line = committedLine("2");
    expect(line).not.toBeNull();
    expect(records[0]).toMatchObject({
      table: "widgets",
      op: "insert",
      outcome: "accepted",
      tombstone: false,
      targetPath: "tables/widgets.jsonl",
      contentHash: contentHashFor(line!),
    });

    await waitForNamespaceCommit(nsPath);
    await hub.check(NS);

    expect(logs.join("\n")).not.toMatch(/corrupt/i);
    expect(sink.closed).toBe(false);
    const events = sink.changeEvents();
    expect(
      events.filter((event) => (event.key as { id?: string })?.id === "2"),
    ).toHaveLength(1);
    expect(events[events.length - 1]).toMatchObject({
      op: "insert",
      row: { id: "2", name: "beta" },
    });
  }, 60_000);

  it("an insert and its delete inside one commit window do not poison the feed", async () => {
    // The reproduced defect: POST then DELETE inside the commit debounce. With
    // no insert record the tombstone named a row image neither ref carries and
    // every later subscription answered CHANGELOG_CORRUPT forever.
    const before = sink.changeEvents().length;
    const created = await call("POST", "", { id: "3", name: "ephemeral", qty: 1 });
    expect(created.status).toBe(201);
    const deleted = await call("DELETE", "?pk=eq.3");
    expect({ status: deleted.status, body: deleted.body }).toEqual({
      status: 200,
      body: { deleted: 1 },
    });

    // The pair REPLAY-BIRTH-DEATH-001 recognises: one insert + one tombstone
    // for the SAME row image in the same commit diff.
    const pair = rowsFor("3");
    expect(pair).toHaveLength(2);
    expect(pair.map((row) => row.op).sort()).toEqual(["delete", "insert"]);
    expect(new Set(pair.map((row) => row.contentHash)).size).toBe(1);
    expect(pair.filter((row) => row.tombstone === true)).toHaveLength(1);

    await waitForNamespaceCommit(nsPath);
    await hub.check(NS);

    expect(logs.join("\n")).not.toMatch(/corrupt/i);
    expect(sink.closed).toBe(false);
    // A row that never existed at a commit boundary emits nothing.
    expect(
      sink
        .changeEvents()
        .slice(before)
        .filter((event) => (event.key as { id?: string })?.id === "3"),
    ).toHaveLength(0);
  }, 60_000);
});
