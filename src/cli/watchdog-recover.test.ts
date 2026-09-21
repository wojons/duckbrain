/**
 * GAP-059 tests: recovery teeth for the dark-port watchdog.
 *
 * Fully hermetic — every side effect (state file, health probe, systemctl
 * exec) is injected, so no test touches systemd, the filesystem, or the
 * network. The only real process spawned is `scripts/watchdog-recover.js
 * --help`, which proves the tsx wrapper loads and exits 0.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import type { HealthCheckResult } from "./health-check";
import {
  DEFAULT_CONFIRM_PROBES,
  DEFAULT_COOLDOWN_S,
  DEFAULT_HEALTH_URL,
  DEFAULT_RECOVER_UNIT,
  WATCHDOG_RECOVER_EXIT,
  defaultStateFilePath,
  parseWatchdogRecoverArgs,
  runWatchdogRecoverCli,
  runWatchdogRecovery,
  type DarkCounterState,
  type WatchdogRecoverDeps,
} from "./watchdog-recover";

const STATE_FILE = "/tmp/fake-watchdog/duckbrain-http.dark-count";
const T0 = Date.parse("2026-09-21T12:00:00.000Z");

const dark = (
  detail = "connection failed to http://127.0.0.1:3000/health: ECONNREFUSED",
): HealthCheckResult => ({
  status: "dark",
  httpStatus: null,
  detail,
});
const alive = (status = 200): HealthCheckResult => ({
  status: "alive",
  httpStatus: status,
  detail:
    status === 200
      ? "daemon alive (HTTP 200)"
      : "daemon alive (HTTP 503 — degraded)",
});
const hung = (): HealthCheckResult => ({
  status: "hung",
  httpStatus: null,
  detail: "reachable but /health did not answer within 5000ms",
});

interface Harness {
  deps: WatchdogRecoverDeps;
  /** Raw state-file contents by path (absent key = file missing). */
  files: Map<string, string>;
  /** Units passed to startUnit, in order. */
  starts: string[];
  /** URLs/timeouts the probe saw. */
  probes: { url: string; timeoutMs: number }[];
  /** Advance the injected clock. */
  advance(ms: number): void;
  /** Fail the next startUnit call with this message. */
  failStartWith(message: string): void;
}

/** Build a fully injected deps object with a scripted probe queue. */
function harness(probeScript: HealthCheckResult[]): Harness {
  let nowMs = T0;
  let startError: string | null = null;
  const files = new Map<string, string>();
  const starts: string[] = [];
  const probes: { url: string; timeoutMs: number }[] = [];
  const queue = [...probeScript];

  const deps: WatchdogRecoverDeps = {
    now: () => nowMs,
    readStateFile: (p) => files.get(p) ?? null,
    writeStateFile: (p, content) => {
      files.set(p, content);
    },
    removeStateFile: (p) => {
      files.delete(p);
    },
    probe: async (url, timeoutMs) => {
      probes.push({ url, timeoutMs });
      const next = queue.shift();
      if (!next)
        throw new Error(
          "probe queue exhausted — test scripted fewer probes than the code ran",
        );
      return next;
    },
    startUnit: async (unit) => {
      if (startError !== null) {
        const message = startError;
        startError = null;
        throw new Error(message);
      }
      starts.push(unit);
    },
  };

  return {
    deps,
    files,
    starts,
    probes,
    advance: (ms) => {
      nowMs += ms;
    },
    failStartWith: (message) => {
      startError = message;
    },
  };
}

function seededCount(files: Map<string, string>): DarkCounterState {
  const raw = files.get(STATE_FILE);
  expect(raw, "expected a persisted counter state file").toBeDefined();
  return JSON.parse(raw as string) as DarkCounterState;
}

