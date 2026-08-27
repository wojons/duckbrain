/**
 * CONSOLIDATE-001 Tests: `duckbrain consolidate` — daily cross-namespace
 * consolidation digest.
 *
 * Covers:
 *   - delta filtering: only rows whose UTC timestamp falls in the target
 *     day are collected; other days/months are excluded; unparseable
 *     timestamps are counted, not dropped silently
 *   - dedup: identical embedding_text+key within a day/namespace collapse
 *     to one row and are flagged as duplicates; distinct keys with the same
 *     text are NOT duplicates
 *   - previews: HH:MM author: text lines, ~600-char line cap, ~25K budget
 *   - digest body shape: key/domain/content/embedding_text + namespace
 *     query param + X-API-Key header; 201 → success, non-2xx → failure
 *   - CLI wiring: runHumanCLI routes `consolidate`; --help prints usage;
 *     invalid --date exits loudly; dry-run default prints the digest
 *
 * Fixtures are written under a temp dir (mkdtemp pattern, house style) and
 * the command is pointed at them via DUCKBRAIN_NAMESPACES_PATH.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runHumanCLI } from "./human";
import {
  collectNamespaceDeltas,
  buildPreview,
  buildDigestText,
  postDigest,
  parseTargetDate,
  contentHash,
  PREVIEW_LINE_CAP,
  DIGEST_KEY_PREFIX,
  DIGEST_NAMESPACE,
  type ConsolidateRow,
} from "./consolidate";

/** Capture console.log/console.error for the duration of fn; swallows the
 * process.exit(1) throw (surfaces as a vitest throw) and records it. */
async function capture(
  fn: () => Promise<void>,
): Promise<{ logs: string[]; errors: string[]; rejected: boolean }> {
  const logs: string[] = [];
  const errors: string[] = [];
  let rejected = false;
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...a: any[]) => logs.push(a.map(String).join(" ")));
  const errSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...a: any[]) => errors.push(a.map(String).join(" ")));
  try {
    await fn();
  } catch {
    rejected = true;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { logs, errors, rejected };
}

function row(over: Partial<ConsolidateRow> & { id: string }): ConsolidateRow {
  return {
    key: `/test/${over.id}`,
    domain: "event",
    timestamp: "2026-08-10T12:00:00.000Z",
    author: "test@example.com",
    action: "add",
    embedding_text: "some content",
    ...over,
  };
}

/** Write a fixture namespace tree under a fresh temp dir; returns the root. */
function makeFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consolidate-fixture-"));
  const write = (
    ns: string,
    domain: string,
    month: string,
    lines: string[],
  ) => {
    const dir = path.join(root, ns, domain, month);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "current.jsonl"), lines.join("\n") + "\n");
  };
  const manifest = (ns: string, partitions: string[]) => {
    fs.mkdirSync(path.join(root, ns), { recursive: true });
    fs.writeFileSync(
      path.join(root, ns, "manifest.json"),
      JSON.stringify({ partitions, lastUpdated: "2026-08-10T00:00:00.000Z" }),
    );
  };

  // ns-a: 3 rows on target day, 1 duplicate (same text+key), 1 row other day
  write("ns-a", "event", "2026-08", [
    JSON.stringify(
      row({
        id: "a1",
        timestamp: "2026-08-10T08:00:00.000Z",
        embedding_text: "alpha work",
      }),
    ),
    JSON.stringify(
      row({
        id: "a2",
        timestamp: "2026-08-10T09:00:00.000Z",
        embedding_text: "alpha work",
      }),
    ),
    JSON.stringify(
      row({
        id: "a3",
        timestamp: "2026-08-10T10:00:00.000Z",
        embedding_text: "beta work",
      }),
    ),
    JSON.stringify(
      row({
        id: "a4",
        timestamp: "2026-08-11T08:00:00.000Z",
        embedding_text: "next day",
      }),
    ),
  ]);
  manifest("ns-a", ["event/2026-08/"]);

  // ns-b: same text, different keys → duplicates (text-only hash); 1 unparseable ts
  write("ns-b", "config", "2026-08", [
    JSON.stringify(
      row({
        id: "b1",
        key: "/test/b1",
        timestamp: "2026-08-10T07:00:00.000Z",
        embedding_text: "shared text",
      }),
    ),
    JSON.stringify(
      row({
        id: "b2",
        key: "/test/b2",
        timestamp: "2026-08-10T07:30:00.000Z",
        embedding_text: "shared text",
      }),
    ),
    JSON.stringify(
      row({
        id: "b3",
        timestamp: "not-a-date",
        embedding_text: "broken",
      }),
    ),
  ]);
  manifest("ns-b", ["config/2026-08/"]);

  // ns-c: manifest but no domain dirs → no deltas
  manifest("ns-c", []);

  // ns-d: no manifest → skipped entirely
  fs.mkdirSync(path.join(root, "ns-d"), { recursive: true });

  return root;
}

