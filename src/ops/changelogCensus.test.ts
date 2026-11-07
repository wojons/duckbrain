/**
 * HARDEN-DUCKBRAIN-007 — the read-only `CHANGELOG_CORRUPT` census.
 *
 * Proves, against two REAL namespace git repositories:
 *   - a namespace whose committed ledger derives cleanly reports clean;
 *   - a namespace carrying a pre-006 orphan tombstone (a delete record naming
 *     a row image that exists at neither the parent nor the child ref) reports
 *     corrupt, with the ledger path, the physical line and the commit;
 *   - the census is idempotent (two runs, byte-identical report) and mutates
 *     nothing (same HEAD, same commit count, clean status, unchanged bytes);
 *   - the failure-class classifier keeps `unresolvable-row-image` (the orphan
 *     class this row is about) distinct from the legacy `malformed-change-
 *     record` class, because the repair decision depends on the split.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { contentHashFor } from "../serialization/changeRecord.js";
import { AUDIT_DIR } from "../serialization/auditLedger.js";
import { removeTempDirSafely } from "../testing/race-safe-daemon.js";
import {
  buildCensusReport,
  censusNamespace,
  classifyCorruptMessage,
  listCandidateNamespaces,
  mergeNamespaceResults,
  runCensus,
} from "./changelogCensus.js";

const CLEAN_NS = "clean-ns";
const ORPHAN_NS = "orphan-ns";
const MULTI_NS = "multi-ns";
const DECLARED = {
  name: "widgets",
  format: "jsonl-objects",
  glob: "tables/widgets.jsonl",
  primary: "id",
  schemaVersion: 1,
  columns: [
    { name: "id", type: "varchar" },
    { name: "name", type: "varchar" },
  ],
};

let root = "";

function gitIn(repoDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitAll(repoDir: string, message: string): string {
  gitIn(repoDir, ["add", "-A"]);
  gitIn(repoDir, [
    "-c",
    "user.name=DuckBrain Test",
    "-c",
    "user.email=duckbrain-test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    message,
  ]);
  return gitIn(repoDir, ["rev-parse", "HEAD"]);
}

function seedNamespace(
  name: string,
  rows: string[],
  auditRecords: Array<Record<string, unknown>>,
): string {
  const nsPath = path.join(root, name);
  fs.mkdirSync(path.join(nsPath, "tables"), { recursive: true });
  fs.mkdirSync(path.join(nsPath, AUDIT_DIR), { recursive: true });
  fs.writeFileSync(
    path.join(nsPath, "tables", "widgets.table.json"),
    `${JSON.stringify(DECLARED, null, 2)}\n`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(nsPath, "tables", "widgets.jsonl"),
    rows.map((row) => `${row}\n`).join(""),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(nsPath, AUDIT_DIR, "current.jsonl"),
    auditRecords.map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf-8",
  );
  gitIn(nsPath, ["init", "-q", "-b", "master"]);
  return commitAll(nsPath, `${name}: seed`);
}

function changeRecord(
  ns: string,
  line: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ts: "2026-11-07T00:00:00.000Z",
    ns,
    table: "widgets",
    op: "insert",
    principal: "census-test",
    outcome: "accepted",
    seq: 1,
    targetPath: "tables/widgets.jsonl",
    contentHash: contentHashFor(line),
    key: { id: "1" },
    tombstone: false,
    schemaVersion: 1,
    ...overrides,
  };
}

let cleanHead = "";
let orphanHead = "";
let middleCorruptCommit = "";

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-changelog-census-"));
  const cleanLine = JSON.stringify({ id: "1", name: "alpha" });
  cleanHead = seedNamespace(CLEAN_NS, [cleanLine], [
    changeRecord(CLEAN_NS, cleanLine),
  ]);

  // The orphan: a tombstone whose row image was never committed at either ref
  // (the pre-HARDEN-DUCKBRAIN-006 legacy `.table.json` shape).
  const neverCommitted = JSON.stringify({ id: "9", name: "ghost" });
  orphanHead = seedNamespace(ORPHAN_NS, [], [
    changeRecord(ORPHAN_NS, neverCommitted, {
      op: "delete",
      tombstone: true,
      seq: 2,
      key: { id: "9" },
    }),
  ]);

  // Three commits with the failure in the MIDDLE: a corrupt commit does not
  // stop the walk, so a namespace reports its whole-history count rather than
  // only its first offender.
  const multiPath = path.join(root, MULTI_NS);
  const firstLine = JSON.stringify({ id: "1", name: "alpha" });
  seedNamespace(MULTI_NS, [firstLine], [changeRecord(MULTI_NS, firstLine)]);
  const ghostLine = JSON.stringify({ id: "7", name: "ghost" });
  fs.writeFileSync(
    path.join(multiPath, "tables", "widgets.jsonl"),
    `${firstLine}\n`,
    "utf-8",
  );
  fs.appendFileSync(
    path.join(multiPath, AUDIT_DIR, "current.jsonl"),
    `${JSON.stringify(
      changeRecord(MULTI_NS, ghostLine, {
        op: "update",
        seq: 2,
        key: { id: "7" },
      }),
    )}\n`,
    "utf-8",
  );
  middleCorruptCommit = commitAll(multiPath, `${MULTI_NS}: orphan update`);
  const thirdLine = JSON.stringify({ id: "2", name: "beta" });
  fs.writeFileSync(
    path.join(multiPath, "tables", "widgets.jsonl"),
    `${firstLine}\n${thirdLine}\n`,
    "utf-8",
  );
  fs.appendFileSync(
    path.join(multiPath, AUDIT_DIR, "current.jsonl"),
    `${JSON.stringify(changeRecord(MULTI_NS, thirdLine, { seq: 3, key: { id: "2" } }))}\n`,
    "utf-8",
  );
  commitAll(multiPath, `${MULTI_NS}: third commit`);
});

afterAll(() => {
  removeTempDirSafely(root);
});

describe("changelog corrupt census", () => {
  it("lists only git-backed namespaces that carry an audit ledger", () => {
    fs.mkdirSync(path.join(root, "not-a-repo"), { recursive: true });
    fs.mkdirSync(path.join(root, ".hidden"), { recursive: true });
    expect(listCandidateNamespaces(root)).toEqual([
      CLEAN_NS,
      MULTI_NS,
      ORPHAN_NS,
    ]);
  });

  it("reports a clean namespace as clean and derives its change records", () => {
    const result = censusNamespace(root, CLEAN_NS, 5);
    expect(result.status).toBe("clean");
    expect(result.head).toBe(cleanHead);
    expect(result.commits).toBe(1);
    expect(result.derivedChanges).toBe(1);
    expect(result.corruptCommits).toBe(0);
  });

  it("reports the orphan tombstone with path, line and commit", () => {
    const result = censusNamespace(root, ORPHAN_NS, 5);
    expect(result.status).toBe("corrupt");
    expect(result.corruptCommits).toBe(1);
    expect(result.classes).toEqual({ "unresolvable-row-image": 1 });
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]).toMatchObject({
      commit: orphanHead,
      path: `${AUDIT_DIR}/current.jsonl`,
      line: 1,
      class: "unresolvable-row-image",
    });
    expect(result.samples[0].committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("is idempotent and mutates nothing", () => {
    const before = {
      heads: [
        gitIn(path.join(root, CLEAN_NS), ["rev-parse", "HEAD"]),
        gitIn(path.join(root, ORPHAN_NS), ["rev-parse", "HEAD"]),
      ],
      counts: [
        gitIn(path.join(root, CLEAN_NS), ["rev-list", "--count", "HEAD"]),
        gitIn(path.join(root, ORPHAN_NS), ["rev-list", "--count", "HEAD"]),
      ],
      status: [
        gitIn(path.join(root, CLEAN_NS), ["status", "--porcelain"]),
        gitIn(path.join(root, ORPHAN_NS), ["status", "--porcelain"]),
      ],
      audit: fs.readFileSync(
        path.join(root, ORPHAN_NS, AUDIT_DIR, "current.jsonl"),
        "utf-8",
      ),
    };

    const first = buildCensusReport(
      root,
      2,
      runCensus(root, [CLEAN_NS, MULTI_NS, ORPHAN_NS], 5),
    );
    const second = buildCensusReport(
      root,
      2,
      runCensus(root, [ORPHAN_NS, MULTI_NS, CLEAN_NS], 5),
    );

    // Byte-identical: no timestamps, no durations, stable namespace order.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.namespacesCorrupt).toBe(2);
    expect(first.corruptCommits).toBe(2);
    expect(first.commitsScanned).toBe(5);
    expect(first.corrupt.map((hit) => hit.namespace)).toEqual([
      MULTI_NS,
      ORPHAN_NS,
    ]);

    expect(
      [
        gitIn(path.join(root, CLEAN_NS), ["rev-parse", "HEAD"]),
        gitIn(path.join(root, ORPHAN_NS), ["rev-parse", "HEAD"]),
      ],
    ).toEqual(before.heads);
    expect(
      [
        gitIn(path.join(root, CLEAN_NS), ["rev-list", "--count", "HEAD"]),
        gitIn(path.join(root, ORPHAN_NS), ["rev-list", "--count", "HEAD"]),
      ],
    ).toEqual(before.counts);
    expect(
      [
        gitIn(path.join(root, CLEAN_NS), ["status", "--porcelain"]),
        gitIn(path.join(root, ORPHAN_NS), ["status", "--porcelain"]),
      ],
    ).toEqual(before.status);
    expect(
      fs.readFileSync(
        path.join(root, ORPHAN_NS, AUDIT_DIR, "current.jsonl"),
        "utf-8",
      ),
    ).toBe(before.audit);
  });

  it("reports every corrupt commit, not only the first, across a history", () => {
    const result = censusNamespace(root, MULTI_NS, 5);
    expect(result.commits).toBe(3);
    expect(result.corruptCommits).toBe(1);
    expect(result.classes).toEqual({ "unresolvable-row-image": 1 });
    expect(result.samples[0].commit).toBe(middleCorruptCommit);
    // The clean commits on either side still derive their records.
    expect(result.derivedChanges).toBe(2);
  });

  it("merges commit-range slices into the whole-history report", () => {
    const whole = censusNamespace(root, MULTI_NS, 5);
    const slices = [0, 1, 2].map((offset) =>
      censusNamespace(root, MULTI_NS, 5, { offset, limit: 1 }),
    );
    expect(slices.map((slice) => slice.commits)).toEqual([1, 1, 1]);
    expect(mergeNamespaceResults(slices, 5)).toEqual(whole);
    // Out-of-order slices still surface the history's first offender.
    const merged = mergeNamespaceResults(
      [slices[0], slices[1], slices[2]],
      5,
    );
    expect(merged.samples[0].commit).toBe(middleCorruptCommit);
  });

  it("classifies the failure families the repair decision turns on", () => {
    expect(
      classifyCorruptMessage(
        "change record at '_audit/current.jsonl:6' has no data row with the recorded content hash in committed target 'tables/widgets.jsonl'",
      ),
    ).toBe("unresolvable-row-image");
    expect(
      classifyCorruptMessage(
        "accepted change record at '_audit/current.jsonl:91' is malformed: contentHash: Invalid input: expected string, received undefined",
      ),
    ).toBe("malformed-change-record");
    expect(
      classifyCorruptMessage(
        "committed audit segment 'current.jsonl' is not an append-only extension of its parent",
      ),
    ).toBe("audit-rewrite");
    expect(classifyCorruptMessage("something nobody predicted")).toBe("other");
  });
});
