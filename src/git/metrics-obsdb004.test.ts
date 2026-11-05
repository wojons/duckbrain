/**
 * OBSDB-004 — the git write path on the scrape surface.
 *
 * What is under test (`docs/observability-spec.md` §2 blind spots #5-#6, §3.2):
 *   1. the four families exist with the documented names/types, `outcome` is
 *      the ONLY label, and a namespace name can never reach the exposition
 *      (aggregate-only, per the spec's label discipline);
 *   2. the queue-depth gauge is SAMPLED at scrape time (collect callback) and
 *      is always a finite, non-negative sample — a broken sampler reads 0
 *      instead of failing the scrape;
 *   3. the push-success stamp is set only by a real success, so a failing
 *      remote freezes it while the fail counter climbs — the staleness pair the
 *      alert (`time() - value > 3600`) is built from;
 *   4. END TO END through the production HTTP app: one POSTed memory commits
 *      and pushes (ok outcomes + a moving stamp), a broken remote turns the
 *      next write into `push_total{outcome="fail"}` while the remote receives
 *      nothing, and the depth gauge reads non-zero while a burst is in flight.
 *
 * Hermetic by construction: scratch namespaces root, scratch config file, a
 * `file://` bare remote with a post-receive hook as the push counter, and the
 * host's global git config deliberately isolated (the dev box sets
 * `core.hooksPath`, which would replace the bare remote's own hooks —
 * INT-CI-030 / PUSH-001). The S3 object-store hook is pointed at a closed
 * loopback port so enabling `pushOnCommit` cannot reach a real endpoint.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { Registry, register as globalRegistry } from "prom-client";

import { createHttpServer } from "../cli/http";
import { createHttpMetrics } from "../http/metrics";
import { drainAsyncCommits, pushGateStates } from "./autocommit";
import {
  GIT_METRIC_NAMES,
  commitQueueDepth,
  recordGitCommit,
  recordGitCommitFailure,
  recordGitCommitSuccess,
  recordGitPushFailure,
  recordGitPushSuccess,
  registerGitMetrics,
  resetGitMetrics,
  setCommitQueueDepthSampler,
} from "./metrics";

/** Isolate the host's global git config (identity, core.hooksPath). */
const scratchGitConfig = fs.mkdtempSync(
  path.join(os.tmpdir(), "duckbrain-obsdb004-gitcfg-"),
);
process.env.GIT_CONFIG_GLOBAL = path.join(scratchGitConfig, "global");
process.env.GIT_CONFIG_SYSTEM = path.join(scratchGitConfig, "system");
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
fs.writeFileSync(process.env.GIT_CONFIG_SYSTEM, "");

const HEALTHY = {
  status: "healthy" as const,
  providers: [],
  durationsMs: { embedding: 0, keys: 0, total: 0 },
};

/** Read one sample value out of a Prometheus text exposition body. */
function sampleValue(
  text: string,
  name: string,
  labelPart?: string,
): number | null {
  const prefix = labelPart ? `${name}{${labelPart}}` : name;
  const line = text
    .split("\n")
    .find((candidate) => candidate.startsWith(`${prefix} `));
  if (!line) return null;
  const value = Number(line.slice(line.lastIndexOf(" ") + 1));
  return Number.isFinite(value) ? value : null;
}

