/**
 * DF-2026-18 fixture tests for `duckbrain distill-sessions`
 * (src/cli/session-distiller.ts).
 *
 * Builds a small fixture state.db (node:sqlite) with:
 *   - two real-looking sessions (cli + telegram) carrying a decision, a
 *     verified finding, an open item, and a secret-bearing decision line
 *   - one cron session (must be skipped as a system session)
 *   - one out-of-window session (ended 48h before the fixed clock)
 *   - one corrupt session (a user message whose content is a BLOB)
 *
 * Asserts: record shape (key pattern, domain, attributes), skip rules,
 * redaction, idempotent rerun (zero new records), dry-run writes nothing,
 * and the corrupt session is refused loudly with zero partial writes.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import {
  classifyStatement,
  collectExistingSessionKeys,
  distillSessions,
  extractRecordsFromMessages,
  redactSecrets,
  type DistillerReport,
} from "./session-distiller";
import { resetSerializerStateForTests } from "../serialization/namespaceWriter";
import { drainAsyncCommits } from "../git/autocommit";

const FIXED_NOW_MS = Date.UTC(2026, 9, 29, 12, 0, 0); // 2026-10-29T12:00:00Z
const HOUR_S = 3600;
const NAMESPACE = "sessions";

interface FixtureIds {
  cli: string;
  telegram: string;
  cron: string;
  old: string;
  corrupt: string;
}

let tmpDir: string;
let stateDbPath: string;
let oldNsPath: string | undefined;
let oldCfgPath: string | undefined;
let ids: FixtureIds;

function buildFixtureStateDb(dbPath: string): FixtureIds {
  const nowS = FIXED_NOW_MS / 1000;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        title TEXT,
        started_at REAL NOT NULL,
        ended_at REAL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content BLOB,
        timestamp REAL NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
    `);

    const addSession = db.prepare(
      "INSERT INTO sessions (id, source, title, started_at, ended_at) VALUES (?, ?, ?, ?, ?)",
    );
    const addMessage = db.prepare(
      "INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, ?, ?, ?, 1)",
    );

    const fixture: FixtureIds = {
      cli: "20261029_090000_aaaa01",
      telegram: "20261029_080000_bbbb02",
      cron: "20261029_070000_cccc03",
      old: "20261027_090000_dddd04",
      corrupt: "20261029_100000_eeee05",
    };

    // Real-looking CLI session: decision + verified finding + open item +
    // a decision line carrying a secret (redaction target).
    addSession.run(
      fixture.cli,
      "cli",
      "Pick a store",
      nowS - 2 * HOUR_S,
      nowS - HOUR_S,
    );
    addMessage.run(
      fixture.cli,
      "user",
      "We looked at three options for the store layer and compared them.",
      nowS - 2 * HOUR_S + 10,
    );
    addMessage.run(
      fixture.cli,
      "assistant",
      "We decided to go with Postgres for the store because it fits the existing tooling.",
      nowS - 2 * HOUR_S + 20,
    );
    addMessage.run(
      fixture.cli,
      "assistant",
      "Verified: the full test suite passes locally and in CI, all green across the board.",
      nowS - 2 * HOUR_S + 30,
    );
    addMessage.run(
      fixture.cli,
      "user",
      "TODO: write the migration guide before the Friday release window.",
      nowS - 2 * HOUR_S + 40,
    );
    addMessage.run(
      fixture.cli,
      "assistant",
      "We decided to keep the sandbox credential api_key=sk-abcdef1234567890 until provisioning confirms.",
      nowS - 2 * HOUR_S + 50,
    );
    // Noise lines that must NOT be extracted (too short / no signal).
    addMessage.run(fixture.cli, "user", "ok", nowS - 2 * HOUR_S + 60);
    addMessage.run(
      fixture.cli,
      "assistant",
      "Sure, I can take a look at that file for you now.",
      nowS - 2 * HOUR_S + 70,
    );

    // Telegram session: a verified finding.
    addSession.run(
      fixture.telegram,
      "telegram",
      "Deploy check",
      nowS - 3 * HOUR_S,
      nowS - 2 * HOUR_S,
    );
    addMessage.run(
      fixture.telegram,
      "user",
      "Confirmed the deploy is live: the health endpoint returns 200 with the new build.",
      nowS - 3 * HOUR_S + 10,
    );

    // Cron session: decision-looking content that must never be distilled.
    addSession.run(
      fixture.cron,
      "cron",
      "nightly sync",
      nowS - 90 * 60,
      nowS - 80 * 60,
    );
    addMessage.run(
      fixture.cron,
      "assistant",
      "We decided to sync every namespace nightly at 03:00 UTC from now on.",
      nowS - 89 * 60,
    );

    // Out-of-window session (ended 48h before the fixed clock).
    addSession.run(
      fixture.old,
      "cli",
      "old chat",
      nowS - 49 * HOUR_S,
      nowS - 48 * HOUR_S,
    );
    addMessage.run(
      fixture.old,
      "user",
      "We decided on the old plan two days ago and it should not resurface.",
      nowS - 49 * HOUR_S + 10,
    );

    // Corrupt session: a user message whose content is a non-text BLOB.
    addSession.run(
      fixture.corrupt,
      "cli",
      "broken transcript",
      nowS - 50 * 60,
      nowS - 40 * 60,
    );
    addMessage.run(
      fixture.corrupt,
      "user",
      new Uint8Array([0xff, 0xfe, 0x00, 0x41]),
      nowS - 49 * 60,
    );

    return fixture;
  } finally {
    db.close();
  }
}

/** Read every stored /session/… row from the temp namespaces root. */
function readStoredSessionRows(root: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const domainRoot = path.join(root, NAMESPACE, "raw_note");
  if (!fs.existsSync(domainRoot)) return rows;
  const stack = [domainRoot];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        for (const line of fs.readFileSync(full, "utf8").split("\n")) {
          if (!line.trim()) continue;
          const row = JSON.parse(line) as Record<string, unknown>;
          if (typeof row.key === "string" && row.key.startsWith("/session/")) {
            rows.push(row);
          }
        }
      }
    }
  }
  return rows;
}

