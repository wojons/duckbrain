/**
 * Git Auto-Commit Helper
 *
 * Ensures per-namespace git repos are initialized and data is committed.
 *
 * Commits are BATCHED: each write lands in the working tree (JSONL) immediately,
 * but the git commit itself is debounced (gitBatching.maxSeconds, default 30s)
 * and line-capped (gitBatching.maxLines, default 100). A burst of N writes
 * therefore produces 1 commit, not N — each commit stores the FULL jsonl file
 * as a loose git object, so per-write commits balloon namespace .git repos
 * (85k commits ≈ 490GB of loose objects in the coding-hermes namespace,
 * 2026-08-06; the scheduler fleet-sync alone posts ~157 memories per 5-min
 * cycle). JSONL is the source of truth; git history is best-effort and the
 * next write sweeps up anything a crashed process left uncommitted
 * (git add -A stages everything).
 *
 * OPS-006 — the SERVING path never blocks the event loop. Every commit/push
 * reachable from a namespace write (the debounced timer, the line-cap flush,
 * the first-write git-init) goes through `execFile` and is tracked in
 * `asyncChains`, so a slow or failing `git push` (git-remote-s3 builds a
 * bundle + pack-objects inside the daemon, bounded at PUSH_TIMEOUT_MS) can no
 * longer stall unrelated handlers such as /health. The ONE remaining
 * synchronous spawn is the process-exit flush (`commitNamespaceWithParams`
 * with `batching.enabled=false` aside, `flushNamespaceCommit` /
 * `flushAllCommits`): a short-lived CLI (`duckbrain remember` → commit → exit)
 * must still commit AND push before it exits, and a process 'exit' handler
 * cannot await (DOGFOOD-005 + AUTOPUSH-001 contracts). A namespace that dies
 * mid-async-push loses git history only — the JSONL is already on disk and the
 * next write sweeps it up.
 */