describe("parseWatchdogRecoverArgs", () => {
  it("leaves every option at its shipped default when no flags are given", () => {
    const parsed = parseWatchdogRecoverArgs([]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.json).toBe(false);
    expect(parsed.help).toBe(false);
    expect(parsed.options).toEqual({});
    // The defaults themselves are the contract the systemd units rely on.
    expect(DEFAULT_RECOVER_UNIT).toBe("duckbrain-http.service");
    expect(DEFAULT_CONFIRM_PROBES).toBe(1);
    expect(DEFAULT_COOLDOWN_S).toBe(600);
    expect(DEFAULT_HEALTH_URL).toBe("http://127.0.0.1:3000/health");
  });

  it("parses every flag in both = and space forms", () => {
    const eq = parseWatchdogRecoverArgs([
      "--unit=duckbrain-http.service",
      "--confirm-probes=3",
      "--cooldown-s=900",
      "--state-file=/tmp/x.count",
      "--health-url=http://127.0.0.1:4777/health",
      "--json",
    ]);
    expect(eq.error).toBeUndefined();
    expect(eq.options).toEqual({
      unit: "duckbrain-http.service",
      confirmProbes: 3,
      cooldownS: 900,
      stateFile: "/tmp/x.count",
      healthUrl: "http://127.0.0.1:4777/health",
    });
    expect(eq.json).toBe(true);

    const spaced = parseWatchdogRecoverArgs([
      "--unit",
      "other.service",
      "--confirm-probes",
      "2",
      "--cooldown-s",
      "0",
      "--state-file",
      "/tmp/y.count",
      "--health-url",
      "http://127.0.0.1:3001/health",
    ]);
    expect(spaced.error).toBeUndefined();
    expect(spaced.options).toEqual({
      unit: "other.service",
      confirmProbes: 2,
      cooldownS: 0,
      stateFile: "/tmp/y.count",
      healthUrl: "http://127.0.0.1:3001/health",
    });
  });

  it("rejects bad values and unknown flags", () => {
    expect(
      parseWatchdogRecoverArgs(["--confirm-probes=0"]).error,
    ).toBeDefined();
    expect(
      parseWatchdogRecoverArgs(["--confirm-probes=x"]).error,
    ).toBeDefined();
    expect(parseWatchdogRecoverArgs(["--confirm-probes"]).error).toBeDefined();
    expect(parseWatchdogRecoverArgs(["--cooldown-s=-1"]).error).toBeDefined();
    expect(parseWatchdogRecoverArgs(["--cooldown-s=nope"]).error).toBeDefined();
    expect(parseWatchdogRecoverArgs(["--state-file="]).error).toBeDefined();
    expect(parseWatchdogRecoverArgs(["--unit="]).error).toBeDefined();
    expect(
      parseWatchdogRecoverArgs(["--health-url=ftp://x"]).error,
    ).toBeDefined();
    expect(parseWatchdogRecoverArgs(["--health-url"]).error).toBeDefined();
    expect(parseWatchdogRecoverArgs(["--nope"]).error).toBeDefined();
  });
});

describe("defaultStateFilePath", () => {
  it("resolves %h/duckbrain/.watchdog/... from HOME", () => {
    expect(defaultStateFilePath("/home/kara")).toBe(
      "/home/kara/duckbrain/.watchdog/duckbrain-http.dark-count",
    );
  });

  it("falls back to the OS home when HOME is empty or unset", () => {
    const fromOsHome = defaultStateFilePath("");
    expect(
      fromOsHome.endsWith("/duckbrain/.watchdog/duckbrain-http.dark-count"),
    ).toBe(true);
    expect(defaultStateFilePath(undefined)).toBe(fromOsHome);
  });
});

