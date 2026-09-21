/**
 * Recovery teeth for the dark-port watchdog (GAP-059).
 *
 * `ops/systemd/duckbrain-http-health.service` (OPS-001) detects a dark port
 * and exits 1, but a STATIC oneshot cannot bring anything back: on
 * 2026-09-19 a maintenance stop of `duckbrain-http.service` left `:3000`
 * dark for ~18 minutes (11:11:51 → manual start at 11:29:43) while the
 * watchdog dutifully reported the outage. `duckbrain-http.service` already
 * carries `Restart=always`, so the ONLY remaining dark state is an explicit
 * stop/disable — exactly the state this helper is allowed to fix.
 *
 * Contract (keyed on the health-check contract's DARK only):
 *
 *   - DARK  → count consecutive dark probes in a state file; once the count
 *             reaches `--confirm-probes`, run `systemctl --user start
 *             <unit>`, record the attempt, re-probe once. Alive → clear the
 *             counter, exit 0. Still not alive → exit 1 (systemd may still
 *             be starting; the next timer fire retries).
 *   - ALIVE → clear the state file, exit 0.
 *   - HUNG  → NO action and the counter is untouched. A hung handler is a
 *             serving-but-stuck daemon, not a dead one; restarting it is out
 *             of scope (OPS-002 doctrine, and the health check gives HUNG its
 *             own exit code so an escalation can never restart-loop it).
 *
 * Anti-storm: after an attempt the state file records the attempt timestamp;
 * a further attempt is suppressed for `--cooldown-s` so a unit that keeps
 * failing cannot be restarted once a minute forever. Operators doing
 * intentional long downtime must stop `duckbrain-http-recover.timer` first.
 *
 * Every side effect (state file, health probe, systemctl exec) goes through
 * the injectable `WatchdogRecoverDeps` seam, so tests never touch systemd,
 * the filesystem, or the network — mirroring `StopDeps` in scoped-stop.ts.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { checkHttpHealth, type HealthCheckResult } from "./health-check.js";

/** Default unit whose dark window this helper may recover. */
export const DEFAULT_RECOVER_UNIT = "duckbrain-http.service";

/** Consecutive dark probes required before the first restart attempt. */
export const DEFAULT_CONFIRM_PROBES = 1;

/** Seconds between restart attempts (anti-storm window). */
export const DEFAULT_COOLDOWN_S = 600;

/** `/health` URL probed by default — the same default the watchdog uses. */
export const DEFAULT_HEALTH_URL = "http://127.0.0.1:3000/health";

/** Probe timeout handed to the health check (same default as health-check.ts). */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/** Exit codes: 0 = fine/no action needed, 1 = dark and unrecovered, 2 = usage. */
export const WATCHDOG_RECOVER_EXIT = {
  OK: 0,
  FAILED: 1,
  USAGE: 2,
} as const;

/**
 * Consecutive-dark counter persisted between timer fires.
 *
 * `last_recovery_at` is the anti-storm clock: it is written ONLY when a
 * restart attempt was actually issued (systemctl successful), so a failing
 * `systemctl` does not silently buy itself a cooldown window.
 */
export interface DarkCounterState {
  count: number;
  first_dark_at: string;
  last_recovery_at?: string;
}

/**
 * Path the systemd unit uses: `%h/duckbrain/.watchdog/<name>`, with `%h`
 * resolved from HOME (falling back to the OS home when HOME is unset).
 */
export function defaultStateFilePath(
  home: string | undefined = process.env.HOME,
): string {
  const base = home && home.trim() !== "" ? home : os.homedir();
  return path.join(base, "duckbrain", ".watchdog", "duckbrain-http.dark-count");
}

/**
 * Injectable side-effect seam. Tests get an in-memory state map, a scripted
 * probe queue, and a recording of start attempts — no systemd, no fs, no
 * sockets.
 */
export interface WatchdogRecoverDeps {
  /** Wall clock (tests inject a fake clock). */
  now(): number;
  /** Raw state-file content, or null when absent/unreadable. */
  readStateFile(stateFile: string): string | null;
  /** Persist state (creates the parent directory in production). */
  writeStateFile(stateFile: string, content: string): void;
  /** Remove the state file (missing file is not an error). */
  removeStateFile(stateFile: string): void;
  /** Probe /health — the health-check contract, reused verbatim. */
  probe(url: string, timeoutMs: number): Promise<HealthCheckResult>;
  /** `systemctl --user start <unit>`. Rejects when the command fails. */
  startUnit(unit: string): Promise<void>;
}

