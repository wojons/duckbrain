/**
 * S3-STATUS-SCALE-001: `s3 status` must answer from the RECORDED state, and a
 * bucket comparison must be a bounded sample the caller asked for.
 *
 * Incident shape (measured 2026-11-05): `s3 status scheduler --json` produced
 * no parseable output inside a 60s budget — the call path was
 * collectS3StatusReport -> listRemoteObjects, which pages ListObjectsV2 over
 * the WHOLE namespace prefix. At the measured listing rate (10,002 objects in
 * 5,504ms) the scheduler namespace (258,578 files) needs ~23 pages, so the
 * namespace that most needs a status check was the one whose check could not
 * finish. The manifest already records what was pushed; the listing re-derived
 * it from the bucket on every call.
 *
 * What this suite pins:
 *   1. the DEFAULT path makes no bucket request at all and answers with the
 *      manifest's object count/bytes, labelled `recorded`;
 *   2. `--verify` uses ONE bounded page (MaxKeys = the sample), compares it
 *      with the record and reports drift (unrecorded + size-changed), labelled
 *      `verified` — a stale record can never look like a fresh listing;
 *   3. a sample above S3_VERIFY_SAMPLE_MAX refuses BEFORE any network call
 *      unless `--allow-many-objects` is passed, naming the number and the flag;
 *   4. the text renderer states which source the count came from;
 *   5. the dispatcher reads `--sample 100` (space form) as a value, not as a
 *      namespace name.
 *
 * Isolation: temp config + temp namespaces root via env vars (snapshot and
 * restored per test) and ./client mocked, so no S3 request is ever made.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  S3_VERIFY_SAMPLE_DEFAULT,
  S3_VERIFY_SAMPLE_MAX,
  collectS3StatusReport,
  compareSample,
  formatBytes,
  recordedPopulation,
  resolveVerifyPlan,
  s3Command,
  s3Status,
} from "./cli";
import { DEFAULT_S3_CONFIG } from "./config";

/** Every bounded listing this suite causes, so "no network" is measurable. */
const boundedCalls: Array<{ prefix: string; maxKeys: number }> = [];

vi.mock("./client", () => ({
  buildClient: () => ({}),
  // Deliberately explodes: the default status path must never call it.
  listRemoteObjects: async () => {
    throw new Error("UNBOUNDED LISTING — the default path must not list");
  },
  listRemoteObjectsBounded: async (
    _client: unknown,
    _bucket: string,
    prefix: string,
    maxKeys: number,
  ) => {
    boundedCalls.push({ prefix, maxKeys });
    if (prefix.includes("bad-ns")) throw new Error("AccessDenied");
    // Real keys carry the prefix; the collector strips it to compare with the
    // manifest's relPaths. Three objects: one matches the record, one changed
    // size, one is not in the record at all.
    const at = (rel: string): string => `${prefix}${rel}`;
    return {
      objects: new Map([
        [
          at("event/2026-08/0001.jsonl"),
          { key: at("event/2026-08/0001.jsonl"), size: 10 },
        ],
        [
          at("event/2026-08/0002.jsonl"),
          { key: at("event/2026-08/0002.jsonl"), size: 99 },
        ],
        [at("new.jsonl"), { key: at("new.jsonl"), size: 7 }],
      ]),
      truncated: false,
    };
  },
}));

const ENV_KEYS = [
  "DUCKBRAIN_CONFIG_PATH",
  "DUCKBRAIN_NAMESPACES_PATH",
  "DUCKBRAIN_HOME_ROOT",
  "AWS_ENDPOINT_URL_S3",
  "AWS_ENDPOINT_URL",
] as const;

let envSnapshot: Record<string, string | undefined>;
let tmpDir: string;
let nsRoot: string;