describe("runWatchdogRecovery — the DARK escalation ladder", () => {
  it("1st dark probe only counts: no restart, counter persisted", async () => {
    const h = harness([dark()]);
    const outcome = await runWatchdogRecovery(
      { stateFile: STATE_FILE, confirmProbes: 3, cooldownS: 600 },
      h.deps,
    );

    expect(outcome.action).toBe("counted");
    expect(h.starts).toEqual([]);
    const state = seededCount(h.files);
    expect(state.count).toBe(1);
    expect(state.first_dark_at).toBe(new Date(T0).toISOString());
    expect(state.last_recovery_at).toBeUndefined();
    expect(h.probes).toHaveLength(1);
  });

  it("Nth consecutive dark probe restarts the unit and records the attempt", async () => {
    // count 1 already recorded; this probe is the 2nd of 2 → restart.
    const h = harness([dark(), alive()]);
    h.files.set(
      STATE_FILE,
      JSON.stringify({
        count: 1,
        first_dark_at: new Date(T0 - 60_000).toISOString(),
      }),
    );

    const outcome = await runWatchdogRecovery(
      {
        stateFile: STATE_FILE,
        confirmProbes: 2,
        cooldownS: 600,
        unit: "duckbrain-http.service",
      },
      h.deps,
    );

    expect(outcome.action).toBe("restarted");
    expect(outcome.action === "restarted" && outcome.recovered).toBe(true);
    expect(h.starts).toEqual(["duckbrain-http.service"]);
    // First probe = the confirm probe; second = the follow-up after starting.
    expect(h.probes).toHaveLength(2);
    // Recovery is complete → the counter is cleared, not left behind.
    expect(h.files.has(STATE_FILE)).toBe(false);
  });

  it("writes the attempt timestamp when the follow-up probe is still dark", async () => {
    const h = harness([dark(), dark()]);
    h.files.set(
      STATE_FILE,
      JSON.stringify({
        count: 1,
        first_dark_at: new Date(T0 - 60_000).toISOString(),
      }),
    );

    const outcome = await runWatchdogRecovery(
      { stateFile: STATE_FILE, confirmProbes: 2, cooldownS: 600 },
      h.deps,
    );

    expect(outcome.action).toBe("restarted");
    expect(outcome.action === "restarted" && outcome.recovered).toBe(false);
    expect(h.starts).toHaveLength(1);
    const state = seededCount(h.files);
    expect(state.count).toBe(2);
    expect(state.last_recovery_at).toBe(new Date(T0).toISOString());
    expect(state.first_dark_at).toBe(new Date(T0 - 60_000).toISOString());
  });

  it("a successful restart whose follow-up probe is ALIVE clears the counter (exit 0)", async () => {
    const h = harness([dark(), alive(503)]);
    const code = await runWatchdogRecoverCli(
      [`--state-file=${STATE_FILE}`, "--confirm-probes=1", "--cooldown-s=600"],
      h.deps,
    );

    expect(code).toBe(WATCHDOG_RECOVER_EXIT.OK);
    expect(h.starts).toHaveLength(1);
    expect(h.files.has(STATE_FILE)).toBe(false);
  });
});

describe("runWatchdogRecovery — ALIVE and HUNG are not dark", () => {
  it("ALIVE clears an existing counter and never touches systemd", async () => {
    const h = harness([alive()]);
    h.files.set(
      STATE_FILE,
      JSON.stringify({
        count: 7,
        first_dark_at: new Date(T0 - 420_000).toISOString(),
      }),
    );

    const outcome = await runWatchdogRecovery(
      { stateFile: STATE_FILE },
      h.deps,
    );

    expect(outcome.action).toBe("none");
    expect(outcome.status).toBe("alive");
    expect(h.files.has(STATE_FILE)).toBe(false);
    expect(h.starts).toEqual([]);
  });

  it("ALIVE with no counter file is a clean no-op", async () => {
    const h = harness([alive()]);
    const outcome = await runWatchdogRecovery(
      { stateFile: STATE_FILE },
      h.deps,
    );
    expect(outcome.action).toBe("none");
    expect(h.files.size).toBe(0);
    expect(h.starts).toEqual([]);
  });

  it("HUNG leaves the counter untouched and never restarts a serving daemon", async () => {
    const h = harness([hung()]);
    const seeded = JSON.stringify({
      count: 3,
      first_dark_at: new Date(T0 - 180_000).toISOString(),
    });
    h.files.set(STATE_FILE, seeded);

    const outcome = await runWatchdogRecovery(
      { stateFile: STATE_FILE },
      h.deps,
    );

    expect(outcome.action).toBe("none");
    expect(outcome.status).toBe("hung");
    expect(h.starts).toEqual([]);
    // Byte-identical: not incremented, not cleared, not rewritten.
    expect(h.files.get(STATE_FILE)).toBe(seeded);
    expect(h.probes).toHaveLength(1);
  });

  it("HUNG is a no-op even with no prior counter — nothing is created", async () => {
    const h = harness([hung()]);
    const outcome = await runWatchdogRecovery(
      { stateFile: STATE_FILE },
      h.deps,
    );
    expect(outcome.action).toBe("none");
    expect(h.files.size).toBe(0);
    expect(h.starts).toEqual([]);
  });
});