/** Production deps: real fs, the health check's real transport, real systemd. */
export function defaultWatchdogRecoverDeps(): WatchdogRecoverDeps {
  return {
    now: () => Date.now(),
    readStateFile(stateFile) {
      try {
        return fs.readFileSync(stateFile, "utf-8");
      } catch {
        return null;
      }
    },
    writeStateFile(stateFile, content) {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, content, "utf-8");
    },
    removeStateFile(stateFile) {
      try {
        fs.unlinkSync(stateFile);
      } catch {
        // Missing file is the success case — never fail a recovery on it.
      }
    },
    probe: (url, timeoutMs) => checkHttpHealth(url, undefined, timeoutMs),
    startUnit(unit) {
      // No shell: argv is fixed, the unit name is the only variable. A
      // failure (nonzero exit, missing systemctl, no user bus) rejects.
      return new Promise<void>((resolve, reject) => {
        execFile(
          "systemctl",
          ["--user", "start", unit],
          (error, _stdout, stderr) => {
            if (error) {
              reject(
                new Error(
                  `systemctl --user start ${unit} failed: ${
                    stderr?.toString().trim() || error.message
                  }`,
                ),
              );
              return;
            }
            resolve();
          },
        );
      });
    },
  };
}

export interface WatchdogRecoverOptions {
  unit?: string;
  confirmProbes?: number;
  cooldownS?: number;
  stateFile?: string;
  healthUrl?: string;
  probeTimeoutMs?: number;
}

/** What one invocation decided/did — the `--json` payload. */
export type RecoverOutcome =
  | {
      action: "none";
      status: "alive";
      unit: string;
      stateFile: string;
      detail: string;
    }
  | {
      action: "none";
      status: "hung";
      unit: string;
      stateFile: string;
      detail: string;
    }
  | {
      action: "counted";
      status: "dark";
      unit: string;
      stateFile: string;
      count: number;
      confirmProbes: number;
      detail: string;
    }
  | {
      action: "suppressed";
      status: "dark";
      unit: string;
      stateFile: string;
      count: number;
      confirmProbes: number;
      cooldownS: number;
      lastRecoveryAt: string;
      detail: string;
    }
  | {
      action: "restarted";
      status: "dark";
      unit: string;
      stateFile: string;
      count: number;
      recovered: boolean;
      detail: string;
    }
  | {
      action: "restart-failed";
      status: "dark";
      unit: string;
      stateFile: string;
      count: number;
      detail: string;
    };