beforeEach(() => {
  envSnapshot = Object.fromEntries(
    ENV_KEYS.map((k) => [k, process.env[k]]),
  ) as Record<string, string | undefined>;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s3statscal001-"));
  nsRoot = path.join(tmpDir, "namespaces");
  fs.mkdirSync(nsRoot, { recursive: true });
  process.env.DUCKBRAIN_NAMESPACES_PATH = nsRoot;
  delete process.env.DUCKBRAIN_HOME_ROOT;
  process.env.AWS_ENDPOINT_URL_S3 = "https://probe.invalid";
  delete process.env.AWS_ENDPOINT_URL;
  boundedCalls.length = 0;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = envSnapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeConfig(): void {
  const cfgFile = path.join(tmpDir, "duckbrain.config.json");
  fs.writeFileSync(
    cfgFile,
    JSON.stringify(
      {
        s3: { ...DEFAULT_S3_CONFIG, enabled: true, bucket: "probe-bucket" },
        namespaceMappings: { "ns-a": "ns-a" },
      },
      null,
      2,
    ),
    "utf-8",
  );
  process.env.DUCKBRAIN_CONFIG_PATH = cfgFile;
}

/** A namespace with two syncable files and a manifest that records both. */
function seedNamespace(): void {
  const dir = path.join(nsRoot, "ns-a", "event", "2026-08");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "0001.jsonl"), "x".repeat(10));
  fs.writeFileSync(path.join(dir, "0002.jsonl"), "y".repeat(20));
  fs.mkdirSync(path.join(nsRoot, ".s3state"), { recursive: true });
  fs.writeFileSync(
    path.join(nsRoot, ".s3state", "ns-a.json"),
    JSON.stringify({
      version: 1,
      ns: "ns-a",
      lastSyncAt: "2026-11-06T20:08:40.486Z",
      files: {
        "event/2026-08/0001.jsonl": { size: 10, mtimeMs: 1 },
        "event/2026-08/0002.jsonl": { size: 20, mtimeMs: 1 },
      },
    }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(nsRoot, ".s3state", "ns-a.push.json"),
    JSON.stringify({
      version: 1,
      ns: "ns-a",
      lastPushAt: new Date(Date.now() - 60_000).toISOString(),
      lastPushAttemptAt: new Date(Date.now() - 60_000).toISOString(),
      lastPushOk: true,
      uploaded: 2,
      skipped: 0,
      failedUploads: 0,
      failures: 0,
    }),
    "utf-8",
  );
}

async function captureStdout(
  run: () => Promise<void>,
): Promise<{ stdout: string; lines: string[] }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // A previous capture in the same test left its calls behind.
  log.mockClear();
  await run();
  const lines = log.mock.calls.map((c) => c.map(String).join(" "));
  return { stdout: lines.join("\n"), lines };
}