import { execFile, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { getConfig } from "../config";
import { maybeSyncOnCommit } from "../s3";
import { buildClient } from "../s3/client";
import type { S3Config } from "../s3/config";
import {
  isDuplicateRefPushError,
  parseS3RemoteUrl,
  repairAndRetryPushOnDuplicate,
} from "./s3-repair";

export interface BatchingParams {
  maxLines: number;
  maxSeconds: number;
  enabled: boolean;
}

const DEFAULT_PARAMS: BatchingParams = {
  maxLines: 100,
  maxSeconds: 30,
  enabled: true,
};

/** Hard bound for a single `git push` (async and exit-flush paths share it). */
const PUSH_TIMEOUT_MS = 30_000;

/**
 * Per-namespace autopush gate state (PUSH-001). Keyed by absolute namespace
 * path. `inFlight` coalesces concurrent serving-path pushes (single-flight:
 * a second caller awaits the SAME push instead of spawning a competing
 * full-history bundle — git-remote-s3 has no server side, so every push
 * rebuilds a full-history bundle). `lastAttemptAt` is set only when an
 * attempt actually starts (gate passed), never on skips. `lastPushedHead`
 * records the HEAD of the last SUCCESSFUL push; unchanged HEADs are skipped
 * and failures leave it untouched so the next gate-open retries.
 */
interface PushGateState {
  lastAttemptAt: number;
  lastPushedHead: string | null;
  inFlight: Promise<void> | null;
}

const pushGateStates = new Map<string, PushGateState>();

export { pushGateStates };

function pushGateStateFor(namespacePath: string): PushGateState {
  let state = pushGateStates.get(namespacePath);
  if (!state) {
    state = { lastAttemptAt: 0, lastPushedHead: null, inFlight: null };
    pushGateStates.set(namespacePath, state);
  }
  return state;
}

/**
 * Evaluate the PUSH-001 autopush gate for a namespace. Pure decision over
 * config + last-attempt state; every skip is silent (the push is
 * best-effort — the next commit flush re-opens the gate).
 */
export function evaluatePushGate(
  s3: S3Config | undefined,
  state: Pick<PushGateState, "lastAttemptAt">,
  now: number,
): boolean {
  // Default deployment: s3 disabled or pushOnCommit unset → the autopush
  // hook is genuinely inert (the old comment claimed this; now it is true).
  if (!s3?.enabled || !s3.pushOnCommit) return false;
  // Per-namespace coalescing floor: intervalSec <= 0 disables the floor.
  if (s3.intervalSec > 0 && now - state.lastAttemptAt < s3.intervalSec * 1000) {
    return false;
  }
  return true;
}

/**
 * Hard bound for awaiting in-flight async git work during shutdown. A drain is
 * a courtesy to work already spawned (never a durability mechanism — the JSONL
 * record is already on disk), so it must always return: bounded, never hanging.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

interface PendingCommit {
  timer: NodeJS.Timeout;
  lines: number;
  message: string;
}

const pending = new Map<string, PendingCommit>();

/**
 * In-flight async commit+push chains, keyed by namespace path (OPS-006).
 *
 * Exactly one chain per namespace: concurrent writes to the same namespace
 * queue behind each other instead of racing on the same git index, and the
 * tail promise doubles as the shutdown-drain handle. Chains never reject —
 * the git write path is best-effort by contract.
 */
const asyncChains = new Map<string, Promise<void>>();

/** Tracks whether the process 'exit' flush hook has been registered. */
let exitFlushRegistered = false;

function batchingParams(): BatchingParams {
  try {
    const cfg = getConfig();
    const gb = cfg.gitBatching as
      { maxLines?: number; maxSeconds?: number; enabled?: boolean } | undefined;
    if (!gb) return DEFAULT_PARAMS;
    return {
      maxLines: gb.maxLines ?? DEFAULT_PARAMS.maxLines,
      maxSeconds: gb.maxSeconds ?? DEFAULT_PARAMS.maxSeconds,
      enabled: gb.enabled ?? DEFAULT_PARAMS.enabled,
    };
  } catch {
    // Config unreadable (wrong cwd, missing file) — fall back to defaults.
    return DEFAULT_PARAMS;
  }
}

/**
 * Run a git subcommand WITHOUT blocking the event loop (OPS-006).
 *
 * `execFile` (never a shell) so commit messages, branch names and remote names
 * are passed as argv and need no quoting. The child runs on the libuv thread
 * pool the same way; what changes versus `execSync` is that the JS thread is
 * free to serve other requests while git works.
 */
function gitAsync(
  args: string[],
  cwd: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        ...(options.timeoutMs !== undefined
          ? { timeout: options.timeoutMs }
          : {}),
        ...(options.env ? { env: options.env } : {}),
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.toString());
      },
    );
  });
}

/**
 * Async twin of `immediateCommit` — the variant the serving path uses.
 *
 * Same steps, same order, same best-effort swallowing, but every git call is
 * asynchronous so the event loop keeps running while git (and git-remote-s3)
 * works. Never rejects.
 */
async function asyncCommit(
  namespacePath: string,
  message: string,
): Promise<void> {
  try {
    // Init git repo if it doesn't exist
    const gitDir = path.join(namespacePath, ".git");
    if (!fs.existsSync(gitDir)) {
      await gitAsync(["init"], namespacePath);
    }

    // Ensure git user identity is set (newly inited repos + pre-existing ones)
    try {
      await gitAsync(["config", "user.email"], namespacePath);
    } catch {
      await gitAsync(
        ["config", "user.email", "duckbrain@localhost.localdomain"],
        namespacePath,
      );
    }
    try {
      await gitAsync(["config", "user.name"], namespacePath);
    } catch {
      await gitAsync(["config", "user.name", "DuckBrain"], namespacePath);
    }

    // Stage all changes
    await gitAsync(["add", "-A"], namespacePath);

    // Check if there are staged changes — git diff --cached --quiet exits 1 if
    // there are.
    let staged = false;
    try {
      await gitAsync(["diff", "--cached", "--quiet"], namespacePath);
      // Exit code 0 = no staged changes, nothing to commit
    } catch {
      // Exit code 1 = there ARE staged changes
      staged = true;
    }
    if (staged) {
      await gitAsync(["commit", "-m", message], namespacePath);
    }

    // Native S3 push hook — gated by s3.enabled && s3.pushOnCommit (PUSH-001:
    // default config = zero pushes), interval-coalesced and single-flight.
    // Fire-and-forget: never blocks or fails the write path.
    maybeSyncOnCommit(namespacePath);
    // AUTOPUSH-001: push the namespace repo to the s3daily remote after each
    // commit flush (git-remote-s3 → s3://duckbrain/current/git/<ns>), gated
    // by the PUSH-001 config checks, never holding the event loop for the
    // bundle + pack-objects duration.
    await pushNamespaceAsync(namespacePath);
  } catch (error) {
    // Log but don't fail the write — git is best-effort
    console.warn(
      `[Git] Auto-commit warning for ${namespacePath}: ${(error as Error).message}`,
    );
  }
}