/** Parse the persisted counter defensively — a corrupt file is treated as absent. */
function parseState(raw: string | null): DarkCounterState | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DarkCounterState>;
    if (typeof parsed?.count !== "number" || !Number.isFinite(parsed.count)) {
      return null;
    }
    return {
      count: parsed.count,
      first_dark_at:
        typeof parsed.first_dark_at === "string"
          ? parsed.first_dark_at
          : new Date(0).toISOString(),
      ...(typeof parsed.last_recovery_at === "string"
        ? { last_recovery_at: parsed.last_recovery_at }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * One watchdog-recovery pass. Never throws for probe/systemctl failures —
 * every failure is an outcome with a nonzero exit, so the unit fails loudly
 * instead of leaving an unhandled rejection in the journal.
 */
export async function runWatchdogRecovery(
  options: WatchdogRecoverOptions = {},
  deps: WatchdogRecoverDeps = defaultWatchdogRecoverDeps(),
): Promise<RecoverOutcome> {
  const unit = options.unit ?? DEFAULT_RECOVER_UNIT;
  const confirmProbes = options.confirmProbes ?? DEFAULT_CONFIRM_PROBES;
  const cooldownS = options.cooldownS ?? DEFAULT_COOLDOWN_S;
  const stateFile = options.stateFile ?? defaultStateFilePath();
  const healthUrl = options.healthUrl ?? DEFAULT_HEALTH_URL;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const result = await deps.probe(healthUrl, probeTimeoutMs);

  if (result.status === "alive") {
    // Healthy: the counter must not survive a recovery — clear on sight.
    deps.removeStateFile(stateFile);
    return {
      action: "none",
      status: "alive",
      unit,
      stateFile,
      detail: `port alive — cleared dark counter (${result.detail})`,
    };
  }

  if (result.status === "hung") {
    // OPS-002: a stuck handler is not a dead daemon. No restart, and the
    // counter is deliberately left untouched so a hang cannot be laundered
    // into a dark streak by an intervening probe.
    return {
      action: "none",
      status: "hung",
      unit,
      stateFile,
      detail: `daemon HUNG — no action, dark counter untouched (${result.detail})`,
    };
  }

  const previous = parseState(deps.readStateFile(stateFile));
  const count = (previous?.count ?? 0) + 1;
  const firstDarkAt =
    previous?.first_dark_at ?? new Date(deps.now()).toISOString();
  const counted: DarkCounterState = {
    count,
    first_dark_at: firstDarkAt,
    ...(previous?.last_recovery_at
      ? { last_recovery_at: previous.last_recovery_at }
      : {}),
  };
  deps.writeStateFile(stateFile, JSON.stringify(counted));

  if (count < confirmProbes) {
    return {
      action: "counted",
      status: "dark",
      unit,
      stateFile,
      count,
      confirmProbes,
      detail: `dark probe ${count}/${confirmProbes} — confirming before any restart (${result.detail})`,
    };
  }

  const lastRecoveryAt = previous?.last_recovery_at;
  if (lastRecoveryAt) {
    const elapsedMs = deps.now() - Date.parse(lastRecoveryAt);
    if (Number.isFinite(elapsedMs) && elapsedMs < cooldownS * 1000) {
      return {
        action: "suppressed",
        status: "dark",
        unit,
        stateFile,
        count,
        confirmProbes,
        cooldownS,
        lastRecoveryAt,
        detail: `restart suppressed — last attempt ${Math.round(
          elapsedMs / 1000,
        )}s ago is inside the ${cooldownS}s cooldown (the unit is still failing; not restart-storming it)`,
      };
    }
  }

  try {
    await deps.startUnit(unit);
  } catch (error) {
    // Leave the counter as-is (no attempt timestamp): the next timer fire
    // retries instead of waiting out a cooldown for an attempt that never
    // reached systemd.
    return {
      action: "restart-failed",
      status: "dark",
      unit,
      stateFile,
      count,
      detail: `systemctl --user start ${unit} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const attempted: DarkCounterState = {
    count,
    first_dark_at: firstDarkAt,
    last_recovery_at: new Date(deps.now()).toISOString(),
  };
  deps.writeStateFile(stateFile, JSON.stringify(attempted));

  const followUp = await deps.probe(healthUrl, probeTimeoutMs);
  if (followUp.status === "alive") {
    deps.removeStateFile(stateFile);
    return {
      action: "restarted",
      status: "dark",
      unit,
      stateFile,
      count,
      recovered: true,
      detail: `restarted ${unit} and /health answered again — counter cleared (${followUp.detail})`,
    };
  }

  return {
    action: "restarted",
    status: "dark",
    unit,
    stateFile,
    count,
    recovered: false,
    detail: `started ${unit}; /health still not alive (${followUp.status}: ${followUp.detail}) — systemd may still be bringing it up; the next timer fire retries after the ${cooldownS}s cooldown`,
  };
}

export interface ParsedWatchdogRecoverArgs {
  options: WatchdogRecoverOptions;
  json: boolean;
  help: boolean;
  error?: string;
}

/**
 * Parse `--unit=...`, `--confirm-probes=N`, `--cooldown-s=N`,
 * `--state-file=PATH`, `--health-url=URL`, `--json`, `--help`
 * (space-separated forms accepted, mirroring health-check).
 */
export function parseWatchdogRecoverArgs(
  argv: string[],
): ParsedWatchdogRecoverArgs {
  const parsed: ParsedWatchdogRecoverArgs = {
    options: {},
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const takesValue = (): string | null => {
      if (token.includes("=")) return token.slice(token.indexOf("=") + 1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        i += 1;
        return next;
      }
      return null;
    };
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token === "--json") {
      parsed.json = true;
      continue;
    }
    if (token === "--unit" || token.startsWith("--unit=")) {
      const raw = takesValue();
      if (raw === null || raw.trim() === "") {
        parsed.error = `invalid --unit value: ${raw ?? "<missing>"} (expected a systemd unit name)`;
        return parsed;
      }
      parsed.options.unit = raw.trim();
      continue;
    }
    if (token === "--confirm-probes" || token.startsWith("--confirm-probes=")) {
      const raw = takesValue();
      const value = raw === null ? NaN : Number.parseInt(raw, 10);
      if (!Number.isInteger(value) || value < 1) {
        parsed.error = `invalid --confirm-probes value: ${raw ?? "<missing>"} (expected an integer >= 1)`;
        return parsed;
      }
      parsed.options.confirmProbes = value;
      continue;
    }
    if (token === "--cooldown-s" || token.startsWith("--cooldown-s=")) {
      const raw = takesValue();
      const value = raw === null ? NaN : Number.parseInt(raw, 10);
      if (!Number.isInteger(value) || value < 0) {
        parsed.error = `invalid --cooldown-s value: ${raw ?? "<missing>"} (expected an integer >= 0)`;
        return parsed;
      }
      parsed.options.cooldownS = value;
      continue;
    }
    if (token === "--state-file" || token.startsWith("--state-file=")) {
      const raw = takesValue();
      if (raw === null || raw.trim() === "") {
        parsed.error = `invalid --state-file value: ${raw ?? "<missing>"} (expected a path)`;
        return parsed;
      }
      parsed.options.stateFile = raw;
      continue;
    }
    if (token === "--health-url" || token.startsWith("--health-url=")) {
      const raw = takesValue();
      if (raw === null || !/^https?:\/\//.test(raw)) {
        parsed.error = `invalid --health-url value: ${raw ?? "<missing>"} (expected http(s) URL)`;
        return parsed;
      }
      parsed.options.healthUrl = raw;
      continue;
    }
    parsed.error = `unknown argument: ${token}`;
    return parsed;
  }
  return parsed;
}

function printUsage(): void {
  console.log(
    [
      "Usage: node scripts/watchdog-recover.js [--unit=NAME] [--confirm-probes=N]",
      "                                       [--cooldown-s=S] [--state-file=PATH]",
      "                                       [--health-url=URL] [--json]",
      "",
      "Give the dark-port watchdog recovery teeth (GAP-059). Probes /health",
      "once; on DARK it counts consecutive dark probes and, at",
      "--confirm-probes, runs `systemctl --user start <unit>` (then re-probes",
      "once). A restart is suppressed for --cooldown-s after the previous",
      "attempt so a failing unit cannot be restart-stormed.",
      "",
      "ALIVE: clear the counter. HUNG: no action, counter untouched (a stuck",
      "handler is not a dead daemon — OPS-002).",
      "",
      `Defaults: --unit=${DEFAULT_RECOVER_UNIT} --confirm-probes=${DEFAULT_CONFIRM_PROBES}`,
      `          --cooldown-s=${DEFAULT_COOLDOWN_S} --health-url=${DEFAULT_HEALTH_URL}`,
      `          --state-file=%h/duckbrain/.watchdog/duckbrain-http.dark-count`,
      "",
      "No API keys needed or accepted — /health is auth-exempt.",
      `Exit codes: 0 fine/no action, ${WATCHDOG_RECOVER_EXIT.FAILED} dark and unrecovered, ${WATCHDOG_RECOVER_EXIT.USAGE} usage error.`,
    ].join("\n"),
  );
}

/** CLI entry used by `scripts/watchdog-recover.js`. Returns the exit code. */
export async function runWatchdogRecoverCli(
  argv: string[],
  deps: WatchdogRecoverDeps = defaultWatchdogRecoverDeps(),
): Promise<number> {
  const parsed = parseWatchdogRecoverArgs(argv);
  if (parsed.error) {
    console.error(`watchdog-recover: ${parsed.error}`);
    return WATCHDOG_RECOVER_EXIT.USAGE;
  }
  if (parsed.help) {
    printUsage();
    return WATCHDOG_RECOVER_EXIT.OK;
  }

  const outcome = await runWatchdogRecovery(parsed.options, deps);
  if (parsed.json) {
    console.log(JSON.stringify(outcome));
  } else {
    console.log(`watchdog-recover: ${outcome.action} — ${outcome.detail}`);
  }

  if (outcome.action === "restart-failed") {
    console.error(`watchdog-recover: ${outcome.detail}`);
    return WATCHDOG_RECOVER_EXIT.FAILED;
  }
  if (outcome.action === "restarted" && !outcome.recovered) {
    console.error(`watchdog-recover: ${outcome.detail}`);
    return WATCHDOG_RECOVER_EXIT.FAILED;
  }
  return WATCHDOG_RECOVER_EXIT.OK;
}