describe("S3-STATUS-SCALE-001: recorded state answers status; listings are bounded samples", () => {
  it("DEFAULT status lists NOTHING and answers with the recorded count, labelled recorded", async () => {
    writeConfig();
    seedNamespace();

    const report = await collectS3StatusReport(".");
    const row = report.namespaces.find((r) => r.ns === "ns-a")!;

    // The falsifier: pre-fix this call paged the prefix. Now zero requests.
    expect(boundedCalls).toHaveLength(0);
    expect(row.remote).toBeNull();
    expect(row.verify).toBeUndefined();
    expect(row.countSource).toBe("recorded");
    expect(row.objectsRecorded).toBe(2);
    expect(row.bytesRecorded).toBe(30);
    // The record is not silently presented as a listing: lastSync is the
    // manifest's own stamp.
    expect(row.lastSync).toBe("2026-11-06T20:08:40.486Z");
    expect(report.verifyPlan).toBeNull();
  });

  it("--verify lists ONE bounded page, compares it to the record and reports drift", async () => {
    writeConfig();
    seedNamespace();

    const report = await collectS3StatusReport(".", undefined, {
      verify: true,
      sample: 100,
    });
    const row = report.namespaces.find((r) => r.ns === "ns-a")!;

    expect(boundedCalls).toEqual([{ prefix: "duckbrain/ns-a/", maxKeys: 100 }]);
    expect(report.verifyPlan).toEqual({ sample: 100, allowManyObjects: false });
    expect(row.countSource).toBe("verified");
    expect(row.remote).toBe(3);
    expect(row.verify).toMatchObject({
      requested: 100,
      listed: 3,
      truncated: false,
      unrecorded: 1, // new.jsonl is not in the manifest
      mismatched: 1, // b.jsonl: recorded 20, listed 99
      drift: 2,
    });
    expect(row.verify!.examples).toContain("new.jsonl");
    expect(row.verify!.examples).toContain("event/2026-08/0002.jsonl");
  });

  it("the sample defaults to S3_VERIFY_SAMPLE_DEFAULT when --sample is omitted", async () => {
    writeConfig();
    seedNamespace();

    await collectS3StatusReport(".", undefined, { verify: true });

    expect(boundedCalls).toHaveLength(1);
    expect(boundedCalls[0]!.maxKeys).toBe(S3_VERIFY_SAMPLE_DEFAULT);
  });

  it("a sample above the budget REFUSES before any network call, naming the number and the flag", async () => {
    writeConfig();
    seedNamespace();

    expect(() =>
      resolveVerifyPlan({ verify: true, sample: S3_VERIFY_SAMPLE_MAX + 1 }),
    ).toThrow(/refusing to list .* budget is .*--allow-many-objects/);

    // Through the CLI: exit 1, nothing listed, the refusal on stderr.
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await s3Status(".", undefined, {
      verify: true,
      sample: S3_VERIFY_SAMPLE_MAX + 1,
    });

    expect(boundedCalls).toHaveLength(0);
    expect(exit).toHaveBeenCalledWith(1);
    const message = err.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(message).toContain(String(S3_VERIFY_SAMPLE_MAX + 1));
    expect(message).toContain(`budget is ${S3_VERIFY_SAMPLE_MAX}`);
    expect(message).toContain("--allow-many-objects");
  });

  it("--allow-many-objects lifts the budget and the page is bounded by the requested sample", async () => {
    writeConfig();
    seedNamespace();

    const report = await collectS3StatusReport(".", undefined, {
      verify: true,
      sample: S3_VERIFY_SAMPLE_MAX + 1,
      allowManyObjects: true,
    });

    expect(boundedCalls[0]!.maxKeys).toBe(S3_VERIFY_SAMPLE_MAX + 1);
    expect(report.verifyPlan).toEqual({
      sample: S3_VERIFY_SAMPLE_MAX + 1,
      allowManyObjects: true,
    });
  });

  it("the text renderer names the source of the count and prints the drift", async () => {
    writeConfig();
    seedNamespace();

    const recordedRun = await captureStdout(() => s3Status("."));
    const recordedRow = recordedRun.lines.find((l) => / {2}ns-a: local=/.test(l))!;
    expect(recordedRow).toContain("objects=2");
    expect(recordedRow).toContain("30 B");
    expect(recordedRow).toContain("(recorded 2026-11-06T20:08:40.486Z)");
    expect(recordedRun.stdout).toContain("no bucket listing");

    const verifiedRun = await captureStdout(() =>
      s3Status(".", undefined, { verify: true, sample: 100 }),
    );
    const verifiedRow = verifiedRun.lines.find((l) => / {2}ns-a: local=/.test(l))!;
    expect(verifiedRow).toContain("objects=3");
    expect(verifiedRow).toContain("verified sample: 3/100 listed");
    expect(verifiedRun.stdout).toContain("unrecorded=1, size-changed=1");
  });

  it("`status --verify --sample 100` through the dispatcher reads 100 as a value, not a namespace", async () => {
    writeConfig();
    seedNamespace();

    const { lines } = await captureStdout(() =>
      s3Command(["status", "--verify", "--sample", "100"], "."),
    );

    expect(boundedCalls).toHaveLength(1);
    expect(boundedCalls[0]!.prefix).toBe("duckbrain/ns-a/");
    expect(boundedCalls[0]!.maxKeys).toBe(100);
    // Positional was not polluted: the row is the namespace, not "100".
    expect(lines.some((l) => / {2}ns-a: local=/.test(l))).toBe(true);
    expect(lines.some((l) => / {2}100: local=/.test(l))).toBe(false);
  });

  it("the local walk is budgeted by the RECORD, says so, and --deep measures it", async () => {
    writeConfig();
    seedNamespace(); // manifest records 2 objects

    // Budget 1: the record already exceeds it, so the tree is not walked and
    // the null carries its reason (never a bare "local=?").
    const skipped = await collectS3StatusReport(".", undefined, {
      localWalkMax: 1,
    });
    const skippedRow = skipped.namespaces.find((r) => r.ns === "ns-a")!;
    expect(skippedRow.local).toBeNull();
    expect(skippedRow.localOmitted).toContain("2 recorded objects exceed the 1");
    expect(skippedRow.unpushed).toBeUndefined();
    // …and the recorded half is still there.
    expect(skippedRow.objectsRecorded).toBe(2);
    expect(skippedRow.lastPushAgeSeconds).not.toBeNull();

    // --deep is the override, and it must survive the CLI plumbing (it did not
    // the first time: s3Status dropped the flag, so --deep silently no-oped).
    const { lines } = await captureStdout(() =>
      s3Command(["status", "--local-walk-max=1", "--deep"], "."),
    );
    const row = lines.find((l) => / {2}ns-a: local=/.test(l))!;
    expect(row).toContain("local=2");
    expect(row).toContain("unpushed=");
    expect(lines.some((l) => l.includes("not measured"))).toBe(false);

    // Without --deep the same budget reports the omission.
    const budgeted = await captureStdout(() =>
      s3Command(["status", "--local-walk-max=1"], "."),
    );
    const omitted = budgeted.lines.find((l) => / {2}ns-a: local=\?/.test(l));
    expect(omitted).toBeDefined();
    expect(omitted!).toContain("pass --deep");
  });

  it("`status --verify --allow-many-objects --sample=6000` parses the = form too", async () => {
    writeConfig();
    seedNamespace();

    await captureStdout(() =>
      s3Command(["status", "--verify", `--sample=${S3_VERIFY_SAMPLE_MAX + 1000}`, "--allow-many-objects"], "."),
    );

    expect(boundedCalls).toHaveLength(1);
    expect(boundedCalls[0]!.maxKeys).toBe(S3_VERIFY_SAMPLE_MAX + 1000);
  });
});