function runDistiller(dryRun: boolean): Promise<DistillerReport> {
  return distillSessions({
    stateDbPath,
    windowHours: 24,
    namespace: NAMESPACE,
    dryRun,
    now: FIXED_NOW_MS,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-df202618-"));
  stateDbPath = path.join(tmpDir, "state.db");
  ids = buildFixtureStateDb(stateDbPath);
  oldNsPath = process.env.DUCKBRAIN_NAMESPACES_PATH;
  oldCfgPath = process.env.DUCKBRAIN_CONFIG_PATH;
  process.env.DUCKBRAIN_NAMESPACES_PATH = tmpDir;
  process.env.DUCKBRAIN_CONFIG_PATH = path.join(
    tmpDir,
    "duckbrain.config.json",
  );
  resetSerializerStateForTests();
});

afterEach(async () => {
  resetSerializerStateForTests();
  await drainAsyncCommits();
  if (oldNsPath === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  else process.env.DUCKBRAIN_NAMESPACES_PATH = oldNsPath;
  if (oldCfgPath === undefined) delete process.env.DUCKBRAIN_CONFIG_PATH;
  else process.env.DUCKBRAIN_CONFIG_PATH = oldCfgPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("DF-2026-18: session distiller fixture suite", () => {
  it("extracts decisions, findings and open items with the record shape", async () => {
    const report = await runDistiller(false);
    await drainAsyncCommits();

    const rows = readStoredSessionRows(tmpDir);
    expect(rows.length).toBeGreaterThan(0);
    expect(report.recordsWritten).toBe(rows.length);

    const keyRe =
      /^\/session\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]+\/[0-9a-f]{16}$/;
    const validSessionIds = new Set(Object.values(ids));
    const recordTypes = new Set<string>();
    for (const row of rows) {
      expect(String(row.key)).toMatch(keyRe);
      expect(row.domain).toBe("raw_note");
      expect(typeof row.embedding_text).toBe("string");
      expect(String(row.embedding_text).length).toBeLessThanOrEqual(240);
      const attrs = row.attributes as Record<string, unknown>;
      expect(typeof attrs.message_hash).toBe("string");
      expect(String(attrs.message_hash)).toMatch(/^[0-9a-f]{64}$/);
      // Every written record resolves to a session id that exists in state.db.
      expect(validSessionIds.has(String(attrs.session_id))).toBe(true);
      recordTypes.add(String(attrs.record_type));
    }
    expect(recordTypes.has("decision")).toBe(true);
    expect(recordTypes.has("finding")).toBe(true);
    expect(recordTypes.has("open_item")).toBe(true);
  });

  it("skips cron/system sessions and out-of-window sessions", async () => {
    const report = await runDistiller(false);
    await drainAsyncCommits();

    expect(report.sessionsSkippedSystem).toBe(1);
    const rows = readStoredSessionRows(tmpDir);
    const keys = rows.map((r) => String(r.key));
    expect(keys.some((k) => k.includes(ids.cron))).toBe(false);
    expect(keys.some((k) => k.includes(ids.old))).toBe(false);
    expect(keys.some((k) => k.includes(ids.cli))).toBe(true);
    expect(keys.some((k) => k.includes(ids.telegram))).toBe(true);
  });

  it("redacts anything that looks like a token/key/password", async () => {
    await runDistiller(false);
    await drainAsyncCommits();

    const rows = readStoredSessionRows(tmpDir);
    const statements = rows.map((r) => String(r.embedding_text)).join("\n");
    expect(statements).not.toContain("sk-abcdef1234567890");
    expect(statements).toContain("[REDACTED]");
    // The redacted decision still survives as a decision record.
    const redactedDecision = rows.find((r) =>
      String(r.embedding_text).includes("sandbox credential"),
    );
    expect(redactedDecision).toBeDefined();
    expect(
      String(
        (redactedDecision?.attributes as Record<string, unknown>).record_type,
      ),
    ).toBe("decision");
  });

  it("is idempotent: a rerun over unchanged input writes zero new records", async () => {
    const first = await runDistiller(false);
    await drainAsyncCommits();
    expect(first.recordsWritten).toBeGreaterThan(0);

    const second = await runDistiller(false);
    await drainAsyncCommits();
    expect(second.recordsWritten).toBe(0);
    expect(second.recordsSkippedExisting).toBe(first.recordsWritten);
    expect(second.recordsPlanned.length).toBe(0);
  });

  it("refuses the corrupt session loudly and writes no partial garbage", async () => {
    const report = await runDistiller(false);
    await drainAsyncCommits();

    const refused = report.sessionsSkippedCorrupt.map((s) => s.sessionId);
    expect(refused).toContain(ids.corrupt);
    const rows = readStoredSessionRows(tmpDir);
    expect(rows.some((r) => String(r.key).includes(ids.corrupt))).toBe(false);
  });

  it("--dry-run plans records but writes nothing", async () => {
    const report = await runDistiller(true);

    expect(report.recordsPlanned.length).toBeGreaterThan(0);
    expect(report.recordsWritten).toBe(0);
    // Nothing landed on disk — no namespace directory at all.
    expect(fs.existsSync(path.join(tmpDir, NAMESPACE))).toBe(false);
    expect(collectExistingSessionKeys(tmpDir, NAMESPACE).size).toBe(0);
  });

  it("extraction is a pure function: identical input yields identical keys", () => {
    const messages = [
      {
        id: 1,
        role: "assistant",
        content:
          "We decided to go with Postgres for the store because it fits the tooling.",
        timestamp: 1000,
      },
    ];
    const a = extractRecordsFromMessages({
      sessionId: "s1",
      sessionDate: "2026-10-29",
      sessionSource: "cli",
      messages,
    });
    const b = extractRecordsFromMessages({
      sessionId: "s1",
      sessionDate: "2026-10-29",
      sessionSource: "cli",
      messages,
    });
    expect(a).toEqual(b);
    expect(a[0].key).toMatch(/\/session\/2026-10-29\/s1\/[0-9a-f]{16}$/);
  });

  it("redactSecrets unit cases", () => {
    expect(redactSecrets("token=abc123xyz")).toBe("token=[REDACTED]");
    expect(redactSecrets("use Bearer abc.def-123 now")).toBe(
      "use Bearer [REDACTED] now",
    );
    expect(redactSecrets("key sk-proj_xyz98765 here")).toBe(
      "key [REDACTED] here",
    );
    expect(redactSecrets("aws AKIAIOSFODNN7EXAMPLE ok")).toBe(
      "aws [REDACTED] ok",
    );
    expect(redactSecrets("nothing secret in this sentence")).toBe(
      "nothing secret in this sentence",
    );
  });

  it("classifyStatement unit cases", () => {
    expect(classifyStatement("We decided to ship on Friday.")).toBe("decision");
    expect(classifyStatement("Verified: tests pass in CI.")).toBe("finding");
    expect(classifyStatement("TODO: write the docs.")).toBe("open_item");
    expect(classifyStatement("The weather is nice today.")).toBe(null);
  });
});
