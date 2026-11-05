/**
 * OBSDB-004 — git write-path instrumentation.
 *
 * `docs/observability-spec.md` §2 (blind spots #5 and #6) and §3.2: every write
 * schedules a debounced per-namespace commit and push, and every failure on
 * that path is a `console.warn` that is then swallowed (src/git/autocommit.ts
 * `asyncCommit` catch, `pushNamespaceAsync` catch). The result is the worst
 * kind of blind spot — a namespace can silently stop reaching its remote while
 * the daemon answers 200 and `/health` stays green, because JSONL durability
 * and git transport are independent. The queue depth (`asyncChains.size`) was
 * a Map size nothing read.
 *
 * This module owns the four families that close those two blind spots:
 *
 *   duckbrain_git_commit_total                        counter  — outcome=ok|fail
 *   duckbrain_git_push_total                          counter  — outcome=ok|fail
 *   duckbrain_git_commit_queue_depth                  gauge    — asyncChains.size
 *   duckbrain_git_last_push_success_timestamp_seconds gauge    — unix seconds
 *
 * PROCESS-WIDE, NOT PER-APP — the same rationale as `src/embedding/metrics.ts`:
 * the facts are produced in the git layer, which is exercised by the HTTP
 * daemon, by MCP stdio and by one-shot CLI runs (`duckbrain remember` commits
 * and pushes before it exits). The counters are module singletons created with
 * `registers: []` — importing this module never touches `Registry.globalRegistry`
 * — and `registerGitMetrics()` attaches the SAME instances to each per-app
 * scrape registry. A CLI-only process reads them through the metric objects
 * directly; a daemon renders them on `GET /metrics`.
 *
 * LABEL DISCIPLINE (spec §3, hard rules): the ONLY label is `outcome`, and its
 * domain is the two-value enum below. A NAMESPACE NAME MUST NEVER BE A LABEL —
 * namespaces are user-chosen and unbounded, and a per-namespace series is
 * exactly the cardinality (and PII) explosion the spec forbids. The `namespacePath`
 * argument on the record functions exists only in log-free form: nothing here
 * reads it, and a test asserts a namespace name cannot reach the exposition.
 *
 * ACCOUNTING SEMANTICS (deliberate, so the counters mean one thing):
 *   - A commit OPERATION is one traversal of the commit path, counted ok when
 *     it completes without throwing (including "nothing staged" — the operation
 *     succeeded; it just had no work) and fail when it throws. It does not
 *     count commit OBJECTS: a batched flush that sweeps 100 lines is one
 *     operation, which is the unit the debounce actually schedules.
 *   - A push OPERATION is one real `git push` invocation. GATE SKIPS (s3
 *     disabled, pushOnCommit off, interval floor, HEAD unchanged, no remote)
 *     are NOT push operations and are NOT counted — counting a skip as `ok`
 *     would make "are writes landing?" answer yes for a deployment that never
 *     pushes, and counting it as `fail` would page on the default config.
 *   - `last_push_success_timestamp_seconds` is set ONLY on a real success, so
 *     `time() - value` is the honest staleness of the last landed push. A
 *     broken remote therefore leaves the sample frozen while the fail counter
 *     climbs — that pair is the alert.
 */

import { Counter, Gauge, type Registry } from "prom-client";

export const GIT_COMMIT_TOTAL = "duckbrain_git_commit_total";
export const GIT_PUSH_TOTAL = "duckbrain_git_push_total";
export const GIT_COMMIT_QUEUE_DEPTH = "duckbrain_git_commit_queue_depth";
export const GIT_LAST_PUSH_SUCCESS_SECONDS =
  "duckbrain_git_last_push_success_timestamp_seconds";

/** The four families this module owns, in exposition order. */
export const GIT_METRIC_NAMES = [
  GIT_COMMIT_TOTAL,
  GIT_PUSH_TOTAL,
  GIT_COMMIT_QUEUE_DEPTH,
  GIT_LAST_PUSH_SUCCESS_SECONDS,
] as const;

/** The fixed `outcome` label domain (spec §3.2). */
export const GIT_OUTCOMES = ["ok", "fail"] as const;
export type GitOutcome = (typeof GIT_OUTCOMES)[number];

/**
 * One completed commit operation, by outcome.
 *
 * `outcome` is the only label: a namespace label would be unbounded and
 * user-controlled, and the operator question ("are writes landing?") is
 * aggregate by construction — per-namespace debugging is a log question.
 */
export const gitCommits = new Counter({
  name: GIT_COMMIT_TOTAL,
  help: "Commit operations on the per-namespace git write path by outcome (ok|fail); aggregated, never labelled by namespace.",
  labelNames: ["outcome"],
  registers: [],
});

/** One real `git push` invocation, by outcome. Gate skips are not counted. */
export const gitPushes = new Counter({
  name: GIT_PUSH_TOTAL,
  help: "Real git push invocations from the namespace write path by outcome (ok|fail); gate skips and unchanged-HEAD short-circuits are not counted.",
  labelNames: ["outcome"],
  registers: [],
});

/**
 * Sampler for the in-flight commit/push chain count.
 *
 * The state lives in `src/git/autocommit.ts` (`asyncChains`, one chain per
 * namespace, OPS-006). This module must not import it — autocommit imports
 * THIS module to record outcomes, and an import back would be a cycle — so the
 * owner installs a sampler at module load (`setCommitQueueDepthSampler`) and
 * the gauge calls it at scrape time. Until a sampler is installed the depth
 * reads 0, which is the truth for a process that never scheduled a commit.
 */