describe("OBSDB-004: the families are aggregate-only and never invent a sample", () => {
  beforeEach(() => {
    resetGitMetrics();
  });

  it("renders both outcomes of both counters with outcome as the only label", async () => {
    const registry = new Registry();
    registerGitMetrics(registry);
    // Idempotent: a second createHttpServer() in one process must not throw.
    registerGitMetrics(registry);

    recordGitCommitSuccess();
    recordGitCommitFailure();
    recordGitPushSuccess();
    recordGitPushFailure();

    const text = await registry.metrics();
    expect(text).toMatch(/^duckbrain_git_commit_total\{outcome="ok"\} 1$/m);
    expect(text).toMatch(/^duckbrain_git_commit_total\{outcome="fail"\} 1$/m);
    expect(text).toMatch(/^duckbrain_git_push_total\{outcome="ok"\} 1$/m);
    expect(text).toMatch(/^duckbrain_git_push_total\{outcome="fail"\} 1$/m);

    // Aggregate-only: no label carries a path, a namespace, a remote or an
    // error string — the spec's cardinality/PII rule.
    const labelNames = text
      .split("\n")
      .filter((line) => line.startsWith("# TYPE duckbrain_git_"))
      .length;
    expect(labelNames).toBe(4);
    expect(text).not.toMatch(/namespace=/);
    expect(text).not.toMatch(/path=/);
    expect(text).not.toMatch(/remote=/);
    expect(text).not.toMatch(/error=/);
  });

  it("collapses an unknown outcome onto fail instead of inventing a label value", async () => {
    const registry = new Registry();
    registerGitMetrics(registry);
    recordGitCommitSuccess();
    recordGitPushSuccess();
    // A caller cannot invent a third outcome: anything that is not `ok` is a
    // failure, so an unknown string lands in the fail series, never a new one.
    recordGitCommit("exploded" as unknown as "ok");

    const text = await registry.metrics();
    expect(sampleValue(text, "duckbrain_git_commit_total", 'outcome="fail"')).toBe(1);
    // Nothing but the two documented outcomes can appear.
    const outcomes = text
      .split("\n")
      .filter((line) => /^duckbrain_git_(commit|push)_total\{/.test(line))
      .map((line) => /outcome="([^"]+)"/.exec(line)?.[1]);
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      expect(["ok", "fail"]).toContain(outcome);
    }
    // Nothing invented: no third outcome value anywhere in the exposition.
    expect(text).not.toMatch(/outcome="(?!ok"|fail")/);
  });

  it("stamps the last-push-success gauge ONLY on a real success", async () => {
    const registry = new Registry();
    registerGitMetrics(registry);

    // No success yet: no sample at all (a fabricated 0 would read as 56 years
    // stale the moment the daemon boots).
    let text = await registry.metrics();
    expect(sampleValue(text, "duckbrain_git_last_push_success_timestamp_seconds")).toBeNull();

    const before = Date.now();
    recordGitPushSuccess();
    const after = Date.now();
    text = await registry.metrics();
    const stamped = sampleValue(
      text,
      "duckbrain_git_last_push_success_timestamp_seconds",
    );
    expect(stamped).not.toBeNull();
    expect(stamped!).toBeGreaterThanOrEqual(before / 1000 - 1);
    expect(stamped!).toBeLessThanOrEqual(after / 1000 + 1);

    // A failing push moves the counter and leaves the stamp frozen: that
    // freeze IS the staleness signal.
    recordGitPushFailure();
    text = await registry.metrics();
    expect(
      sampleValue(text, "duckbrain_git_last_push_success_timestamp_seconds"),
    ).toBe(stamped);
    expect(sampleValue(text, "duckbrain_git_push_total", 'outcome="fail"')).toBe(1);
  });

  it("samples the queue depth at scrape time and never fails a scrape", async () => {
    const previous = setCommitQueueDepthSampler(() => 3);
    try {
      const registry = new Registry();
      registerGitMetrics(registry);
      let text = await registry.metrics();
      expect(sampleValue(text, "duckbrain_git_commit_queue_depth")).toBe(3);

      // A sampler that throws, returns a negative, or returns NaN must read 0 —
      // telemetry never turns a scrape into an error page.
      for (const sampler of [
        () => {
          throw new Error("sampler exploded");
        },
        () => -4,
        () => Number.NaN,
      ]) {
        setCommitQueueDepthSampler(sampler as () => number);
        text = await registry.metrics();
        expect(sampleValue(text, "duckbrain_git_commit_queue_depth")).toBe(0);
      }
      expect(commitQueueDepth()).toBe(0);
      // …and the same collector is what a CLI-only process reads, unpolluted.
      expect(Number.isFinite(commitQueueDepth())).toBe(true);
    } finally {
      setCommitQueueDepthSampler(previous);
    }
  });

  it("does not leak into prom-client's global registry", () => {
    // Module singletons are created with `registers: []`, like the embedding
    // counters: importing the module must never pollute Registry.globalRegistry
    // (which other processes' defaults would then render).
    const globalNames = globalRegistry.getMetricsAsArray().map((metric) => metric.name);
    for (const name of GIT_METRIC_NAMES) {
      expect(globalNames).not.toContain(name);
    }
  });

  it("reaches the daemon exposition surface with all four families", async () => {
    const metrics = createHttpMetrics({ evaluateHealth: async () => HEALTHY });
    recordGitCommitSuccess();
    recordGitPushSuccess();
    const text = await metrics.render();
    for (const name of GIT_METRIC_NAMES) {
      expect(text).toMatch(new RegExp(`^# TYPE ${name} `, "m"));
    }
    // The depth gauge renders a sample with no traffic — it is sampled, not
    // accumulated, so 0 in-flight is a real observation.
    expect(sampleValue(text, "duckbrain_git_commit_queue_depth")).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// End to end: the production HTTP app, a real write, a real file:// remote.
// ───────────────────────────────────────────────────────────────────────────

let tmp: string;
let nsRoot: string;
let previousNsRoot: string | undefined;
/** AWS env this file sets for the (dead) object-store hook, plus its prior values. */
const AWS_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_EC2_METADATA_DISABLED",
  "AWS_MAX_ATTEMPTS",
] as const;
const previousAwsEnv: Partial<Record<(typeof AWS_KEYS)[number], string>> = {};
let cfgPath: string;
let cfgSnapshot: string | null;
let server: Server;
let port: number;

function git(args: string[], cwd: string): string {
  return execSync(`git ${args.join(" ")}`, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

function writeConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(cfgPath, JSON.stringify(config), "utf-8");
}

/** Scratch config: autopush ON, batching OFF, durability fsync, dead S3 endpoint. */
function autopushConfig(): void {
  writeConfig({
    durability: { defaultMode: "fsync", overrides: {} },
    gitBatching: { enabled: false, maxLines: 0, maxSeconds: 0 },
    s3: {
      enabled: true,
      pushOnCommit: true,
      intervalSec: 0,
      // A closed loopback port: the object-store hook must never reach a real
      // endpoint in a test (it fails fast and is swallowed by design).
      endpoint: "http://127.0.0.1:9",
      region: "us-east-1",
      bucket: "obsdb004-test",
      prefix: "obsdb004",
      forcePathStyle: true,
    },
  });
}

/** A namespace repo with a file:// bare remote and a post-receive counter. */
function makeNamespace(
  ns: string,
  opts: { preCommitSleepSec?: number } = {},
): { dir: string; bare: string; hookLog: string } {
  const dir = path.join(nsRoot, ns);
  fs.mkdirSync(dir, { recursive: true });
  execSync(`git init -q -b master "${dir}"`);
  git(["config", "user.email", "obsdb004@example.test"], dir);
  git(["config", 'user.name "OBSDB-004 Test"'], dir);

  const bare = path.join(tmp, `${ns}.git`);
  execSync(`git init -q --bare "${bare}"`);
  const hookLog = path.join(tmp, `${ns}.pushes.log`);
  const hook = path.join(bare, "hooks", "post-receive");
  fs.writeFileSync(
    hook,
    `#!/bin/sh\nwhile read _old new _ref; do echo "$new" >> '${hookLog}'; done\n`,
  );
  fs.chmodSync(hook, 0o755);

  if (opts.preCommitSleepSec) {
    const pre = path.join(dir, ".git", "hooks", "pre-commit");
    fs.writeFileSync(pre, `#!/bin/sh\nsleep ${opts.preCommitSleepSec}\n`);
    fs.chmodSync(pre, 0o755);
  }

  git(["remote", "add", "s3daily", bare], dir);
  fs.writeFileSync(path.join(dir, "seed.jsonl"), "{}\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "init"], dir);
  return { dir, bare, hookLog };
}

function pushCount(hookLog: string): number {
  if (!fs.existsSync(hookLog)) return 0;
  return fs
    .readFileSync(hookLog, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "").length;
}

function scraped(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path: "/metrics" },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function postMemory(ns: string, key: string): Promise<number> {
  const payload = JSON.stringify({
    key,
    domain: "concept",
    content: "obsdb004 http write",
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/api/memories?namespace=${ns}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

beforeAll(async () => {
  cfgPath = process.env.DUCKBRAIN_CONFIG_PATH as string;
  cfgSnapshot = fs.existsSync(cfgPath)
    ? fs.readFileSync(cfgPath, "utf-8")
    : null;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-obsdb004-"));
  nsRoot = path.join(tmp, "namespaces");
  fs.mkdirSync(nsRoot, { recursive: true });
  // The serializer/write path resolves the storage root from the ENVIRONMENT
  // (resolveNamespacesPath), not from createHttpServer's option — so the env is
  // what must point at this scratch root for a POSTed memory to land in a repo
  // this test controls. The option is still passed for the route/read half.
  previousNsRoot = process.env.DUCKBRAIN_NAMESPACES_PATH;
  process.env.DUCKBRAIN_NAMESPACES_PATH = nsRoot;
  autopushConfig();

  // The object-store hook needs credentials to get as far as the (dead)
  // endpoint; the SDK's instance-metadata probe is disabled so nothing hangs.
  // These are SAVED and restored: this file shares a worker process with the
  // real-S3 suites, and a leaked placeholder key turns their requests into 403s
  // (observed: src/s3/client-timeout-s3git006.test.ts red on the first run).
  for (const key of AWS_KEYS) {
    const prior = process.env[key];
    if (prior !== undefined) previousAwsEnv[key] = prior;
    delete process.env[key];
  }
  process.env.AWS_ACCESS_KEY_ID = "obsdb004";
  process.env.AWS_SECRET_ACCESS_KEY = "obsdb004";
  process.env.AWS_EC2_METADATA_DISABLED = "true";
  process.env.AWS_MAX_ATTEMPTS = "1";

  const app = createHttpServer({ authConfig: { type: "none" }, namespacesPath: nsRoot });
  server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  port = (server.address() as AddressInfo).port;
  expect(port).not.toBe(3000);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await drainAsyncCommits(20_000);
  if (cfgSnapshot === null) fs.rmSync(cfgPath, { force: true });
  else fs.writeFileSync(cfgPath, cfgSnapshot, "utf-8");
  if (previousNsRoot === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  else process.env.DUCKBRAIN_NAMESPACES_PATH = previousNsRoot;
  for (const key of AWS_KEYS) {
    const prior = previousAwsEnv[key];
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  pushGateStates.clear();
  autopushConfig();
});

afterEach(async () => {
  await drainAsyncCommits(20_000);
});

describe("OBSDB-004: a real memory write commits and pushes, visible over HTTP", () => {
  it("counts the commit and the push as ok and moves the success stamp", async () => {
    const ns = makeNamespace("obsdb004-happy");
    const before = await scraped();
    const commitsBefore = sampleValue(before, "duckbrain_git_commit_total", 'outcome="ok"') ?? 0;
    const pushesBefore = sampleValue(before, "duckbrain_git_push_total", 'outcome="ok"') ?? 0;

    expect(await postMemory("obsdb004-happy", "/obsdb004/happy")).toBe(201);
    await drainAsyncCommits(20_000);

    const after = await scraped();
    const commitsOk = sampleValue(after, "duckbrain_git_commit_total", 'outcome="ok"') ?? 0;
    const pushesOk = sampleValue(after, "duckbrain_git_push_total", 'outcome="ok"') ?? 0;
    const stamped = sampleValue(after, "duckbrain_git_last_push_success_timestamp_seconds");

    expect(commitsOk).toBeGreaterThan(commitsBefore);
    expect(pushesOk).toBeGreaterThan(pushesBefore);
    expect(stamped).not.toBeNull();
    expect(Date.now() / 1000 - stamped!).toBeLessThan(120);

    // The push was REAL: the bare remote's post-receive hook saw a new tip.
    expect(pushCount(ns.hookLog)).toBeGreaterThan(0);
    // Depth sampled after the drain: nothing in flight.
    expect(sampleValue(after, "duckbrain_git_commit_queue_depth")).toBe(0);
  });

  it("a broken remote turns the next write into fail and freezes the stamp", async () => {
    const ns = makeNamespace("obsdb004-broken");

    // 1. A healthy baseline: the stamp moves.
    expect(await postMemory("obsdb004-broken", "/obsdb004/before")).toBe(201);
    await drainAsyncCommits(20_000);
    const healthy = await scraped();
    const goodStamp = sampleValue(healthy, "duckbrain_git_last_push_success_timestamp_seconds");
    expect(goodStamp).not.toBeNull();
    const pushesThatLanded = pushCount(ns.hookLog);
    expect(pushesThatLanded).toBeGreaterThan(0);

    // 2. Break the remote the way an operator would (a moved/unreachable
    //    repository), then write again.
    git(["remote", "set-url", "s3daily", path.join(tmp, "gone.git")], ns.dir);
    expect(await postMemory("obsdb004-broken", "/obsdb004/after")).toBe(201);
    await drainAsyncCommits(20_000);

    const broken = await scraped();
    const failedPushes = sampleValue(broken, "duckbrain_git_push_total", 'outcome="fail"') ?? 0;
    expect(failedPushes).toBeGreaterThan(0);

    // The stamp is FROZEN — this is what `time() - value > 3600` measures. A
    // failed push must never look like a success.
    expect(
      sampleValue(broken, "duckbrain_git_last_push_success_timestamp_seconds"),
    ).toBe(goodStamp);
    // …and staleness is strictly growing while no push lands.
    const staleness1 = Date.now() / 1000 - goodStamp!;
    expect(staleness1).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const staleness2 = Date.now() / 1000 - goodStamp!;
    expect(staleness2).toBeGreaterThan(staleness1);

    // The falsifier for the whole family: the counter moved but the REMOTE did
    // not — the failed push delivered nothing.
    expect(pushCount(ns.hookLog)).toBe(pushesThatLanded);
  });

  it("reads a non-zero queue depth while a burst of writes is in flight, 0 after", async () => {
    // A pre-commit hook that sleeps holds the chain open: the depth gauge is
    // sampled at scrape time, so this is the in-flight window an operator sees.
    const names = ["obsdb004-burst-a", "obsdb004-burst-b", "obsdb004-burst-c"];
    for (const ns of names) makeNamespace(ns, { preCommitSleepSec: 1.2 });

    const statuses = await Promise.all(
      names.map((ns) => postMemory(ns, `/obsdb004/${ns}`)),
    );
    expect(statuses).toEqual([201, 201, 201]);

    const during = await scraped();
    const depth = sampleValue(during, "duckbrain_git_commit_queue_depth");
    expect(depth).not.toBeNull();
    expect(Number.isInteger(depth)).toBe(true);
    expect(depth!).toBeGreaterThanOrEqual(1);

    await drainAsyncCommits(20_000);
    const after = await scraped();
    expect(sampleValue(after, "duckbrain_git_commit_queue_depth")).toBe(0);
    // The burst still committed: being slow is not being lost.
    expect(sampleValue(after, "duckbrain_git_commit_total", 'outcome="ok"')).toBeGreaterThan(0);
  });
});
