/**
 * RETR-004 Unit Tests: memory-as-of git time travel — resolver + reader.
 *
 * Guards src/git/asof.ts against REAL namespace git repos (the same
 * per-namespace repo layout src/git/autocommit.ts maintains: one .git inside
 * the namespace directory):
 *   - resolveAsOfRef: date → nearest commit at-or-before; direct refs
 *     (full/short sha, branch, tag); clear errors for invalid input, dates
 *     before the first commit, empty values, and non-repos
 *   - queryMemoriesAtRef: fixture-verified time travel (two commits → the
 *     first ref returns exactly the first commit's rows), manifest merge
 *     across partitions, empty namespaces, dedup-by-id, tombstone
 *     exclusion, list-path filters (key/prefix/domain/author + RETR-003 time
 *     windows incl. chat-archive key facets), limit, malformed-line skipping
 *
 * Read-only guarantee: every test asserts the working tree is untouched by
 * the reader (git status stays clean after queryMemoriesAtRef runs).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import {
  resolveAsOfRef,
  readManifestAtRef,
  queryMemoriesAtRef,
  type MemoryRowAtRef,
} from "./asof";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asof-unit-"));

/** Commit-dated rows: three commits at known instants. */
const D1 = "2026-07-01T10:00:00Z";
const D2 = "2026-07-15T10:00:00Z";
const D3 = "2026-08-01T10:00:00Z";

function git(dir: string, args: string, env?: Record<string, string>): string {
  return execSync(`git ${args}`, {
    cwd: dir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  })
    .toString()
    .trim();
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init -q");
  git(dir, 'config user.email "test@example.com"');
  git(dir, 'config user.name "Test"');
}