describe("S3-STATUS-SCALE-001 helpers", () => {
  it("recordedPopulation sums the manifest without touching the filesystem", () => {
    expect(recordedPopulation(null)).toEqual({ objects: null, bytes: null });
    expect(
      recordedPopulation({
        files: { a: { size: 1 }, b: { size: 2 }, c: {} },
      }),
    ).toEqual({ objects: 3, bytes: 3 });
  });

  it("compareSample only claims drift it can prove from the page it read", () => {
    const manifest = { files: { "a.jsonl": { size: 5 } } };
    const sample = compareSample(
      {
        objects: new Map([
          ["p/a.jsonl", { key: "p/a.jsonl", size: 5 }],
          ["p/b.jsonl", { key: "p/b.jsonl", size: 5 }],
        ]),
        truncated: true,
      },
      manifest,
      "p/",
      2,
      12,
    );
    expect(sample).toEqual({
      requested: 2,
      listed: 2,
      truncated: true,
      unrecorded: 1,
      mismatched: 0,
      drift: 1,
      examples: ["b.jsonl"],
      elapsedMs: 12,
    });
  });

  it("does not count the push's own checksum ledger as drift", () => {
    // sync.ts publishes <prefix>/<ns>/.s3state/checksums.json on every push and
    // walkLocal never lists it in the manifest — an always-on "drift" would be
    // an alarm nobody could ever clear.
    const sample = compareSample(
      {
        objects: new Map([
          ["p/.s3state/checksums.json", { key: "p/.s3state/checksums.json", size: 42 }],
          ["p/a.jsonl", { key: "p/a.jsonl", size: 5 }],
        ]),
        truncated: false,
      },
      { files: { "a.jsonl": { size: 5 } } },
      "p/",
      2,
      5,
    );
    expect(sample.drift).toBe(0);
    expect(sample.unrecorded).toBe(0);
    expect(sample.listed).toBe(2);
  });

  it("formatBytes keeps a 10-digit byte count readable", () => {
    expect(formatBytes(null)).toBe("unknown");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.00 KiB");
    expect(formatBytes(2_314_133_865)).toBe("2.16 GiB");
  });
});