describe("runWatchdogRecovery — anti-storm cooldown", () => {
  it("suppresses a second restart inside the cooldown window", async () => {
    const h = harness([dark()]);
    h.files.set(
      STATE_FILE,
      JSON.stringify({
        count: 1,
        first_dark_at: new Date(T0 - 120_000).toISOString(),
        last_recovery_at: new Date(T0 - 100_000).toISOString(),
      }),
    );

    const outcome = await runWatchdogRecovery(
      { stateFile: STATE_FILE, confirmProbes: 2, cooldownS: 600 },
      h.deps,
    );

    expect(outcome.action).toBe("suppressed");
    expect(h.starts).toEqual([]);
    // One probe only — a suppressed pass must not burn a follow-up probe.
    expect(h.probes).toHaveLength(1);
    const state = seededCount(h.files);
    expect(state.count).toBe(2); // the dark streak keeps growing — it is not hidden
    expect(state.last_recovery_at).toBe(new Date(T0 - 100_000).toISOString());
  });

  it("allows a restart once the cooldown has elapsed", async () => {
    const h = harness([dark(), alive()]);
    h.files.set(
      STATE_FILE,
      JSON.stringify({
        count: 1,
        first_dark_at: new Date(T0 - 900_000).toISOString(),
        last_recovery_at: new Date(T0 - 700_000).toISOString(),
      }),
    );

    const outcome = await runWatchdogRecovery(
      { stateFile: STATE_FILE, confirmProbes: 2, cooldownS: 600 },
      h.deps,
    );

    expect(outcome.action).toBe("restarted");
    expect(h.starts).toHaveLength(1);
    expect(h.files.has(STATE_FILE)).toBe(false);
  });

  it("cooldown-s=0 disables suppression entirely", async () => {
    const h = harness([dark(), alive()]);
    h.files.set(
      STATE_FILE,
      JSON.stringify({
        count: 1,
        first_dark_at: new Date(T0 - 2_000).toISOString(),
        last_recovery_at: new Date(T0 - 1_000).toISOString(),
      }),
    );

    const outcome = await runWatchdogRecovery(
      { stateFile: STATE_FILE, confirmProbes: 2, cooldownS: 0 },
      h.deps,
    );
    expect(outcome.action).toBe("restarted");
    expect(h.starts).toHaveLength(1);
  });

  it("a corrupt state file is treated as absent (no throw, count starts at 1)", async () => {
    const h = harness([dark()]);
    h.files.set(STATE_FILE, "{not json");

    const outcome = await runWatchdogRecovery(
      { stateFile: STATE_FILE, confirmProbes: 3 },
      h.deps,
    );
    expect(outcome.action).toBe("counted");
    expect(seededCount(h.files).count).toBe(1);
  });
});

