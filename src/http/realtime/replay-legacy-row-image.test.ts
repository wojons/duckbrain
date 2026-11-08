import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { deriveCommitChanges } from "./replay";
import { ChangeRecordSchema } from "../../serialization/changeRecord";

const NS = "legacy-fixture";
const row = { id: "widget-7", label: "production-shaped" };
const legacyEntry = {
  ts: "2026-11-07T00:00:00.000Z",
  ns: NS,
  table: "widgets",
  op: "insert",
  principal: "fixture",
  outcome: "accepted",
  seq: 91,
  row,
};

let roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(entry: Record<string, unknown>): {
  repo: string;
  namespacePath: string;
  commit: string;
} {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-legacy-row-"));
  roots.push(repo);
  const namespacePath = path.join(repo, NS);
  fs.mkdirSync(path.join(namespacePath, "tables"), { recursive: true });
  fs.mkdirSync(path.join(namespacePath, "_audit"), { recursive: true });
  fs.writeFileSync(
    path.join(namespacePath, "schema.json"),
    JSON.stringify({
      schemaVersion: 1,
      tables: {
        widgets: {
          schemaVersion: 1,
          storage: { path: "tables/widgets.jsonl" },
          rowShape: "object",
          keyColumns: ["id"],
          columns: [
            { name: "id", type: "string", nullable: false },
            { name: "label", type: "string", nullable: false },
          ],
        },
      },
      views: {},
    }),
    "utf-8",
  );
  fs.writeFileSync(path.join(namespacePath, "tables/widgets.jsonl"), `${JSON.stringify(row)}\n`);
  fs.writeFileSync(path.join(namespacePath, "_audit/current.jsonl"), "");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: namespacePath, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.local");
  git("config", "user.name", "Test");
  git("add", "-A");
  git("commit", "-q", "-m", "seed data");
  fs.appendFileSync(path.join(namespacePath, "_audit/current.jsonl"), `${JSON.stringify(entry)}\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "append audit record");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: namespacePath, encoding: "utf-8" }).trim();
  return { repo: namespacePath, namespacePath, commit };
}

function derive(entry: Record<string, unknown>) {
  const seeded = fixture(entry);
  return deriveCommitChanges(seeded.repo, seeded.commit, {
    ns: NS,
    namespacePath: seeded.namespacePath,
  });
}

function expectCorrupt(entry: Record<string, unknown>, detail: RegExp): void {
  expect(() => derive(entry)).toThrowError(
    expect.objectContaining({ name: "ChangelogCorruptError", message: expect.stringMatching(detail) }),
  );
}

describe("legacy inline row-image replay", () => {
  it("derives the production legacy shape and declared key", () => {
    const changes = derive(legacyEntry);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.record.row).toEqual(row);
    expect(changes[0]!.record).toMatchObject({
      row,
      key: { id: row.id },
      table: "widgets",
      op: "insert",
      tombstone: false,
    });
    expect(changes[0]!.row).toEqual(row);
  });

  it("retains the modern content-hash, legacy row and ledger integrity guards", () => {
    const modern = {
      ...legacyEntry,
      op: "delete",
      contentHash: "a".repeat(64),
      targetPath: "tables/widgets.jsonl",
      key: { id: row.id },
      tombstone: true,
      schemaVersion: 1,
    };
    expectCorrupt(modern, /no data row|no line|hash/i);
    expectCorrupt({ ...legacyEntry, row: { label: row.label } }, /missing declared key.*id/i);
    expectCorrupt({ ...legacyEntry, op: "delete", row: null }, /malformed/i);
    // A legacy DELETE that names its target/key/tombstone but carries NO row
    // image is corrupt: a tombstone must still say which row it removed.
    // (An envelope-only row with no markers at all is a pre-payload row and is
    // skipped as a non-change-record — see the last test.)
    const { row: _omittedRow, ...deleteWithoutRow } = { ...legacyEntry, op: "delete" };
    expectCorrupt(
      { ...deleteWithoutRow, targetPath: "tables/widgets.jsonl", key: { id: row.id }, tombstone: true },
      /malformed/i,
    );
    expectCorrupt({ ...legacyEntry, ns: "wrong-namespace" }, /claims namespace/i);
    expectCorrupt({ ...modern, tombstone: false }, /tombstone.*inconsistent/i);
    expect(ChangeRecordSchema.safeParse({ ...modern, schemaVersion: undefined }).success).toBe(false);
  });

  it("derives the audited PRODUCTION shape: key/targetPath/tombstone/schemaVersion present, contentHash absent", () => {
    // Shape taken verbatim from the frozen pokemon-global copy at commit
    // 99862a2f, _audit/current.jsonl:1 — the record that made 3193 commits in
    // that namespace report `malformed-change-record`.
    const productionEntry = {
      ...legacyEntry,
      targetPath: "tables/widgets.jsonl",
      key: { id: row.id },
      tombstone: false,
      schemaVersion: 1,
    };
    const changes = derive(productionEntry);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.record).toMatchObject({
      row,
      key: { id: row.id },
      table: "widgets",
      op: "insert",
      targetPath: "tables/widgets.jsonl",
      tombstone: false,
      schemaVersion: 1,
    });
    expect(changes[0]!.row).toEqual(row);
  });

  it("refuses a legacy record whose declared key disagrees with its row image", () => {
    expectCorrupt(
      { ...legacyEntry, key: { id: "not-widget-7" } },
      /declares key .* but its row image yields/i,
    );
  });

  it("skips envelope-only historical rows that carry no replayable payload", () => {
    // Early scheduler-era audit rows: ts/ns/table/op/principal/outcome/seq and
    // nothing else. No row, no key, no hash — nothing to replay, and the marker
    // predicate never treated them as change records. Widening that predicate
    // reclassified 658 committed scheduler history points as malformed.
    const envelopeOnly = {
      ts: "2026-09-11T12:39:44.199Z",
      ns: NS,
      table: "widgets",
      op: "insert",
      principal: "fixture",
      outcome: "accepted",
      seq: 3,
    };
    expect(derive(envelopeOnly)).toEqual([]);
  });
});
