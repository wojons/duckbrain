/**
 * S3-READ-AMPLIFICATION-001 — a wildcard `s3 query` must be PLANNED before
 * bytes move.
 *
 * Measured 2026-11-05 against the live bucket: coding-hermes/config/2026-08
 * holds 10,002 objects (57,613,394 bytes; the largest is 46,312,914 bytes and
 * the rest average ~1.1KB) and a wildcard read at the measured ~0.35s per
 * object GET needs about an hour — it did not finish in a 300s budget. The row
 * therefore asks for a cheap LIST-based read plan that REFUSES above a budget
 * instead of starting a scan that cannot finish, and that names the fragment
 * layout (object count + largest object) where the decision is made.
 *
 * These tests are offline and deterministic: DuckDB execution and S3 listing
 * are both injected. The falsifier case is case (3) — on pre-fix code there is
 * no plan at all, so the statement proceeds to credential resolution and fails
 * with "no AWS credentials resolved" instead of a refusal naming 10,002.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_MAX_WILDCARD_OBJECTS,
  S3ManyObjectsError,
  extractS3Paths,
  formatCount,
  formatEstimate,
  globToRegExp,
  planWildcardReads,
  wildcardFreePrefix,
  type ReadPlanObject,
} from "./read-plan";
import { runS3Query } from "./query";
import { parseS3QueryArgs } from "./cli";
import { DEFAULT_S3_CONFIG, type S3Config } from "./config";

const PARTITION = "s3://test-bucket/duckbrain/coding-hermes/config/2026-08";
const WILDCARD_SQL = `SELECT count(*) FROM read_json_auto('${PARTITION}/*.jsonl')`;

/** The live shape of the measured partition: 1 big segment + ~10,000 stubs. */
function fragmentedPartition(): ReadPlanObject[] {
  const objects: ReadPlanObject[] = [
    { key: `${PARTITION}/0001.jsonl`, bytes: 46_312_914 },
  ];
  for (let i = 2; i <= 10_002; i += 1) {
    objects.push({
      key: `${PARTITION}/${String(i).padStart(4, "0")}.jsonl`,
      bytes: 1_131,
    });
  }
  return objects;
}

const cfg: S3Config = {
  ...DEFAULT_S3_CONFIG,
  enabled: true,
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "test-bucket",
  prefix: "duckbrain",
  forcePathStyle: true,
};

const creds = async () => ({
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
});

const ENV_KEYS = [
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const;

let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as Record<
    string,
    string | undefined
  >;
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = envSnapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("read plan primitives (S3-READ-AMPLIFICATION-001)", () => {
  it("extracts s3:// paths from the statement, verbatim and de-duplicated", () => {
    const sql = `SELECT * FROM read_json_auto('${PARTITION}/*.jsonl') a, read_json_auto('${PARTITION}/*.jsonl') b`;
    const refs = extractS3Paths(sql);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.path).toBe(`${PARTITION}/*.jsonl`);
    expect(refs[0]!.wildcard).toBe(true);
    expect(refs[0]!.prefix).toBe(`${PARTITION}/`);
  });

  it("flags a fully-qualified single object as non-wildcard (no LIST, no refusal)", () => {
    const refs = extractS3Paths(`SELECT * FROM read_json_auto('${PARTITION}/0001.jsonl')`);
    expect(refs[0]!.wildcard).toBe(false);
    expect(refs[0]!.prefix).toBe(`${PARTITION}/0001.jsonl`);
  });

  it("truncates the prefix at the first wildcard segment", () => {
    expect(wildcardFreePrefix("s3://b/ns/event/**/2026-*.jsonl")).toBe("s3://b/ns/event/");
    expect(wildcardFreePrefix("s3://b/ns/event/2026-08/*.jsonl")).toBe("s3://b/ns/event/2026-08/");
  });

  it("matches a flat glob within one path segment but lets ** cross segments", () => {
    expect(globToRegExp("s3://b/ns/*.jsonl").test("s3://b/ns/a.jsonl")).toBe(true);
    expect(globToRegExp("s3://b/ns/*.jsonl").test("s3://b/ns/sub/a.jsonl")).toBe(false);
    expect(globToRegExp("s3://b/ns/**/*.jsonl").test("s3://b/ns/sub/a.jsonl")).toBe(true);
  });

  it("formats counts and estimates without locale drift", () => {
    expect(formatCount(10_002)).toBe("10,002");
    expect(formatEstimate(3501)).toBe("58m 21s");
    expect(formatEstimate(0.4)).toBe("0s");
  });
});

