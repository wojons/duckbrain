/**
 * Scoped, pidfile-proven shutdown for ONE DuckBrain HTTP daemon (OPS-001).
 *
 * Replaces the repository-wide pattern kill that `pnpm stop` used before
 * OPS-001 (`pkill -f 'duckbrain.*http'; pkill -f 'vite'`). A pattern kill
 * matches ANY process whose full argv contains the pattern — editors, agent
 * sessions, unrelated scratch daemons — and the 2026-09-11 production
 * incident showed the other half of the problem: a graceful exit(0) under
 * Restart=on-failure left :3000 dark for ~7 minutes. This helper is the
 * manual/scratch-side counterpart to the Restart=always unit in
 * `ops/systemd/`:
 *
 *   - exactly ONE candidate: the per-instance pidfile for the requested
 *     port (`src/utils/pidfile.ts`, default port 3000; `--pidfile` override,
 *     or `--socket=PATH` for the socket-named pidfile of a `--unix-socket`
 *     instance);
 *   - the pid must be ALIVE and its argv must PROVE it is a DuckBrain HTTP
 *     command for the requested port (explicit `--port=N`, or no `--port`
 *     flag, which is how `startHttpMode` spells port 3000);
 *   - every mismatch (missing, stale, malformed, wrong command, wrong port,
 *     unreadable argv) is a safe no-op that signals NOTHING and returns a
 *     nonzero exit (missing pidfile = explicit not-running no-op, exit 0);
 *   - only SIGTERM is sent — the daemon's graceful path (durability drain,
 *     commit flush, exit 0). No SIGKILL escalation lives here; escalation is
 *     systemd's job (Restart=always + TimeoutStopSec in the shipped unit).
 *
 * UI stopping is intentionally NOT part of this helper — stop the Vite dev
 * server from its own terminal. Never combine it with an HTTP kill.
 */

import fs from "fs";
import path from "path";
import { httpPidFilePath, isPidAlive } from "../utils/pidfile.js";

/** Default HTTP port — the same default `duckbrain http` uses. */
export const DEFAULT_STOP_PORT = 3000;

/**
 * Exit codes for the CLI surface (`scripts/scoped-stop.js`, `pnpm stop`).
 *
 * 0 also covers "nothing tracked for that port" — an explicit safe no-op so
 * stop is idempotent. Every refusal case signals nothing and exits nonzero.
 */
export const SCOPED_STOP_EXIT = {
  /** SIGTERM delivered and the process exited (or nothing was running). */
  OK: 0,
  /** Pidfile pid is dead — stale pidfile. Nothing signaled. */
  REFUSED_STALE: 3,
  /** Pidfile content is not a positive integer pid. Nothing signaled. */
  REFUSED_MALFORMED: 4,
  /** Pid alive but identity unprovable / wrong command / wrong port. */
  REFUSED_IDENTITY: 5,
  /** SIGTERM delivered but the process outlived the grace window. */
  TIMED_OUT: 6,
  /** Signaling failed for a reason other than "already exited". */
  SIGNAL_ERROR: 7,
} as const;

/**
 * Injectable process-inspection seam so tests are fully deterministic:
 * no test ever reads a live pidfile, inspects a live process, or signals
 * anything (AC3, AC6).
 */
export interface StopDeps {
  /** Pidfile content, or null when the file does not exist / is unreadable. */
  readPidFile(pidFile: string): string | null;
  /** Best-effort pidfile removal after a successful stop. */
  unlinkIfExists(pidFile: string): void;
  /** Signal-0 liveness probe (defaults to `isPidAlive`). */
  isAlive(pid: number): boolean;
  /** Process argv, or null when it cannot be read (identity unprovable). */
  readProcessArgv(pid: number): string[] | null;
  /** Send a signal. Throws on failure (ESRCH is handled by the caller). */
  signal(pid: number, signal: NodeJS.Signals): void;
  /** Wait a tick (poll loop seam). */
  sleep(ms: number): Promise<void>;
  /** Wall clock for the grace deadline (tests inject a fake clock). */
  now(): number;
}

