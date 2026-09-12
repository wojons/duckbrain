/**
 * OPS-001 tests: scoped, pidfile-proven shutdown of ONE DuckBrain HTTP
 * daemon — the replacement for the repository-wide pattern kill that
 * `pnpm stop` used before OPS-001.
 *
 * Fully hermetic: every test uses scratch pidfiles in a temp dir, a fake
 * process table, and a fake clock. No test reads a live pidfile, inspects a
 * live process, or signals anything (AC3/AC6 — the production :3000 daemon
 * is never touched).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import {
  DEFAULT_STOP_PORT,
  SCOPED_STOP_EXIT,
  inspectDuckBrainHttpArgv,
  stopHttpInstance,
  parseScopedStopArgs,
  runScopedStopCli,
  type StopDeps,
} from "./scoped-stop";

/** A fake process table entry. */
interface FakeProc {
  argv: string[] | null;
  alive: boolean;
  signals: NodeJS.Signals[];
}

/** Hermetic StopDeps over a fake process table + scratch pidfiles. */
function makeDeps(
  procs: Map<number, FakeProc>,
  clock: { value: number },
): StopDeps {
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
        fs.unlinkSync(pidFile);
      } catch {
        // ignore
      }
    },
    isAlive(pid) {
      return procs.get(pid)?.alive ?? false;
    },
    readProcessArgv(pid) {
      return procs.get(pid)?.argv ?? null;
    },
    signal(pid, signal) {
      const proc = procs.get(pid);
      if (!proc || !proc.alive) {
        const error = new Error("kill ESRCH") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      proc.signals.push(signal);
    },
    async sleep() {
      clock.value += 100;
    },
    now() {
      return clock.value;
    },
  };
}

const BIN = ["node", "/repo/bin/duckbrain.js"];

/** Register a live fake process with the given argv. */
function live(
  procs: Map<number, FakeProc>,
  pid: number,
  argv: string[] | null,
): void {
  procs.set(pid, { argv, alive: true, signals: [] });
}

describe("inspectDuckBrainHttpArgv (identity proof)", () => {
  it("accepts the canonical daemon argv (bin + http subcommand, default port)", () => {
    expect(inspectDuckBrainHttpArgv([...BIN, "http"])).toEqual({
      isDuckBrainHttp: true,
      port: DEFAULT_STOP_PORT,
    });
  });

  it("accepts --port=N in = form", () => {
    expect(inspectDuckBrainHttpArgv([...BIN, "http", "--port=4545"])).toEqual({
      isDuckBrainHttp: true,
      port: 4545,
    });
  });

  it("accepts the --port N two-token form", () => {
    expect(
      inspectDuckBrainHttpArgv([...BIN, "http", "--port", "4546"]),
    ).toEqual({ isDuckBrainHttp: true, port: 4546 });
  });

  it("handles tsx-wrapped entries (tsx + script + args)", () => {
    expect(
      inspectDuckBrainHttpArgv([
        "node",
        "/repo/node_modules/.bin/tsx",
        "/repo/bin/duckbrain.ts",
        "http",
      ]),
    ).toEqual({ isDuckBrainHttp: true, port: DEFAULT_STOP_PORT });
  });

  it("rejects non-duckbrain commands", () => {
    expect(inspectDuckBrainHttpArgv(["node", "server.js", "http"])).toEqual({
      isDuckBrainHttp: false,
      port: null,
    });
  });

  it("rejects a duckbrain path with no http subcommand (editor case)", () => {
    expect(inspectDuckBrainHttpArgv(["vim", "/repo/bin/duckbrain.ts"])).toEqual(
      { isDuckBrainHttp: false, port: null },
    );
  });

  it("rejects grep-style lookalikes where http is not adjacent to the bin token", () => {
    expect(
      inspectDuckBrainHttpArgv(["grep", "http", "/repo/bin/duckbrain.js"]),
    ).toEqual({ isDuckBrainHttp: false, port: null });
  });

  it("rejects a duckbrain stdio command (not http)", () => {
    expect(inspectDuckBrainHttpArgv([...BIN, "stdio"])).toEqual({
      isDuckBrainHttp: false,
      port: null,
    });
  });

  it("treats a present-but-unparseable --port as unprovable", () => {
    expect(inspectDuckBrainHttpArgv([...BIN, "http", "--port=abc"])).toEqual({
      isDuckBrainHttp: true,
      port: null,
    });
  });

  it("treats an out-of-range --port as unprovable", () => {
    expect(inspectDuckBrainHttpArgv([...BIN, "http", "--port=99999"])).toEqual({
      isDuckBrainHttp: true,
      port: null,
    });
  });
});