/**
 * Queue the async commit+push for a namespace and return the tail of its
 * chain. Work for the same namespace is serialized (no two `git add -A` runs
 * racing on one index); different namespaces run concurrently.
 *
 * The returned promise never rejects, so a caller that ignores it (the
 * debounced timer, the line-cap flush) cannot produce an unhandled rejection.
 */
function scheduleAsyncCommit(
  namespacePath: string,
  message: string,
): Promise<void> {
  let settled: Promise<void>;
  try {
    const previous = asyncChains.get(namespacePath) ?? Promise.resolve();
    settled = previous
      .then(() => asyncCommit(namespacePath, message))
      .catch(() => {
        // asyncCommit swallows its own failures; this guard keeps the chain
        // alive if it ever throws synchronously.
      });
  } catch (error) {
    console.warn(
      `[Git] Auto-commit warning for ${namespacePath}: ${(error as Error).message}`,
    );
    return Promise.resolve();
  }
  asyncChains.set(namespacePath, settled);
  // Drop the entry once settled so the drain can tell in-flight from history.
  void settled.then(() => {
    if (asyncChains.get(namespacePath) === settled) {
      asyncChains.delete(namespacePath);
    }
  });
  return settled;
}

/**
 * Await every in-flight async commit+push, bounded by `timeoutMs` (OPS-006).
 *
 * Used by the HTTP daemon's shutdown so a commit that is already running gets
 * a chance to land before the process leaves. The wait is ALWAYS bounded: on
 * budget exhaustion it logs and returns rather than hanging shutdown — the
 * JSONL record is already durable, git history is best-effort.
 */
export async function drainAsyncCommits(
  timeoutMs: number = SHUTDOWN_DRAIN_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen: Promise<void>[] = [];
  for (;;) {
    const inFlight = [...asyncChains.values()];
    // Nothing in flight, or only promises we already waited on (a second pass
    // over the same set can never make progress — stop instead of spinning).
    if (inFlight.length === 0) return;
    if (inFlight.every((p) => seen.includes(p))) return;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.warn(
        `[Git] Shutdown drain budget (${timeoutMs}ms) exhausted — ` +
          `${inFlight.length} git operation(s) still in flight`,
      );
      return;
    }

    seen = inFlight;
    await Promise.race([
      Promise.allSettled(inFlight),
      new Promise<void>((resolve) => setTimeout(resolve, remaining).unref()),
    ]);
  }
}

/**
 * Perform the actual git add + commit for a namespace repo, SYNCHRONOUSLY.
 *
 * EXIT PATH ONLY (OPS-006): this is the blocking variant, reachable solely
 * from `flushNamespaceCommit` / `flushAllCommits`, i.e. the process 'exit'
 * handler and the shutdown flush. It is safe there because (a) a 'exit'
 * handler cannot await async work, and (b) a short-lived CLI would otherwise
 * lose its data to the unref'd 30s debounce timer. Never call it from the
 * serving write path — use `scheduleAsyncCommit`.
 *
 * Best-effort: failures are logged and swallowed (history only).
 */
