/**
 * S3-SYNC-STOPPED-001 (AC5) — a stale backup must be ALERTABLE, not something
 * a person notices eight days later.
 *
 * Two aggregate gauges:
 *   duckbrain_s3_last_push_age_seconds — age of the OLDEST clean push;
 *   duckbrain_s3_unpushed_files        — local syncable files that push does
 *                                        not cover ("what a restore loses").
 *
 * The never-pushed state renders +Inf on purpose: an alert rule
 * `... > 3600` then fires on a mirror that has no push at all, instead of
 * reading 0 and calling it fresh.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Request, Response } from "express";
import { createHttpMetrics, type HealthSnapshot } from "./metrics";
import { savePushState } from "../s3/freshness";

const healthySnapshot = (): HealthSnapshot => ({
  status: "healthy",
  providers: [{ id: "lmstudio", healthy: true }],
  durationsMs: { embedding: 1, keys: 1, total: 2 },
});

/** Minimal res that captures the rendered exposition. */
function fakeRes(): { res: Response; captured: { body: string } } {
  const captured = { body: "" };
  const res = {
    setHeader: (): void => undefined,
    statusCode: 200,
    send: (body: string): void => {
      captured.body = body;
    },
    end: (body?: string): void => {
      if (body) captured.body = body;
    },
  } as unknown as Response;
  return { res, captured };
}

let tmp: string;
let nsRoot: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s3metrics001-"));
  nsRoot = path.join(tmp, "namespaces");
  fs.mkdirSync(nsRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function scrape(namespacesPath: string): Promise<string> {
  const metrics = createHttpMetrics({
    evaluateHealth: async () => healthySnapshot(),
    version: "1.2.0",
    nodeVersion: "v22.0.0",
    namespacesPath,
  });
  const { res, captured } = fakeRes();
  await metrics.handler({} as Request, res);
  return captured.body;
}

/** Value of one unlabelled sample, or NaN when absent. */
function sample(text: string, name: string): number {
  const line = text
    .split("\n")
    .find((l) => l.startsWith(`${name} `) && !l.startsWith("#"));
  return line ? Number.parseFloat(line.split(" ")[1]) : Number.NaN;
}

describe("S3-SYNC-STOPPED-001 — mirror freshness is scrapeable", () => {
  it("publishes the age of the last clean push and the unpushed file count", async () => {
    const ns = "hermes";
    const dir = path.join(nsRoot, ns);
    fs.mkdirSync(path.join(dir, "event"), { recursive: true });
    fs.writeFileSync(path.join(dir, "event", "a.jsonl"), "{}\n");
    fs.writeFileSync(path.join(dir, "event", "b.jsonl"), "{}\n");

    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    savePushState(nsRoot, {
      version: 1,
      ns,
      lastPushAt: twoHoursAgo,
      lastPushAttemptAt: twoHoursAgo,
      lastPushOk: true,
      uploaded: 2,
      skipped: 0,
      failedUploads: 0,
      failures: 0,
    });
    // Both files predate the push except ONE written after it: exactly one
    // file the mirror cannot contain.
    const older = new Date(Date.parse(twoHoursAgo) - 3600_000);
    fs.utimesSync(path.join(dir, "event", "a.jsonl"), older, older);
    const touched = new Date(Date.parse(twoHoursAgo) + 60_000);
    fs.utimesSync(path.join(dir, "event", "b.jsonl"), touched, touched);

    const text = await scrape(nsRoot);

    const age = sample(text, "duckbrain_s3_last_push_age_seconds");
    expect(age).toBeGreaterThanOrEqual(2 * 3600 - 5);
    expect(age).toBeLessThan(2 * 3600 + 60);
    expect(sample(text, "duckbrain_s3_unpushed_files")).toBe(1);
  });

  it("renders +Inf (never fresh) when no clean push is on record", async () => {
    const dir = path.join(nsRoot, "scheduler");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.jsonl"), "{}\n");

    const text = await scrape(nsRoot);

    const line = text
      .split("\n")
      .find((l) => l.startsWith("duckbrain_s3_last_push_age_seconds "));
    expect(line).toBeDefined();
    expect(line!).toContain("+Inf");
    expect(sample(text, "duckbrain_s3_unpushed_files")).toBe(1);
  });

  it("withdraws both series when there is no namespaces root to measure", async () => {
    const text = await scrape(path.join(tmp, "absent"));
    // The family declaration (HELP/TYPE) is static; what must be absent is the
    // SAMPLE — no value, not a 0 that would read as "nothing unpushed".
    expect(sample(text, "duckbrain_s3_last_push_age_seconds")).toBeNaN();
    expect(sample(text, "duckbrain_s3_unpushed_files")).toBeNaN();
  });
});