describe("runWatchdogRecovery — systemctl failure", () => {
  it("exits nonzero without corrupting state, and does not arm the cooldown", async () => {
    const h = harness([dark(), alive()]);
    h.files.set(
      STATE_FILE,
      JSON.stringify({
        count: 1,
        first_dark_at: new Date(T0 - 60_000).toISOString(),
      }),
    );
    h.failStartWith("Failed to start duckbrain-http.service: Unit not found.");

    const code = await runWatchdogRecoverCli(
      [`--state-file=${STATE_FILE}`, "--confirm-probes=2", "--cooldown-s=600"],
      h.deps,
    );

    expect(code).toBe(WATCHDOG_RECOVER_EXIT.FAILED);
    const state = seededCount(h.files);
    expect(state.count).toBe(2);
    // No attempt timestamp: the restart never reached systemd, so the next
    // timer fire must be free to retry immediately.
    expect(state.last_recovery_at).toBeUndefined();
    expect(state.first_dark_at).toBe(new Date(T0 - 60_000).toISOString());
    expect(h.starts).toEqual([]);

    // Proof the cooldown was not armed: a second pass retries at once.
    const retry = harness([dark(), alive()]);
    retry.files.set(STATE_FILE, h.files.get(STATE_FILE) as string);
    const outcome = await runWatchdogRecovery(
      { stateFile: STATE_FILE, confirmProbes: 2, cooldownS: 600 },
      retry.deps,
    );
    expect(outcome.action).toBe("restarted");
    expect(retry.starts).toHaveLength(1);
  });
});

describe("runWatchdogRecoverCli (exit-code contract)", () => {
  it("exit 0 on alive, 1 on dark-and-unrecovered, 2 on usage error, 0 on --help", async () => {
    const ok = harness([alive()]);
    expect(
      await runWatchdogRecoverCli([`--state-file=${STATE_FILE}`], ok.deps),
    ).toBe(WATCHDOG_RECOVER_EXIT.OK);

    const stillDark = harness([dark(), dark()]);
    expect(
      await runWatchdogRecoverCli(
        [`--state-file=${STATE_FILE}`, "--confirm-probes=1"],
        stillDark.deps,
      ),
    ).toBe(WATCHDOG_RECOVER_EXIT.FAILED);

    const hungPass = harness([hung()]);
    expect(
      await runWatchdogRecoverCli(
        [`--state-file=${STATE_FILE}`],
        hungPass.deps,
      ),
    ).toBe(WATCHDOG_RECOVER_EXIT.OK);

    const usage = harness([]);
    expect(await runWatchdogRecoverCli(["--bogus"], usage.deps)).toBe(
      WATCHDOG_RECOVER_EXIT.USAGE,
    );
    expect(await runWatchdogRecoverCli(["--help"], usage.deps)).toBe(
      WATCHDOG_RECOVER_EXIT.OK,
    );
    // --help must not have probed anything.
    expect(usage.probes).toEqual([]);
  });

  it("--json prints the machine-readable outcome", async () => {
    const h = harness([dark()]);
    const lines: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => {
      lines.push(String(line));
    };
    try {
      await runWatchdogRecoverCli(
        [`--state-file=${STATE_FILE}`, "--confirm-probes=3", "--json"],
        h.deps,
      );
    } finally {
      console.log = original;
    }
    const parsed = JSON.parse(lines[lines.length - 1]) as Record<
      string,
      unknown
    >;
    expect(parsed.action).toBe("counted");
    expect(parsed.count).toBe(1);
    expect(parsed.confirmProbes).toBe(3);
  });
});

describe("scripts/watchdog-recover.js wrapper", () => {
  it("loads the tsx wrapper and exits 0 for --help", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/watchdog-recover.js", "--help"],
      { cwd: process.cwd(), encoding: "utf-8", timeout: 60_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage: node scripts\/watchdog-recover\.js/);
    expect(result.stdout).toMatch(/systemctl --user start/);
    expect(result.stdout).toMatch(/HUNG: no action/);
    expect(result.stdout).toMatch(/auth-exempt/);
  }, 70_000);
});