function immediateCommit(namespacePath: string, message: string): void {
  try {
    // Init git repo if it doesn't exist
    const gitDir = path.join(namespacePath, ".git");
    if (!fs.existsSync(gitDir)) {
      execSync("git init", { cwd: namespacePath, stdio: "pipe" });
    }

    // Ensure git user identity is set (newly inited repos + pre-existing ones)
    try {
      execSync("git config user.email", { cwd: namespacePath, stdio: "pipe" });
    } catch {
      execSync('git config user.email "duckbrain@localhost.localdomain"', {
        cwd: namespacePath,
        stdio: "pipe",
      });
    }
    try {
      execSync("git config user.name", { cwd: namespacePath, stdio: "pipe" });
    } catch {
      execSync('git config user.name "DuckBrain"', {
        cwd: namespacePath,
        stdio: "pipe",
      });
    }

    // Stage all changes
    execSync("git add -A", { cwd: namespacePath, stdio: "pipe" });

    // Check if there are staged changes — git diff --cached --quiet exits 1 if there are
    try {
      execSync("git diff --cached --quiet", {
        cwd: namespacePath,
        stdio: "pipe",
      });
      // Exit code 0 = no staged changes, nothing to commit
    } catch {
      // Exit code 1 = there ARE staged changes
      execSync(`git commit -m "${message}"`, {
        cwd: namespacePath,
        stdio: "pipe",
      });
    }
    // Native S3 sync hook (object store) + gated push hook (PUSH-001: default
    // config = zero pushes). Synchronous + best-effort so short-lived CLI
    // processes (remember → commit → exit in <1s) push without waiting for
    // the 03:47 daily cron. Shares the gate state with the serving path.
    maybeSyncOnCommit(namespacePath);
    pushNamespace(namespacePath);
  } catch (error) {
    // Log but don't fail the tool — git is best-effort
    console.warn(
      `[Git] Auto-commit warning for ${namespacePath}: ${(error as Error).message}`,
    );
  }
}

/**
 * Debounced commit. First write schedules a commit in maxSeconds; writes
 * before the timer fires only bump the line counter. When the counter hits
 * maxLines the commit fires immediately. Every namespace repo has its own
 * independent window.
 *
 * OPS-006: every branch below that reaches git schedules the ASYNC commit and
 * returns its promise, so a caller (or a test) can await the work this write
 * triggered. The debounced branch returns an already-resolved promise — the
 * window is opened, nothing is running yet.
 */
export function commitNamespaceWithParams(
  namespacePath: string,
  message: string,
  params: BatchingParams,
): Promise<void> {
  try {
    if (!params.enabled) {
      return scheduleAsyncCommit(namespacePath, message);
    }

    // DOGFOOD-005: Implicitly-created namespaces (CLI remember / REST POST
    // with no prior create_namespace) have a working dir + files but NO .git.
    // The debounced timer below is timer.unref()'d, so a short-lived CLI
    // process exits before it fires — leaving the namespace without git
    // version control. Force the FIRST write to a namespace to init + commit
    // (asynchronously: git init + identity + add + commit + push all run off
    // the event loop, OPS-006). After the repo exists, subsequent writes keep
    // the batching window.
    const gitDir = path.join(namespacePath, ".git");
    if (!fs.existsSync(gitDir)) {
      return scheduleAsyncCommit(namespacePath, message);
    }

    const existing = pending.get(namespacePath);
    if (existing) {
      existing.lines += 1;
      if (existing.lines >= params.maxLines) {
        clearTimeout(existing.timer);
        pending.delete(namespacePath);
        return scheduleAsyncCommit(namespacePath, message);
      }
      return Promise.resolve();
    }

    const timer = setTimeout(() => {
      pending.delete(namespacePath);
      void scheduleAsyncCommit(namespacePath, message);
    }, params.maxSeconds * 1000);
    if (typeof timer.unref === "function") timer.unref(); // don't hold the process open
    pending.set(namespacePath, { timer, lines: 1, message });
    return Promise.resolve();
  } catch (error) {
    console.warn(
      `[Git] Auto-commit warning for ${namespacePath}: ${(error as Error).message}`,
    );
    return Promise.resolve();
  }
}

/**
 * Commit a namespace now, flushing any pending debounce window.
 *
 * OPS-006: this is the SYNCHRONOUS exit-path flush (immediateCommit) — call it
 * only from process-shutdown/exit code, never from the serving write path.
 */