describe("CONSOLIDATE-001: delta collection + dedup", () => {
  it("filters to the target UTC day and dedupes by content-hash", () => {
    const root = makeFixtureRoot();
    try {
      const deltas = collectNamespaceDeltas(root, "2026-08-10");
      const byNs = new Map(deltas.map((d) => [d.namespace, d]));

      // ns-d has no manifest → skipped; ns-c has no partitions → empty delta
      expect(byNs.has("ns-d")).toBe(false);
      expect(byNs.get("ns-c")!.rows).toEqual([]);

      const a = byNs.get("ns-a")!;
      expect(a.rows.map((r) => r.id)).toEqual(["a1", "a2", "a3"]);
      expect(a.unique.map((r) => r.id)).toEqual(["a1", "a3"]);
      expect(a.duplicates).toBe(1);
      expect(a.unparseable).toBe(0);

      const b = byNs.get("ns-b")!;
      expect(b.rows.map((r) => r.id)).toEqual(["b1", "b2"]);
      // Same text, different keys → still duplicates (text-only hash)
      expect(b.unique.map((r) => r.id)).toEqual(["b1"]);
      expect(b.duplicates).toBe(1);
      expect(b.unparseable).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("contentHash differs when the text differs", () => {
    const base = row({ id: "x" });
    const sameText = row({ id: "x" });
    const diffText = row({ id: "x", embedding_text: "other content" });
    expect(contentHash(base)).toBe(contentHash(sameText));
    expect(contentHash(base)).not.toBe(contentHash(diffText));
  });

  it("parseTargetDate defaults to yesterday and rejects invalid dates", () => {
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(parseTargetDate()).toBe(yesterday);
    expect(parseTargetDate("2026-08-10")).toBe("2026-08-10");
    expect(parseTargetDate("2026-02-30")).toBeNull();
    expect(parseTargetDate("2026-13-01")).toBeNull();
    expect(parseTargetDate("10-08-2026")).toBeNull();
    expect(parseTargetDate("garbage")).toBeNull();
  });
});

describe("CONSOLIDATE-001: preview + digest shape", () => {
  it("builds HH:MM author: text preview lines with caps", () => {
    const rows = [
      row({
        id: "p1",
        timestamp: "2026-08-10T08:05:00.000Z",
        author: "alice@example.com",
        embedding_text: "hello world",
      }),
      row({
        id: "p2",
        timestamp: "2026-08-10T23:59:00.000Z",
        author: "bob@example.com",
        embedding_text: "x".repeat(PREVIEW_LINE_CAP + 50),
      }),
    ];
    const preview = buildPreview(rows);
    expect(preview[0]).toBe("08:05 alice@example.com: hello world");
    expect(preview[1]).toContain("23:59 bob@example.com: ");
    expect(preview[1].length).toBeLessThanOrEqual(PREVIEW_LINE_CAP + 30);
    expect(preview[1].endsWith("…")).toBe(true);
  });

  it("respects the per-namespace preview budget", () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      row({ id: `q${i}`, embedding_text: "y".repeat(500) }),
    );
    const preview = buildPreview(rows, 2_000);
    const total = preview.join("\n").length;
    expect(total).toBeLessThanOrEqual(2_000 + 200);
    expect(preview[preview.length - 1]).toBe("… (preview truncated)");
  });

  it("builds a digest with per-namespace summary lines + dedup stats", () => {
    const root = makeFixtureRoot();
    try {
      const deltas = collectNamespaceDeltas(root, "2026-08-10");
      const digest = buildDigestText(deltas, "2026-08-10");
      expect(digest).toContain(
        "# duckbrain consolidate digest 2026-08-10 (UTC)",
      );
      expect(digest).toContain("## ns-a");
      expect(digest).toContain("rows: 3 | unique: 2 | duplicates: 1");
      expect(digest).toContain("## ns-b");
      expect(digest).toContain("rows: 2 | unique: 1 | duplicates: 1");
      expect(digest).toContain("total delta rows: 5 (3 unique, 2 duplicates)");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CONSOLIDATE-001: digest write path", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the digest body with the X-API-Key header and namespace param", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 201, ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const result = await postDigest({
      apiBase: "http://127.0.0.1:3000",
      apiKey: "test-key",
      dateStr: "2026-08-10",
      content: "# digest body",
      embeddingText: "digest 2026-08-10",
    });

    expect(result).toEqual({ status: 201, ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:3000/api/memories?namespace=duckbrain");
    expect(init.method).toBe("POST");
    expect(init.headers["X-API-Key"]).toBe("test-key");
    const body = JSON.parse(init.body as string);
    expect(body.key).toBe(`${DIGEST_KEY_PREFIX}2026-08-10`);
    expect(body.domain).toBe("config");
    expect(body.content).toBe("# digest body");
    expect(body.embedding_text).toBe("digest 2026-08-10");
  });

  it("reports a non-2xx response as a failed write", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 401, ok: false });
    vi.stubGlobal("fetch", fetchMock);
    const result = await postDigest({
      apiBase: "http://127.0.0.1:3000",
      apiKey: "bad-key",
      dateStr: "2026-08-10",
      content: "x",
      embeddingText: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });
});

describe("CONSOLIDATE-001: CLI wiring", () => {
  it("routes `consolidate` through runHumanCLI and dry-runs by default", async () => {
    const root = makeFixtureRoot();
    const original = process.env.DUCKBRAIN_NAMESPACES_PATH;
    const originalKey = process.env.DUCKBRAIN_API_KEY;
    try {
      process.env.DUCKBRAIN_NAMESPACES_PATH = root;
      delete process.env.DUCKBRAIN_API_KEY;
      const { logs, rejected } = await capture(() =>
        runHumanCLI("consolidate", ["--date=2026-08-10"]),
      );
      expect(rejected).toBe(false);
      const out = logs.join("\n");
      expect(out).toContain("## ns-a");
      expect(out).toContain("rows: 3 | unique: 2 | duplicates: 1");
      expect(out).toContain("08:00 test@example.com: alpha work");
      expect(out).toContain("dry-run");
      expect(out).toContain("total delta rows: 5 (3 unique, 2 duplicates)");
    } finally {
      if (original === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
      else process.env.DUCKBRAIN_NAMESPACES_PATH = original;
      if (originalKey === undefined) delete process.env.DUCKBRAIN_API_KEY;
      else process.env.DUCKBRAIN_API_KEY = originalKey;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("--help prints the flag surface", async () => {
    const { logs } = await capture(() =>
      runHumanCLI("consolidate", ["--help"]),
    );
    const help = logs.join("\n");
    expect(help).toContain("--date");
    expect(help).toContain("--write-digest");
    expect(help).toContain("--digest-content");
    expect(help).toContain("DUCKBRAIN_API_KEY");
  });

  it("invalid --date exits loudly", async () => {
    const { errors, rejected } = await capture(() =>
      runHumanCLI("consolidate", ["--date=2026-02-30"]),
    );
    expect(rejected).toBe(true);
    expect(errors.join("\n")).toContain("--date");
  });

  it("--write-digest without DUCKBRAIN_API_KEY exits loudly", async () => {
    const root = makeFixtureRoot();
    const original = process.env.DUCKBRAIN_NAMESPACES_PATH;
    const originalKey = process.env.DUCKBRAIN_API_KEY;
    try {
      process.env.DUCKBRAIN_NAMESPACES_PATH = root;
      delete process.env.DUCKBRAIN_API_KEY;
      const { errors, rejected } = await capture(() =>
        runHumanCLI("consolidate", ["--date=2026-08-10", "--write-digest"]),
      );
      expect(rejected).toBe(true);
      expect(errors.join("\n")).toContain("DUCKBRAIN_API_KEY");
    } finally {
      if (original === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
      else process.env.DUCKBRAIN_NAMESPACES_PATH = original;
      if (originalKey === undefined) delete process.env.DUCKBRAIN_API_KEY;
      else process.env.DUCKBRAIN_API_KEY = originalKey;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("--digest-content reads the file for the digest body", async () => {
    const root = makeFixtureRoot();
    const contentFile = path.join(root, "digest.txt");
    fs.writeFileSync(contentFile, "summarized by cron agent");
    const original = process.env.DUCKBRAIN_NAMESPACES_PATH;
    try {
      process.env.DUCKBRAIN_NAMESPACES_PATH = root;
      const { logs } = await capture(() =>
        runHumanCLI("consolidate", [
          "--date=2026-08-10",
          `--digest-content=${contentFile}`,
        ]),
      );
      expect(logs.join("\n")).toContain("summarized by cron agent");
    } finally {
      if (original === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
      else process.env.DUCKBRAIN_NAMESPACES_PATH = original;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("DUCKBRAIN_API_KEY set triggers the write path (201 reported)", async () => {
    const root = makeFixtureRoot();
    const original = process.env.DUCKBRAIN_NAMESPACES_PATH;
    const originalKey = process.env.DUCKBRAIN_API_KEY;
    const fetchMock = vi.fn().mockResolvedValue({ status: 201, ok: true });
    vi.stubGlobal("fetch", fetchMock);
    try {
      process.env.DUCKBRAIN_NAMESPACES_PATH = root;
      process.env.DUCKBRAIN_API_KEY = "test-key";
      const { logs, rejected } = await capture(() =>
        runHumanCLI("consolidate", ["--date=2026-08-10"]),
      );
      expect(rejected).toBe(false);
      expect(logs.join("\n")).toContain("digest posted: 201");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toContain(`namespace=${DIGEST_NAMESPACE}`);
    } finally {
      if (original === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
      else process.env.DUCKBRAIN_NAMESPACES_PATH = original;
      if (originalKey === undefined) delete process.env.DUCKBRAIN_API_KEY;
      else process.env.DUCKBRAIN_API_KEY = originalKey;
      vi.unstubAllGlobals();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