describe("stopHttpInstance — success and safe refusals", () => {
  let pidDir: string;
  let procs: Map<number, FakeProc>;
  let clock: { value: number };
  let deps: StopDeps;

  beforeEach(() => {
    pidDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-scoped-stop-"));
    procs = new Map();
    clock = { value: 1_000_000 };
    deps = makeDeps(procs, clock);
  });

  afterEach(() => {
    fs.rmSync(pidDir, { recursive: true, force: true });
  });

  function writePidFile(name: string, content: string): string {
    const pidFile = path.join(pidDir, name);
    fs.writeFileSync(pidFile, content);
    return pidFile;
  }

  function totalSignalsSent(): number {
    let count = 0;
    for (const proc of procs.values()) count += proc.signals.length;
    return count;
  }

  it("SIGTERMs the proven daemon, waits for exit, and removes the pidfile", async () => {
    live(procs, 4242, [...BIN, "http"]);
    const pidFile = writePidFile("duckbrain-http-3000.pid", "4242\n");
    // Graceful-exit simulation: the daemon dies once SIGTERM is delivered.
    const originalSignal = deps.signal.bind(deps);
    deps.signal = (signalPid: number, signal: NodeJS.Signals) => {
      originalSignal(signalPid, signal);
      procs.get(signalPid)!.alive = false;
    };

    const outcome = await stopHttpInstance({ pidFile }, deps);

    expect(outcome).toEqual({ status: "stopped", pid: 4242, pidFile });
    expect(procs.get(4242)!.signals).toEqual(["SIGTERM"]);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("keeps polling until the daemon exits within the grace window", async () => {
    live(procs, 4243, [...BIN, "http"]);
    const pidFile = writePidFile("duckbrain-http-3000.pid", "4243");
    // Dies on the SECOND poll, not the first — proves the loop waits.
    const originalSignal = deps.signal.bind(deps);
    let polls = 0;
    const originalIsAlive = deps.isAlive.bind(deps);
    deps.signal = (signalPid: number, signal: NodeJS.Signals) => {
      originalSignal(signalPid, signal);
      procs.get(signalPid)!.alive = false;
    };
    deps.isAlive = (pid: number) => {
      polls += 1;
      if (polls <= 2) return true;
      return originalIsAlive(pid);
    };

    const outcome = await stopHttpInstance({ pidFile, graceMs: 10_000 }, deps);

    expect(outcome.status).toBe("stopped");
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it("not-running: missing pidfile is an explicit safe no-op (exit 0)", async () => {
    const pidFile = path.join(pidDir, "duckbrain-http-3999.pid");

    const outcome = await stopHttpInstance({ pidFile }, deps);

    expect(outcome.status).toBe("not-running");
    expect(totalSignalsSent()).toBe(0);
  });

  it("refused: stale pidfile (pid not alive) — nothing signaled", async () => {
    procs.set(999999, { argv: [...BIN, "http"], alive: false, signals: [] });
    const pidFile = writePidFile("duckbrain-http-3000.pid", "999999");

    const outcome = await stopHttpInstance({ pidFile }, deps);

    expect(outcome).toMatchObject({
      status: "refused",
      pid: 999999,
      code: SCOPED_STOP_EXIT.REFUSED_STALE,
    });
    expect(totalSignalsSent()).toBe(0);
  });

  it("refused: malformed pidfile (non-integer content) — nothing signaled", async () => {
    const pidFile = writePidFile("duckbrain-http-3000.pid", "not-a-pid\n");

    const outcome = await stopHttpInstance({ pidFile }, deps);

    expect(outcome).toMatchObject({
      status: "refused",
      code: SCOPED_STOP_EXIT.REFUSED_MALFORMED,
    });
    expect(totalSignalsSent()).toBe(0);
  });

  it("refused: malformed pidfile (negative pid) — nothing signaled", async () => {
    const pidFile = writePidFile("duckbrain-http-3000.pid", "-5");

    const outcome = await stopHttpInstance({ pidFile }, deps);

    expect(outcome).toMatchObject({
      status: "refused",
      code: SCOPED_STOP_EXIT.REFUSED_MALFORMED,
    });
    expect(totalSignalsSent()).toBe(0);
  });

  it("refused: PID reuse — alive pid whose command is NOT DuckBrain HTTP", async () => {
    live(procs, 4244, ["nginx", "worker"]);
    const pidFile = writePidFile("duckbrain-http-3000.pid", "4244");

    const outcome = await stopHttpInstance({ pidFile }, deps);

    expect(outcome).toMatchObject({
      status: "refused",
      pid: 4244,
      code: SCOPED_STOP_EXIT.REFUSED_IDENTITY,
    });
    expect(totalSignalsSent()).toBe(0);
  });

  it("refused: unreadable argv (identity unprovable) — nothing signaled", async () => {
    live(procs, 4245, null);
    const pidFile = writePidFile("duckbrain-http-3000.pid", "4245");

    const outcome = await stopHttpInstance({ pidFile }, deps);

    expect(outcome).toMatchObject({
      status: "refused",
      pid: 4245,
      code: SCOPED_STOP_EXIT.REFUSED_IDENTITY,
    });
    expect(totalSignalsSent()).toBe(0);
  });

  it("refused: right command, WRONG PORT — nothing signaled", async () => {
    live(procs, 4246, [...BIN, "http", "--port=4545"]);
    const pidFile = writePidFile("duckbrain-http-3000.pid", "4246");

    const outcome = await stopHttpInstance({ pidFile }, deps);

    expect(outcome).toMatchObject({
      status: "refused",
      pid: 4246,
      code: SCOPED_STOP_EXIT.REFUSED_IDENTITY,
    });
    expect(totalSignalsSent()).toBe(0);
  });

  it("refused: unparseable --port in argv proves nothing — nothing signaled", async () => {
    live(procs, 4247, [...BIN, "http", "--port=abc"]);
    const pidFile = writePidFile("duckbrain-http-3000.pid", "4247");

    const outcome = await stopHttpInstance({ pidFile }, deps);

    expect(outcome).toMatchObject({
      status: "refused",
      code: SCOPED_STOP_EXIT.REFUSED_IDENTITY,
    });
    expect(totalSignalsSent()).toBe(0);
  });

  it("timeout: daemon stays alive past the grace window — reported, no SIGKILL", async () => {
    live(procs, 4248, [...BIN, "http"]);
    const pidFile = writePidFile("duckbrain-http-3000.pid", "4248");

    const outcome = await stopHttpInstance(
      { pidFile, graceMs: 1_000, pollMs: 100 },
      deps,
    );

    expect(outcome).toMatchObject({
      status: "timeout",
      pid: 4248,
      graceMs: 1_000,
    });
    // Exactly one SIGTERM — never an escalation signal.
    expect(procs.get(4248)!.signals).toEqual(["SIGTERM"]);
    // Pidfile intentionally retained for diagnosis.
    expect(fs.existsSync(pidFile)).toBe(true);
  });

  it("ESRCH race: pid exits between probe and signal → safe not-running", async () => {
    live(procs, 4249, [...BIN, "http"]);
    const pidFile = writePidFile("duckbrain-http-3000.pid", "4249");
    // Make signaling throw ESRCH even though the liveness probe passed.
    deps.signal = () => {
      const error = new Error("kill ESRCH") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    };

    const outcome = await stopHttpInstance({ pidFile }, deps);

    expect(outcome).toMatchObject({ status: "not-running" });
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("uses the per-port default pidfile path when no --pidfile is given", async () => {
    // Point DUCKBRAIN_DATA_DIR at the scratch dir so the default path is a
    // scratch path, never the live /tmp pidfile.
    const original = process.env.DUCKBRAIN_DATA_DIR;
    process.env.DUCKBRAIN_DATA_DIR = pidDir;
    try {
      live(procs, 4250, [...BIN, "http", "--port=4777"]);
      fs.writeFileSync(path.join(pidDir, "duckbrain-http-4777.pid"), "4250");
      const originalSignal = deps.signal.bind(deps);
      deps.signal = (signalPid: number, signal: NodeJS.Signals) => {
        originalSignal(signalPid, signal);
        procs.get(signalPid)!.alive = false;
      };

      const outcome = await stopHttpInstance({ port: 4777 }, deps);

      expect(outcome).toMatchObject({ status: "stopped", pid: 4250 });
      expect(outcome.pidFile.endsWith("duckbrain-http-4777.pid")).toBe(true);
    } finally {
      if (original === undefined) delete process.env.DUCKBRAIN_DATA_DIR;
      else process.env.DUCKBRAIN_DATA_DIR = original;
    }
  });

  it("socket option: selects the socket-named pidfile; argv port proof stays port-based", async () => {
    // Same shape as the production daemon: TCP on default port 3000 plus
    // --unix-socket, whose pidfile is named after the socket basename.
    const original = process.env.DUCKBRAIN_DATA_DIR;
    process.env.DUCKBRAIN_DATA_DIR = pidDir;
    try {
      live(procs, 4251, [
        "/usr/bin/node",
        "bin/duckbrain.js",
        "http",
        "--port",
        "3000",
        "--auth=apikey",
        "--unix-socket=/tmp/scratch.sock",
      ]);
      fs.writeFileSync(
        path.join(pidDir, "duckbrain-http-scratch.sock.pid"),
        "4251",
      );
      const originalSignal = deps.signal.bind(deps);
      deps.signal = (signalPid: number, signal: NodeJS.Signals) => {
        originalSignal(signalPid, signal);
        procs.get(signalPid)!.alive = false;
      };

      const outcome = await stopHttpInstance(
        { port: 3000, socket: "/tmp/scratch.sock" },
        deps,
      );

      expect(outcome).toMatchObject({ status: "stopped", pid: 4251 });
      expect(outcome.pidFile.endsWith("duckbrain-http-scratch.sock.pid")).toBe(
        true,
      );
    } finally {
      if (original === undefined) delete process.env.DUCKBRAIN_DATA_DIR;
      else process.env.DUCKBRAIN_DATA_DIR = original;
    }
  });

  it("socket option: refuses when the instance's argv port differs from the requested port", async () => {
    const original = process.env.DUCKBRAIN_DATA_DIR;
    process.env.DUCKBRAIN_DATA_DIR = pidDir;
    try {
      live(procs, 4252, [
        ...BIN,
        "http",
        "--port=4545",
        "--unix-socket=/tmp/scratch2.sock",
      ]);
      fs.writeFileSync(
        path.join(pidDir, "duckbrain-http-scratch2.sock.pid"),
        "4252",
      );

      const outcome = await stopHttpInstance(
        { port: 3000, socket: "/tmp/scratch2.sock" },
        deps,
      );

      expect(outcome).toMatchObject({
        status: "refused",
        code: SCOPED_STOP_EXIT.REFUSED_IDENTITY,
      });
      expect(totalSignalsSent()).toBe(0);
    } finally {
      if (original === undefined) delete process.env.DUCKBRAIN_DATA_DIR;
      else process.env.DUCKBRAIN_DATA_DIR = original;
    }
  });
});

describe("parseScopedStopArgs", () => {
  it("parses --port in both forms and defaults to port 3000", () => {
    expect(parseScopedStopArgs([]).options.port).toBeUndefined();
    expect(parseScopedStopArgs(["--port=4545"]).options.port).toBe(4545);
    expect(parseScopedStopArgs(["--port", "4546"]).options.port).toBe(4546);
  });

  it("rejects invalid ports, unknown flags, and bad grace values", () => {
    expect(parseScopedStopArgs(["--port=0"]).error).toBeDefined();
    expect(parseScopedStopArgs(["--port=99999"]).error).toBeDefined();
    expect(parseScopedStopArgs(["--port"]).error).toBeDefined();
    expect(parseScopedStopArgs(["--bogus"]).error).toBeDefined();
    expect(parseScopedStopArgs(["--grace-ms=x"]).error).toBeDefined();
    expect(parseScopedStopArgs(["--grace-ms=0"]).error).toBeDefined();
  });

  it("accepts --pidfile, --socket, --grace-ms, and flags", () => {
    const parsed = parseScopedStopArgs([
      "--pidfile",
      "/tmp/x.pid",
      "--socket=/tmp/scratch.sock",
      "--grace-ms=250",
      "--json",
    ]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.options.pidFile).toBe("/tmp/x.pid");
    expect(parsed.options.socket).toBe("/tmp/scratch.sock");
    expect(parsed.options.graceMs).toBe(250);
    expect(parsed.json).toBe(true);
  });
});

describe("runScopedStopCli (exit-code contract)", () => {
  let pidDir: string;
  let procs: Map<number, FakeProc>;
  let clock: { value: number };

  beforeEach(() => {
    pidDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-scoped-cli-"));
    procs = new Map();
    clock = { value: 2_000_000 };
  });

  afterEach(() => {
    fs.rmSync(pidDir, { recursive: true, force: true });
  });

  it("returns 0 for a successful stop and a safe not-running no-op", async () => {
    live(procs, 4300, [...BIN, "http"]);
    const pidFile = path.join(pidDir, "duckbrain-http-3000.pid");
    fs.writeFileSync(pidFile, "4300");
    const deps = makeDeps(procs, clock);
    const originalSignal = deps.signal.bind(deps);
    deps.signal = (signalPid: number, signal: NodeJS.Signals) => {
      originalSignal(signalPid, signal);
      procs.get(signalPid)!.alive = false;
    };

    expect(await runScopedStopCli(["--pidfile", pidFile], deps)).toBe(0);
    expect(await runScopedStopCli(["--pidfile", pidFile], deps)).toBe(0);
  });

  it("returns the refusal code for stale / mismatched pidfiles without signaling", async () => {
    procs.set(4301, { argv: [...BIN, "http"], alive: false, signals: [] });
    const stale = path.join(pidDir, "stale.pid");
    fs.writeFileSync(stale, "4301");

    const mismatch = path.join(pidDir, "mismatch.pid");
    fs.writeFileSync(mismatch, "4302");
    live(procs, 4302, ["nginx", "worker"]);

    const deps = makeDeps(procs, clock);
    expect(await runScopedStopCli(["--pidfile", stale, "--json"], deps)).toBe(
      SCOPED_STOP_EXIT.REFUSED_STALE,
    );
    expect(
      await runScopedStopCli(["--pidfile", mismatch, "--json"], deps),
    ).toBe(SCOPED_STOP_EXIT.REFUSED_IDENTITY);
    expect(procs.get(4301)!.signals).toEqual([]);
    expect(procs.get(4302)!.signals).toEqual([]);
  });

  it("returns 2 on usage errors and 0 on --help", async () => {
    const deps = makeDeps(procs, clock);
    expect(await runScopedStopCli(["--nope"], deps)).toBe(2);
    expect(await runScopedStopCli(["--help"], deps)).toBe(0);
  });
});