export function flushNamespaceCommit(namespacePath: string): void {
  const existing = pending.get(namespacePath);
  if (!existing) return;
  clearTimeout(existing.timer);
  pending.delete(namespacePath);
  immediateCommit(namespacePath, existing.message);
}

/**
 * CLI-WAIT-001: flush THIS namespace's debounce window, then resolve when its
 * async commit+push chain has settled.
 *
 * `remember --wait` promises the caller that the git commit has landed by the
 * time the process exits. The debounced branch of commitNamespaceWithParams
 * returns an already-resolved promise (the window is opened, nothing runs
 * yet), so a plain `await commitNamespace(...)` proves nothing — and the
 * process 'exit' flush (flushAllCommits) runs AFTER 'await' points, too late
 * to observe. This is the CLI-legal primitive: synchronous
 * flushNamespaceCommit forces the window NOW (exit-path-only helper, zero
 * serving-path use), then the seen-loop resolves once the namespace's
 * in-flight chain finishes — the same settle-detection drainAsyncCommits
 * uses, scoped to one namespace and with NO time budget (the caller is a
 * CLI exit, and git work is already bounded by execFile timeouts in
 * asyncCommit).
 */
export async function waitForNamespaceCommit(
  namespacePath: string,
): Promise<void> {
  flushNamespaceCommit(namespacePath);
  // Settle detection, drainAsyncCommits-style but scoped to one namespace:
  // await the CURRENT chain; after it settles, re-check — a chain we have
  // already awaited (or an empty map) ends the loop, so a concurrent writer
  // that scheduled one follow-up commit during the wait is covered and the
  // loop still terminates. NO time budget: the caller is a CLI exit path and
  // git work is already bounded by execFile timeouts in asyncCommit.
  const seen: Promise<void>[] = [];
  for (;;) {
    const current = asyncChains.get(namespacePath);
    if (!current || seen.includes(current)) return;
    seen.push(current);
    await Promise.allSettled([current]);
  }
}

/**
 * Flush every pending debounce window (e.g. on graceful shutdown).
 *
 * OPS-006: synchronous by design — see flushNamespaceCommit. The shutdown path
 * awaits `drainAsyncCommits()` first so async work already in flight is not
 * cut off, then flushes the windows that never fired.
 */
export function flushAllCommits(): void {
  for (const namespacePath of [...pending.keys()]) {
    flushNamespaceCommit(namespacePath);
  }
}

/**
 * DOGFOOD-005: Register an exit-time flush so short-lived CLI processes
 * (e.g. `duckbrain remember` which resolves, writes, and exits in <1s) don't
 * lose their data to the 30s unref'd debounce timer. immediateCommit is fully
 * synchronous (execSync), so it is safe inside a process 'exit' handler.
 *
 * Registered exactly once per process and guarded for test environments where
 * this module may be re-imported. The handler itself is a no-op when nothing
 * is pending, so it is cheap to leave wired.
 */
if (
  typeof process !== "undefined" &&
  typeof process.on === "function" &&
  !exitFlushRegistered
) {
  process.on("exit", flushAllCommits);
  exitFlushRegistered = true;
}

/**
 * Initialize git repo if missing, then stage and commit all changes.
 * Uses a lightweight --allow-empty check to skip no-op commits.
 * BATCHED: see module docstring — commits are debounced per namespace.
 *
 * OPS-006: resolves when the commit (+push) this call triggered has settled,
 * so a short-lived process can await it, and a long-lived one can ignore it
 * (the in-flight chain keeps work ordered per namespace).
 *
 * @param namespacePath - Absolute path to namespace directory
 * @param message - Commit message (default: auto-commit)
 */
export function commitNamespace(
  namespacePath: string,
  message: string = "chore: auto-commit namespace data",
): Promise<void> {
  return commitNamespaceWithParams(namespacePath, message, batchingParams());
}

/**
 * Select the remote a namespace repo should be pushed to. Prefers the
 * canonical `s3daily` remote (git-remote-s3, duckbrain profile — the path
 * the daily cron uses), falling back to the first configured remote.
 * Returns null when no remote is configured.
 */