/** Production deps: /proc-based argv inspection, real signals. */
export function defaultStopDeps(): StopDeps {
  return {
    readPidFile(pidFile) {
      try {
        return fs.readFileSync(pidFile, "utf-8");
      } catch {
        return null;
      }
    },
    unlinkIfExists(pidFile) {
      try {
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      } catch {
        // Best-effort — a pidfile we could not remove must not fail a stop
        // whose process is already gone.
      }
    },
    isAlive: isPidAlive,
    readProcessArgv(pid: number): string[] | null {
      try {
        // Linux /proc: argv is NUL-separated. Other platforms (or hardened
        // mounts) throw — callers treat null as "identity unprovable" and
        // refuse to signal. Failing closed is the safe direction.
        const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
        return raw.split("\0").filter((token) => token.length > 0);
      } catch {
        return null;
      }
    },
    signal(pid, signal) {
      process.kill(pid, signal);
    },
    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
    now: () => Date.now(),
  };
}

export interface ScopedStopOptions {
  /** Port whose per-instance pidfile is the stop target (default 3000). */
  port?: number;
  /**
   * Unix socket path: selects the socket-named pidfile
   * (`duckbrain-http-<basename>.pid`) used by instances started with
   * `--unix-socket`. The daemon still listens on TCP (default 3000), so the
   * argv port proof remains port-based.
   */
  socket?: string;
  /** Explicit pidfile path — overrides the per-port default. */
  pidFile?: string;
  /** How long to wait for exit after SIGTERM (default 10000ms). */
  graceMs?: number;
  /** Poll interval while waiting for exit (default 100ms). */
  pollMs?: number;
}

export type StopOutcome =
  | { status: "stopped"; pid: number; pidFile: string }
  | { status: "not-running"; pidFile: string; note: string }
  | {
      status: "refused";
      pidFile: string;
      pid?: number;
      code: number;
      reason: string;
    }
  | { status: "timeout"; pid: number; pidFile: string; graceMs: number };

/**
 * Decide what a pidfile's argv proves about the process it identifies.
 *
 * Strict identity rules — this is what makes the helper safe where
 * `pkill -f 'duckbrain.*http'` was not:
 *   - some argv token AFTER argv[0] must have basename
 *     duckbrain.js | duckbrain.ts | duckbrain (the bin entry). Matching any
 *     position would re-introduce the pattern-kill false positive class
 *     (editors/agents whose args merely mention a duckbrain path);
 *   - a later `http` subcommand token must follow the bin token;
 *   - `--port=N` / `--port N` gives the port; its ABSENCE means the
 *     startHttpMode default (3000) — startHttpMode writes the pidfile under
 *     this same resolution, so pidfile port and argv port agree by
 *     construction. A present-but-unparseable --port proves nothing.
 *
 * Returns port null when the command is DuckBrain HTTP but the port is not
 * provable from argv.
 */
export function inspectDuckBrainHttpArgv(tokens: string[]): {
  isDuckBrainHttp: boolean;
  port: number | null;
} {
  let binIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    const base = path.basename(tokens[i]);
    if (
      base === "duckbrain.js" ||
      base === "duckbrain.ts" ||
      base === "duckbrain"
    ) {
      binIdx = i;
      break;
    }
  }
  if (binIdx === -1) return { isDuckBrainHttp: false, port: null };

  // The CLI routes the subcommand as the FIRST arg after the script
  // (bin/duckbrain.ts: command = args[0]), so a genuine daemon always has
  // `http` immediately after the bin token. Requiring adjacency rejects
  // lookalikes such as `grep http duckbrain.js` (bin token LAST) or an
  // editor whose argv merely contains a duckbrain path.
  const rest = tokens.slice(binIdx + 1);
  if (rest[0] !== "http") return { isDuckBrainHttp: false, port: null };

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("--port=")) {
      const value = Number.parseInt(token.slice("--port=".length), 10);
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        return { isDuckBrainHttp: true, port: null };
      }
      return { isDuckBrainHttp: true, port: value };
    }
    if (token === "--port") {
      const value = Number.parseInt(rest[i + 1] ?? "", 10);
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        return { isDuckBrainHttp: true, port: null };
      }
      return { isDuckBrainHttp: true, port: value };
    }
  }
  // No --port flag: startHttpMode defaults to 3000.
  return { isDuckBrainHttp: true, port: DEFAULT_STOP_PORT };
}