let queueDepthSampler: (() => number) | null = null;

/**
 * Register the in-flight chain sampler (called once, by autocommit.ts).
 * Returns the previous sampler so a test can restore it.
 */
export function setCommitQueueDepthSampler(
  sampler: (() => number) | null,
): (() => number) | null {
  const previous = queueDepthSampler;
  queueDepthSampler = sampler;
  return previous;
}

/** Read the current depth through the installed sampler, defensively. */
export function commitQueueDepth(): number {
  try {
    const value = queueDepthSampler ? queueDepthSampler() : 0;
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : 0;
  } catch {
    // A failing sampler must not turn a scrape into an error page.
    return 0;
  }
}

/**
 * In-flight commit+push chains, sampled on scrape.
 *
 * A `collect` callback rather than a periodically-set value: the chain map is
 * mutated by the write path, and a scrape is the only moment anything asks. An
 * unref'd interval writing the gauge would keep a CLI process alive for a fact
 * nobody is reading, which is why the spec asks for a collect callback.
 */
export const gitCommitQueueDepth = new Gauge({
  name: GIT_COMMIT_QUEUE_DEPTH,
  help: "In-flight async commit+push chains (asyncChains.size) sampled at scrape time; a sustained non-zero value means the git write path is backing up.",
  registers: [],
  collect(this: Gauge<"">) {
    this.set(commitQueueDepth());
  },
});

/**
 * Unix seconds of the last SUCCESSFUL push.
 *
 * Never initialised: a process that has not pushed has no value, and
 * `time() - <frozen sample>` is the staleness the alert uses. Writing a
 * fabricated 0 at startup would make a fresh daemon look 56 years stale.
 */
export const gitLastPushSuccess = new Gauge({
  name: GIT_LAST_PUSH_SUCCESS_SECONDS,
  help: "Unix timestamp (seconds) of the last successful namespace push; the alert is time() - value > 3600 (a frozen value while git_push_total{outcome=\"fail\"} climbs means the remote is unreachable).",
  registers: [],
});

/** Normalize an outcome onto the fixed enum; anything else is a failure. */
export function gitOutcomeLabel(outcome: unknown): GitOutcome {
  return outcome === "ok" ? "ok" : "fail";
}

/** Record one commit operation outcome. Never throws. */
export function recordGitCommit(outcome: GitOutcome): void {
  try {
    gitCommits.inc({ outcome: gitOutcomeLabel(outcome) });
  } catch {
    /* telemetry never breaks the write path */
  }
}

export function recordGitCommitSuccess(): void {
  recordGitCommit("ok");
}

export function recordGitCommitFailure(): void {
  recordGitCommit("fail");
}

/**
 * Record one push operation outcome. A success also stamps the staleness
 * gauge; a failure deliberately leaves the previous stamp untouched — that
 * freeze is what `time() - duckbrain_git_last_push_success_timestamp_seconds`
 * measures.
 */
export function recordGitPush(outcome: GitOutcome, atMs?: number): void {
  try {
    const label = gitOutcomeLabel(outcome);
    gitPushes.inc({ outcome: label });
    if (label === "ok") {
      const at = typeof atMs === "number" && Number.isFinite(atMs) ? atMs : Date.now();
      gitLastPushSuccess.set(at / 1000);
    }
  } catch {
    /* telemetry never breaks the push path */
  }
}

export function recordGitPushSuccess(atMs?: number): void {
  recordGitPush("ok", atMs);
}

export function recordGitPushFailure(): void {
  recordGitPush("fail");
}

/**
 * Attach the process-wide git metrics to a scrape registry.
 *
 * Registration (not duplication) is what makes the SAME instances visible on
 * `GET /metrics`. Idempotent: a second call for an already-registered registry
 * is a no-op, so repeated `createHttpServer()` calls (tests, embedders) cannot
 * throw "already registered".
 */
export function registerGitMetrics(registry: Registry): void {
  // Two homogeneous loops rather than one mixed array: the labelled counters
  // and the unlabelled gauges have different Metric<> generics, and a mixed
  // literal would need a cast to satisfy the type checker.
  for (const counter of [gitCommits, gitPushes]) {
    try {
      registry.registerMetric(counter);
    } catch {
      // Same metric object already registered on this registry — nothing to do.
    }
  }
  for (const gauge of [gitCommitQueueDepth, gitLastPushSuccess]) {
    try {
      registry.registerMetric(gauge);
    } catch {
      // Same metric object already registered on this registry — nothing to do.
    }
  }
}

/**
 * Reset the counters and REMOVE the success stamp (test seam).
 *
 * Production never calls it: a restart is the only reset a scrape should see.
 * The stamp is removed rather than zeroed — a process that never pushed has no
 * timestamp (zero would read as 56 years stale), and by design
 * `duckbrain_git_last_push_success_timestamp_seconds` has no sample until a
 * push lands. The depth gauge is NOT reset: it is sampled, not stored.
 */
export function resetGitMetrics(): void {
  gitCommits.reset();
  gitPushes.reset();
  gitLastPushSuccess.remove();
}