export function selectPushRemote(remotes: string): string | null {
  const list = remotes
    .split(/\s+/)
    .map((r) => r.trim())
    .filter(Boolean);
  if (list.length === 0) return null;
  return list.includes("s3daily") ? "s3daily" : list[0];
}

/**
 * Build the git push command for a namespace repo whose branch has no
 * upstream: push explicitly to the remote and set upstream so later bare
 * `git push` calls resolve too.
 */
export function buildPushCommand(remote: string, branch: string): string {
  return `git push --set-upstream ${remote} ${branch}`;
}

/**
 * Build the AWS env for the git-remote-s3 helper from the s3 config block.
 * Endpoint/region come from the user's own config (provider-agnostic — never
 * hardcode a deployment's endpoint here); AWS_PROFILE is only forced when the
 * config names a profile, otherwise the caller's AWS env / ~/.aws decides.
 */
export function buildPushEnv(s3?: {
  endpoint?: string;
  region?: string;
  profile?: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  if (s3?.endpoint) env.AWS_ENDPOINT_URL = s3.endpoint;
  if (s3?.region) env.AWS_DEFAULT_REGION = s3.region;
  if (s3?.profile) env.AWS_PROFILE = s3.profile;
  return env;
}

/**
 * Push a namespace repo to its remote, ASYNCHRONOUSLY (OPS-006 serving path).
 * Never rejects — failures are logged and swallowed.
 */
async function pushNamespaceAsync(namespacePath: string): Promise<void> {
  // PUSH-001 gate: honor s3.enabled/pushOnCommit + intervalSec, coalesce via
  // single-flight, and skip when HEAD already pushed. Silent on every skip.
  const s3 = getConfig(".").s3;
  const gateState = pushGateStateFor(namespacePath);
  if (!evaluatePushGate(s3, gateState, Date.now())) return;
  if (gateState.inFlight) return gateState.inFlight;

  const attempt = (async () => {
    // Hoisted so the catch can run the OPS-012 self-heal with the same
    // remote/branch/tip the failed push used.
    let head = "";
    let remote = "";
    let branch = "";
    try {
      // Skip-unchanged: only push when HEAD moved since the last success.
      head = (await gitAsync(["rev-parse", "HEAD"], namespacePath)).trim();
      if (!head) return;
      if (gateState.lastPushedHead === head) return;

      // Check if remote is configured
      const remotes = (await gitAsync(["remote"], namespacePath)).trim();
      remote = selectPushRemote(remotes) ?? "";
      if (!remote) return;

      // Resolve the current branch. Namespace repos have no upstream (only the
      // s3daily remote), so a bare `git push` would no-op/fail — push
      // explicitly to remote + branch instead.
      branch = (
        await gitAsync(["rev-parse", "--abbrev-ref", "HEAD"], namespacePath)
      ).trim();
      if (!branch || branch === "HEAD") return;

      gateState.lastAttemptAt = Date.now();
      await gitAsync(
        ["push", "--set-upstream", remote, branch],
        namespacePath,
        {
          timeoutMs: PUSH_TIMEOUT_MS,
          // git-remote-s3 needs AWS creds + a compatible endpoint. Endpoint and
          // region derive from the USER'S s3 config block (provider-agnostic);
          // credentials come from the caller's AWS env / ~/.aws — a deployment
          // may pin its profile via s3.profile. Without any AWS env the helper
          // dies with "invalid credentials" and we log + swallow (non-blocking).
          env: {
            ...process.env,
            ...buildPushEnv(s3),
          },
        },
      );
      gateState.lastPushedHead = head;
    } catch (error) {
      const message = (error as Error).message;
      let recovered = false;
      // OPS-012: the in-daemon autopush is the layer that RACES duplicate
      // bundles on a git-remote-s3 remote, so it is the layer that HEALS —
      // on the duplicate-ref signature over an s3:// remote, quarantine the
      // stale bundles (repairDuplicateRefBundles) and retry the push exactly
      // once. Best-effort and bounded: any repair failure logs and falls
      // through to the standard warning below. Happy path: zero added S3
      // calls, zero behavior change.
      if (s3 && remote && branch && isDuplicateRefPushError(message)) {
        try {
          const remoteUrl = (
            await gitAsync(["remote", "get-url", remote], namespacePath)
          ).trim();
          const parsed = parseS3RemoteUrl(remoteUrl);
          if (parsed) {
            recovered = await repairAndRetryPushOnDuplicate({
              client: buildClient(s3),
              bucket: parsed.bucket,
              keyPrefix: parsed.keyPrefix,
              branch,
              localTip: head,
              namespace: namespacePath,
              push: () =>
                gitAsync(
                  ["push", "--set-upstream", remote, branch],
                  namespacePath,
                  {
                    timeoutMs: PUSH_TIMEOUT_MS,
                    env: {
                      ...process.env,
                      ...buildPushEnv(s3),
                    },
                  },
                ),
              log: (line) => console.warn(`[Git] ${line}`),
            });
            if (recovered) gateState.lastPushedHead = head;
          }
        } catch (healError) {
          console.warn(
            `[Git] Duplicate-bundle self-heal failed for ${namespacePath}: ${(healError as Error).message}`,
          );
        }
      }
      if (!recovered) {
        console.warn(`[Git] Push warning for ${namespacePath}: ${message}`);
      }
    }
  })();

  gateState.inFlight = attempt;
  try {
    await attempt;
  } finally {
    if (gateState.inFlight === attempt) gateState.inFlight = null;
  }
}

/**
 * Push namespace repo to remote if configured, SYNCHRONOUSLY.
 *
 * EXIT PATH ONLY (OPS-006): called from `immediateCommit` (the process-exit
 * flush) so a short-lived CLI still pushes before it leaves. The serving path
 * uses `pushNamespaceAsync`. Non-blocking at the caller level — failures are
 * logged and swallowed.
 *
 * @param namespacePath - Absolute path to namespace directory
 */
export function pushNamespace(namespacePath: string): void {
  try {
    // PUSH-001 gate: same config + interval floor as the serving path. If an
    // async push for this namespace is already running in this process, let
    // it carry the work instead of starting a competing bundle.
    const s3 = getConfig(".").s3;
    const gateState = pushGateStateFor(namespacePath);
    if (!evaluatePushGate(s3, gateState, Date.now())) return;
    if (gateState.inFlight) return;

    // Skip-unchanged: only push when HEAD moved since the last success.
    const head = execSync("git rev-parse HEAD", {
      cwd: namespacePath,
      stdio: "pipe",
    })
      .toString()
      .trim();
    if (!head || gateState.lastPushedHead === head) return;

    // Check if remote is configured
    const remotes = execSync("git remote", {
      cwd: namespacePath,
      stdio: "pipe",
    })
      .toString()
      .trim();
    const remote = selectPushRemote(remotes);
    if (!remote) return;

    // Resolve the current branch. Namespace repos have no upstream (only the
    // s3daily remote), so a bare `git push` would no-op/fail — push
    // explicitly to remote + branch instead.
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: namespacePath,
      stdio: "pipe",
    })
      .toString()
      .trim();
    if (!branch || branch === "HEAD") return;

    gateState.lastAttemptAt = Date.now();
    execSync(buildPushCommand(remote, branch), {
      cwd: namespacePath,
      stdio: "pipe",
      timeout: PUSH_TIMEOUT_MS,
      // git-remote-s3 needs AWS creds + a compatible endpoint. Endpoint and
      // region derive from the USER'S s3 config block (provider-agnostic);
      // credentials come from the caller's AWS env / ~/.aws — a deployment
      // may pin its profile via s3.profile. Without any AWS env the helper
      // dies with "invalid credentials" and we log + swallow (non-blocking).
      env: {
        ...process.env,
        ...buildPushEnv(s3),
      },
    });
    gateState.lastPushedHead = head;
  } catch (error) {
    // OPS-012: no duplicate-bundle repair on this sync exit-flush path — the
    // async S3 SDK repair cannot run here; the serving path
    // (pushNamespaceAsync) self-heals instead.
    console.warn(
      `[Git] Push warning for ${namespacePath}: ${(error as Error).message}`,
    );
  }
}