/**
 * Stop the ONE DuckBrain HTTP daemon proven by the requested port's pidfile.
 *
 * Never signals on suspicion: missing pidfile → not-running no-op; stale,
 * malformed, identity-mismatched, or wrong-port pidfiles → refused with a
 * nonzero exit code and nothing signaled.
 */
export async function stopHttpInstance(
  options: ScopedStopOptions = {},
  deps: StopDeps = defaultStopDeps(),
): Promise<StopOutcome> {
  const port = options.port ?? DEFAULT_STOP_PORT;
  const pidFile = options.pidFile ?? httpPidFilePath(port, options.socket);
  const graceMs = options.graceMs ?? 10_000;
  const pollMs = options.pollMs ?? 100;

  const raw = deps.readPidFile(pidFile);
  if (raw === null) {
    return {
      status: "not-running",
      pidFile,
      note: `no pidfile for port ${port} (${pidFile}) — nothing tracked to stop (safe no-op)`,
    };
  }

  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      status: "refused",
      pidFile,
      code: SCOPED_STOP_EXIT.REFUSED_MALFORMED,
      reason: `pidfile content is not a positive integer pid — refusing to signal`,
    };
  }

  if (!deps.isAlive(pid)) {
    return {
      status: "refused",
      pidFile,
      pid,
      code: SCOPED_STOP_EXIT.REFUSED_STALE,
      reason: `pid ${pid} from pidfile is not alive — stale pidfile, nothing to stop (safe no-op)`,
    };
  }

  const argv = deps.readProcessArgv(pid);
  if (argv === null) {
    return {
      status: "refused",
      pidFile,
      pid,
      code: SCOPED_STOP_EXIT.REFUSED_IDENTITY,
      reason: `cannot read argv of pid ${pid} — identity unprovable, refusing to signal`,
    };
  }

  const inspected = inspectDuckBrainHttpArgv(argv);
  if (!inspected.isDuckBrainHttp) {
    return {
      status: "refused",
      pidFile,
      pid,
      code: SCOPED_STOP_EXIT.REFUSED_IDENTITY,
      reason: `pid ${pid} is alive but its argv is not a DuckBrain HTTP command — refusing to signal (pid reuse or foreign process)`,
    };
  }
  if (inspected.port !== port) {
    return {
      status: "refused",
      pidFile,
      pid,
      code: SCOPED_STOP_EXIT.REFUSED_IDENTITY,
      reason: `pid ${pid} is a DuckBrain HTTP daemon for port ${
        inspected.port ?? "<unprovable>"
      }, not ${port} — refusing to signal`,
    };
  }

  try {
    deps.signal(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      // Exited between the liveness probe and the signal — the stop goal is
      // already met; clear the stale pidfile.
      deps.unlinkIfExists(pidFile);
      return {
        status: "not-running",
        pidFile,
        note: `pid ${pid} exited before SIGTERM`,
      };
    }
    return {
      status: "refused",
      pidFile,
      pid,
      code: SCOPED_STOP_EXIT.SIGNAL_ERROR,
      reason: `signaling pid ${pid} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const deadline = deps.now() + graceMs;
  while (deps.now() < deadline) {
    await deps.sleep(pollMs);
    if (!deps.isAlive(pid)) {
      deps.unlinkIfExists(pidFile);
      return { status: "stopped", pid, pidFile };
    }
  }

  return {
    status: "timeout",
    pid,
    pidFile,
    graceMs,
  };
}

export interface ParsedScopedStopArgs {
  options: ScopedStopOptions;
  json: boolean;
  help: boolean;
  error?: string;
}

/** Parse `--port=N|--port N`, `--socket=...`, `--pidfile=...`, `--grace-ms=N`, `--json`, `--help`. */
export function parseScopedStopArgs(
  argv: string[],
  defaults: ScopedStopOptions = {},
): ParsedScopedStopArgs {
  const parsed: ParsedScopedStopArgs = {
    options: { ...defaults },
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
    if (token === "--port" || token.startsWith("--port=")) {
      const raw = takesValue();
      const port = raw === null ? NaN : Number.parseInt(raw, 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        parsed.error = `invalid --port value: ${raw ?? "<missing>"} (expected 1-65535)`;
        return parsed;
      }
      parsed.options.port = port;
      continue;
    }
    if (token === "--socket" || token.startsWith("--socket=")) {
      const raw = takesValue();
      if (raw === null || raw.trim() === "") {
        parsed.error = "--socket requires a path";
        return parsed;
      }
      parsed.options.socket = raw;
      continue;
    }
    if (token === "--pidfile" || token.startsWith("--pidfile=")) {
      const raw = takesValue();
      if (raw === null || raw.trim() === "") {
        parsed.error = "--pidfile requires a path";
        return parsed;
      }
      parsed.options.pidFile = raw;
      continue;
    }
    if (token === "--grace-ms" || token.startsWith("--grace-ms=")) {
      const raw = takesValue();
      const grace = raw === null ? NaN : Number.parseInt(raw, 10);
      if (!Number.isInteger(grace) || grace <= 0) {
        parsed.error = `invalid --grace-ms value: ${raw ?? "<missing>"}`;
        return parsed;
      }
      parsed.options.graceMs = grace;
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
      "Usage: pnpm stop [--port=N] [--socket=PATH] [--pidfile=PATH] [--grace-ms=N] [--json]",
      "",
      "Gracefully (SIGTERM) stop the ONE DuckBrain HTTP daemon proven by the",
      "per-instance pidfile for the selected port (default 3000) — or, with",
      "--socket=PATH, the socket-named pidfile of an instance started with",
      "--unix-socket. The pid must be alive AND its argv must prove it is a",
      "DuckBrain HTTP command for that port — every mismatch signals nothing",
      "and exits nonzero.",
      "",
      "Exit codes: 0 stopped / nothing running; 3 stale pidfile; 4 malformed",
      "pidfile; 5 identity mismatch (pid reuse, wrong command, wrong port,",
      "unreadable argv); 6 still alive after grace; 7 signal error.",
      "",
      "This helper NEVER touches Vite/UI processes — stop those separately.",
    ].join("\n"),
  );
}

/** CLI entry used by `scripts/scoped-stop.js` (`pnpm stop`). Returns exit code. */
export async function runScopedStopCli(
  argv: string[],
  deps: StopDeps = defaultStopDeps(),
): Promise<number> {
  const parsed = parseScopedStopArgs(argv);
  if (parsed.error) {
    console.error(`scoped-stop: ${parsed.error}`);
    return 2;
  }
  if (parsed.help) {
    printUsage();
    return 0;
  }

  const outcome = await stopHttpInstance(parsed.options, deps);
  if (parsed.json) {
    console.log(JSON.stringify(outcome));
  } else {
    switch (outcome.status) {
      case "stopped":
        console.log(
          `scoped-stop: SIGTERM delivered to pid ${outcome.pid}; exited; removed ${outcome.pidFile}`,
        );
        break;
      case "not-running":
        console.log(`scoped-stop: ${outcome.note} (exit 0)`);
        break;
      case "refused":
        console.error(`scoped-stop: REFUSED — ${outcome.reason}`);
        break;
      case "timeout":
        console.error(
          `scoped-stop: pid ${outcome.pid} still alive ${outcome.graceMs}ms after SIGTERM — investigate before signaling again (no SIGKILL escalation here)`,
        );
        break;
    }
  }

  switch (outcome.status) {
    case "stopped":
    case "not-running":
      return SCOPED_STOP_EXIT.OK;
    case "refused":
      return outcome.code;
    case "timeout":
      return SCOPED_STOP_EXIT.TIMED_OUT;
  }
}