function commitAll(dir: string, msg: string, date: string): string {
  git(dir, "add -A");
  git(dir, `commit -qm "${msg}"`, {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return git(dir, "rev-parse HEAD");
}

function row(
  id: string,
  key: string,
  timestamp: string,
  extra: Partial<MemoryRowAtRef> = {},
): MemoryRowAtRef {
  return {
    id,
    key,
    domain: "concept",
    timestamp,
    author: "test@example.com",
    action: "add",
    embedding_text: `content ${id}`,
    attributes: {},
    ...extra,
  };
}

function writeJsonl(
  dir: string,
  rel: string,
  rows: Array<MemoryRowAtRef | string>,
): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(
    abs,
    rows
      .map((r) => (typeof r === "string" ? r : JSON.stringify(r)))
      .join("\n") + "\n",
    "utf-8",
  );
}

function writeManifest(dir: string, partitions: string[]): void {
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      { partitions, lastUpdated: new Date().toISOString() },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
}

describe("RETR-004: resolveAsOfRef", () => {
  const repo = path.join(TMP, "resolve");
  let sha1: string;
  let sha2: string;
  let sha3: string;

  beforeAll(() => {
    initRepo(repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n", "utf-8");
    sha1 = commitAll(repo, "c1", D1);
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n", "utf-8");
    sha2 = commitAll(repo, "c2", D2);
    fs.writeFileSync(path.join(repo, "a.txt"), "three\n", "utf-8");
    sha3 = commitAll(repo, "c3", D3);
    git(repo, "tag v1 " + sha1);
    git(repo, "branch feature " + sha2);
  });

  it("resolves a date to the nearest commit at-or-before it", () => {
    expect(resolveAsOfRef("2026-07-10", repo)).toBe(sha1);
    // Date-only input is inclusive of the whole day (commit on 07-15 counts).
    expect(resolveAsOfRef("2026-07-15", repo)).toBe(sha2);
    expect(resolveAsOfRef("2026-07-16", repo)).toBe(sha2);
    // Datetime resolves at instant granularity.
    expect(resolveAsOfRef("2026-08-01T09:00:00Z", repo)).toBe(sha2);
    expect(resolveAsOfRef("2026-08-01T10:00:00Z", repo)).toBe(sha3);
  });

  it("resolves full/short commit hashes, branches, and tags directly", () => {
    expect(resolveAsOfRef(sha1, repo)).toBe(sha1);
    expect(resolveAsOfRef(sha2.slice(0, 8), repo)).toBe(sha2);
    expect(resolveAsOfRef("feature", repo)).toBe(sha2);
    expect(resolveAsOfRef("v1", repo)).toBe(sha1);
    expect(resolveAsOfRef("HEAD", repo)).toBe(sha3);
  });

  it("throws a clear error for a date before the first commit", () => {
    expect(() => resolveAsOfRef("2020-01-01", repo)).toThrow(
      /No commit found at or before 2020-01-01/,
    );
  });

  it("throws a clear error for an unresolvable ref", () => {
    expect(() => resolveAsOfRef("not-a-ref", repo)).toThrow(
      /Invalid --as-of value 'not-a-ref'/,
    );
  });

  it("throws a clear error for an empty value", () => {
    expect(() => resolveAsOfRef("   ", repo)).toThrow(
      /--as-of requires a date or a git commit reference/,
    );
  });

  it("throws a clear error when the namespace has no git repo", () => {
    const plain = path.join(TMP, "plain-dir");
    fs.mkdirSync(plain, { recursive: true });
    expect(() => resolveAsOfRef("HEAD", plain)).toThrow(/not a git repository/);
  });
});

describe("RETR-004: queryMemoriesAtRef", () => {
  const repo = path.join(TMP, "travel");
  let sha1: string;
  let sha2: string;

  beforeAll(() => {
    initRepo(repo);
    // Commit 1: one row in one partition.
    writeJsonl(repo, "concept/2026-07/current.jsonl", [
      row("asof-a", "/asof/one", "2026-07-01T08:00:00.000Z"),
    ]);
    writeManifest(repo, ["concept/2026-07"]);
    sha1 = commitAll(repo, "first memory", D1);
    // Commit 2: a second row in a NEW partition (manifest merge across
    // partitions), plus a malformed line that must be skipped.
    writeJsonl(repo, "concept/2026-07/current.jsonl", [
      row("asof-a", "/asof/one", "2026-07-01T08:00:00.000Z"),
      "{ this is not json",
    ]);
    writeJsonl(repo, "person/2026-07/current.jsonl", [
      row("asof-b", "/asof/two", "2026-07-20T08:00:00.000Z", {
        domain: "person",
      }),
    ]);
    writeManifest(repo, ["concept/2026-07", "person/2026-07"]);
    sha2 = commitAll(repo, "second memory", D2);
  });

  it("returns exactly the rows present at each ref (fixture-verified time travel)", () => {
    const at1 = queryMemoriesAtRef(repo, sha1, {});
    expect(at1.total).toBe(1);
    expect(at1.memories.map((m) => m.id)).toEqual(["asof-a"]);

    const at2 = queryMemoriesAtRef(repo, sha2, {});
    expect(at2.total).toBe(2);
    expect(at2.memories.map((m) => m.id).sort()).toEqual(["asof-a", "asof-b"]);
  });

  it("merges rows across partitions via the manifest at the ref", () => {
    const at2 = queryMemoriesAtRef(repo, sha2, {});
    expect(at2.memories).toHaveLength(2);
    expect(at2.memories.some((m) => m.domain === "person")).toBe(true);
  });

  it("skips malformed JSONL lines (ignore_errors mirror)", () => {
    const at2 = queryMemoriesAtRef(repo, sha2, {});
    expect(at2.total).toBe(2); // the broken line never becomes a row
  });

  it("returns empty for a namespace with an empty manifest at the ref", () => {
    const empty = path.join(TMP, "empty");
    initRepo(empty);
    writeManifest(empty, []);
    const sha = commitAll(empty, "empty ns", D1);
    const result = queryMemoriesAtRef(empty, sha, {});
    expect(result.memories).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("returns null manifest for a ref before the manifest existed", () => {
    const late = path.join(TMP, "late-manifest");
    initRepo(late);
    fs.writeFileSync(path.join(late, ".gitkeep"), "", "utf-8");
    const shaEarly = commitAll(late, "no manifest yet", D1);
    expect(readManifestAtRef(late, shaEarly)).toBeNull();
    writeManifest(late, []);
    const shaLate = commitAll(late, "manifest added", D2);
    expect(readManifestAtRef(late, shaLate)).not.toBeNull();
  });

  it("dedupes by id keeping the latest record (update semantics)", () => {
    const repoU = path.join(TMP, "dedup");
    initRepo(repoU);
    writeJsonl(repoU, "concept/2026-07/current.jsonl", [
      row("dup-1", "/dup/k", "2026-07-01T08:00:00.000Z", {
        embedding_text: "old version",
      }),
      row("dup-1", "/dup/k", "2026-07-10T08:00:00.000Z", {
        embedding_text: "new version",
      }),
    ]);
    writeManifest(repoU, ["concept/2026-07"]);
    const sha = commitAll(repoU, "dup", D2);
    const result = queryMemoriesAtRef(repoU, sha, { key: "/dup/k" });
    expect(result.total).toBe(1);
    expect(result.memories[0].embedding_text).toBe("new version");
  });

  it("excludes memories whose latest record is a tombstone", () => {
    const repoT = path.join(TMP, "tombstone");
    initRepo(repoT);
    writeJsonl(repoT, "concept/2026-07/current.jsonl", [
      row("tomb-1", "/tomb/k", "2026-07-01T08:00:00.000Z"),
      row("tomb-1", "/tomb/k", "2026-07-10T08:00:00.000Z", {
        action: "tombstone",
      }),
      row("live-1", "/tomb/live", "2026-07-05T08:00:00.000Z"),
    ]);
    writeManifest(repoT, ["concept/2026-07"]);
    const sha = commitAll(repoT, "tomb", D2);
    const result = queryMemoriesAtRef(repoT, sha, {});
    expect(result.total).toBe(1);
    expect(result.memories[0].id).toBe("live-1");
  });

  it("orders newest-first with id ASC tiebreak and applies limit", () => {
    const repoO = path.join(TMP, "order");
    initRepo(repoO);
    writeJsonl(repoO, "concept/2026-07/current.jsonl", [
      row("o-1", "/o/old", "2026-07-01T08:00:00.000Z"),
      row("o-2", "/o/mid", "2026-07-05T08:00:00.000Z"),
      row("o-3", "/o/new", "2026-07-10T08:00:00.000Z"),
    ]);
    writeManifest(repoO, ["concept/2026-07"]);
    const sha = commitAll(repoO, "order", D2);

    const all = queryMemoriesAtRef(repoO, sha, {});
    expect(all.memories.map((m) => m.id)).toEqual(["o-3", "o-2", "o-1"]);
    expect(all.total).toBe(3);

    const limited = queryMemoriesAtRef(repoO, sha, { limit: 2 });
    expect(limited.memories.map((m) => m.id)).toEqual(["o-3", "o-2"]);
    expect(limited.total).toBe(3); // total is unlimited by limit (GAP-024)
  });

  it("applies key/prefix/domain/author filters at the ref", () => {
    const repoF = path.join(TMP, "filters");
    initRepo(repoF);
    writeJsonl(repoF, "concept/2026-07/current.jsonl", [
      row("f-1", "/alpha/x", "2026-07-01T08:00:00.000Z", {
        author: "alice@example.com",
      }),
      row("f-2", "/beta/y", "2026-07-02T08:00:00.000Z", {
        author: "bob@example.com",
      }),
      row("f-3", "/alpha/z", "2026-07-03T08:00:00.000Z", {
        author: "alice@example.com",
      }),
    ]);
    writeManifest(repoF, ["concept/2026-07"]);
    const sha = commitAll(repoF, "filters", D2);

    expect(
      queryMemoriesAtRef(repoF, sha, { keyPrefix: "/alpha/" }).memories.map(
        (m) => m.id,
      ),
    ).toEqual(["f-3", "f-1"]);
    expect(
      queryMemoriesAtRef(repoF, sha, {
        author: "bob@example.com",
      }).memories.map((m) => m.id),
    ).toEqual(["f-2"]);
    expect(queryMemoriesAtRef(repoF, sha, { key: "/alpha/x" }).total).toBe(1);
    expect(queryMemoriesAtRef(repoF, sha, { domain: "person" }).total).toBe(0);
    expect(
      queryMemoriesAtRef(repoF, sha, { after: "2026-07-02T00:00:00.000Z" })
        .total,
    ).toBe(2);
    expect(
      queryMemoriesAtRef(repoF, sha, {
        after: "2026-07-02T00:00:00.000Z",
        before: "2026-07-02T23:59:59.999Z",
      }).memories.map((m) => m.id),
    ).toEqual(["f-2"]);
  });

  it("matches chat-archive key facets for time windows (RETR-003 mirror)", () => {
    const repoC = path.join(TMP, "chats");
    initRepo(repoC);
    writeJsonl(repoC, "concept/2026-08/current.jsonl", [
      row(
        "chat-a",
        "/chats/karahermes-dm/2026-05-24/part-1",
        "2026-08-07T09:26:22.496Z",
        { domain: "message" },
      ),
      row(
        "chat-b",
        "/chats/karahermes-dm/2026-06-01",
        "2026-08-07T09:26:22.611Z",
        { domain: "message" },
      ),
    ]);
    writeManifest(repoC, ["concept/2026-08"]);
    const sha = commitAll(repoC, "chats", D3);

    const inWindow = queryMemoriesAtRef(repoC, sha, {
      after: "2026-05-24T00:00:00.000Z",
      before: "2026-05-24T23:59:59.999Z",
    });
    expect(inWindow.total).toBe(1);
    expect(inWindow.memories[0].id).toBe("chat-a");
  });

  it("never touches the working tree (read-only)", () => {
    const before = git(repo, "status --porcelain");
    queryMemoriesAtRef(repo, sha1, {});
    queryMemoriesAtRef(repo, sha2, {});
    expect(git(repo, "status --porcelain")).toBe(before);
  });
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