describe("wildcard read plan refuses an unbudgeted fragmented partition", () => {
  it("lists the prefix, counts the matches, and refuses above the budget (falsifier)", async () => {
    const listObjects = vi.fn(async () => fragmentedPartition());
    const execute = vi.fn(async () => [{ n: 112_311 }]);

    const err = await runS3Query(cfg, WILDCARD_SQL, {
      listObjects,
      execute,
      credentialProvider: creds,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(S3ManyObjectsError);
    const message = (err as Error).message;
    // AC-1: the count, the estimate at the measured cost, and the flag.
    expect(message).toContain("matches 10,002 objects");
    expect(message).toContain("~0.35s per-object GET");
    expect(message).toContain("58m 21s");
    expect(message).toContain("--allow-many-objects");
    expect(message).toContain(`--max-objects=<N>`);
    expect(message).toContain(`above ${DEFAULT_MAX_WILDCARD_OBJECTS}`);
    // AC-2: the fragment layout, where the decision is made.
    expect(message).toContain(`largest object is ${PARTITION}/0001.jsonl`);
    expect(message).toContain("46,312,914 bytes");
    expect(message).toContain("other 10,001 objects average 1,131 bytes");
    // AC-2: the compacted alternative, naming this partition.
    expect(message).toContain(
      "duckbrain squash --segments --partition=config/2026-08 --namespace=coding-hermes",
    );
    // The LIST happened once, and NO bytes were read.
    expect(listObjects).toHaveBeenCalledTimes(1);
    expect(listObjects).toHaveBeenCalledWith(`${PARTITION}/`);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not list anything for a non-wildcard statement", async () => {
    const listObjects = vi.fn(async () => fragmentedPartition());
    const execute = vi.fn(async () => [{ n: 1 }]);

    const result = await runS3Query(
      cfg,
      `SELECT * FROM read_json_auto('${PARTITION}/0001.jsonl')`,
      { listObjects, execute, credentialProvider: creds },
    );

    expect(result.count).toBe(1);
    expect(listObjects).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("plans per matched object, not per object under the prefix", async () => {
    const listObjects = vi.fn(async () => [
      { key: `${PARTITION}/0001.jsonl`, bytes: 10 },
      { key: `${PARTITION}/0002.jsonl`, bytes: 20 },
      { key: `${PARTITION}/notes.txt`, bytes: 30 },
    ]);
    const plans = await planWildcardReads(WILDCARD_SQL, cfg, { listObjects });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.plan!.objectCount).toBe(2);
    expect(plans[0]!.plan!.totalBytes).toBe(30);
    expect(plans[0]!.plan!.overBudget).toBe(false);
  });
});

describe("paying for the scan is explicit and visible", () => {
  it("--allow-many-objects proceeds and warns with the same plan", async () => {
    const execute = vi.fn(async () => [{ n: 112_311 }]);
    const warnings: string[] = [];

    const result = await runS3Query(cfg, WILDCARD_SQL, {
      listObjects: async () => fragmentedPartition(),
      execute,
      allowManyObjects: true,
      credentialProvider: creds,
      onPlanWarning: (m) => warnings.push(m),
    });

    expect(result.count).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("matches 10,002 objects");
    expect(warnings[0]).toContain("46,312,914 bytes");
  });

  it("--max-objects raises the budget for one call", async () => {
    const execute = vi.fn(async () => [{ n: 112_311 }]);
    const result = await runS3Query(cfg, WILDCARD_SQL, {
      listObjects: async () => fragmentedPartition(),
      execute,
      maxObjects: 20_000,
      credentialProvider: creds,
      onPlanWarning: () => undefined,
    });
    expect(result.count).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("stays quiet below the budget (no warning, no noise on a healthy read)", async () => {
    const warnings: string[] = [];
    const execute = vi.fn(async () => [{ n: 3 }]);
    await runS3Query(cfg, WILDCARD_SQL, {
      listObjects: async () => [
        { key: `${PARTITION}/0001.jsonl`, bytes: 10 },
        { key: `${PARTITION}/0002.jsonl`, bytes: 10 },
      ],
      execute,
      credentialProvider: creds,
      onPlanWarning: (m) => warnings.push(m),
    });
    expect(warnings).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("a plan that cannot be built warns and never blocks the read", async () => {
    const warnings: string[] = [];
    const execute = vi.fn(async () => [{ n: 7 }]);
    const result = await runS3Query(cfg, WILDCARD_SQL, {
      listObjects: async () => {
        throw new Error("getaddrinfo ENOTFOUND s3.example.com");
      },
      execute,
      credentialProvider: creds,
      onPlanWarning: (m) => warnings.push(m),
    });
    expect(result.count).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(warnings[0]).toContain("could not build a read plan");
    expect(warnings[0]).toContain("ENOTFOUND");
  });
});

describe("CLI flags are the CLI's, not the SQL's", () => {
  it("strips --allow-many-objects and --max-objects=N from the statement", () => {
    const parsed = parseS3QueryArgs([
      "SELECT * FROM",
      "read_json_auto('s3://b/x/*.jsonl')",
      "--allow-many-objects",
      "--max-objects=2000",
    ]);
    expect(parsed.sql).toBe("SELECT * FROM read_json_auto('s3://b/x/*.jsonl')");
    expect(parsed.allowManyObjects).toBe(true);
    expect(parsed.maxObjects).toBe(2000);
  });

  it("leaves a plain statement untouched", () => {
    const parsed = parseS3QueryArgs(["SELECT 1"]);
    expect(parsed).toEqual({ sql: "SELECT 1", allowManyObjects: false, maxObjects: undefined });
  });
});
