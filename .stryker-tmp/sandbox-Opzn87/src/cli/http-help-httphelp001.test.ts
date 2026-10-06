/**
 * HTTP-HELP-001 regression tests (in-process seam): the `duckbrain http`
 * front door must answer a bare --help/-h ANYWHERE in its args with the
 * options block on STDOUT and return WITHOUT starting the server.
 *
 * Before the fix the bin entry ignored --help entirely and went straight to
 * startHttpMode — binding :3000 (EADDRINUSE under an already-running
 * daemon) or silently starting a server on a free port. The production
 * start() is startHttpMode, the only caller of createHttpServer() on this
 * path, so an injected recorder proving "start never called" transitively
 * proves the server factory never runs for a help request.
 *
 * The seam tests also pin the parse behavior the fix moved from
 * bin/duckbrain.ts into handleHttpCommand(): the no-flag defaults (port
 * 3000, rateLimit 100) and both flag forms, guarding the extraction
 * refactor itself. One default moved: authType's no-flag value is now
 * "apikey" (REVIEW-DUCKBRAIN-006) — the flag vocabulary and the parse
 * shape are unchanged, and an explicit --auth=none is still honored
 * (and warns on stderr).
 *
 * e2e (spawn) coverage lives in http-help-e2e-httphelp001.test.ts.
 */
// @ts-nocheck


import { describe, it, expect } from "vitest";
import { handleHttpCommand } from "./http";

/** Capture console.log lines for the duration of fn (recall-help pattern). */
async function captureLogs(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...a: any[]) => {
    lines.push(a.join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
  }
  return lines;
}

/** Capture console.error lines for the duration of fn (warning capture). */
async function captureErr(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const origErr = console.error;
  console.error = (...a: any[]) => {
    lines.push(a.join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = origErr;
  }
  return lines;
}

/** Recorder standing in for startHttpMode: never starts anything. */
function makeStartRecorder(): {
  start: (options: any) => Promise<void>;
  calls: any[];
} {
  const calls: any[] = [];
  return {
    start: async (options: any) => {
      calls.push(options);
    },
    calls,
  };
}

describe("HTTP-HELP-001: handleHttpCommand help short-circuit", () => {
  it("help path prints options and NEVER calls start (=> createHttpServer never runs)", async () => {
    const rec = makeStartRecorder();
    const lines = await captureLogs(() =>
      handleHttpCommand(["--help"], { start: rec.start }),
    );
    const out = lines.join("\n");

    expect(out).toMatch(/Usage: duckbrain http/);
    expect(out).toContain("--port=");
    expect(out).toContain("--rate-limit=");
    expect(rec.calls).toHaveLength(0);
  });

  it("-h path never calls start", async () => {
    const rec = makeStartRecorder();
    const lines = await captureLogs(() =>
      handleHttpCommand(["-h"], { start: rec.start }),
    );

    expect(lines.join("\n")).toMatch(/Usage: duckbrain http/);
    expect(rec.calls).toHaveLength(0);
  });

  it("--help after other flags still short-circuits before start", async () => {
    const rec = makeStartRecorder();
    const lines = await captureLogs(() =>
      handleHttpCommand(["--bind-all", "--help"], { start: rec.start }),
    );

    expect(lines.join("\n")).toMatch(/Usage: duckbrain http/);
    expect(rec.calls).toHaveLength(0);
  });
});

describe("HTTP-HELP-001: parse behavior preserved through the extraction", () => {
  it("no-flag auth default is fail-closed apikey (REVIEW-DUCKBRAIN-006)", async () => {
    const rec = makeStartRecorder();
    const result = await handleHttpCommand([], { start: rec.start });

    expect(result.helped).toBe(false);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toEqual({
      port: 3000,
      authType: "apikey",
      authFile: undefined,
      rateLimit: 100,
      bindAll: false,
      socket: undefined,
      socketMode: undefined,
      socketGroup: undefined,
    });
  });

  it("space-form flags still parse (--port 5555 --rate-limit 60)", async () => {
    const rec = makeStartRecorder();
    await handleHttpCommand(["--port", "5555", "--rate-limit", "60"], {
      start: rec.start,
    });

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].port).toBe(5555);
    expect(rec.calls[0].rateLimit).toBe(60);
  });

  it("=-form flags still parse (auth, unix-socket family, auth-file)", async () => {
    const rec = makeStartRecorder();
    await handleHttpCommand(
      [
        "--auth=basic",
        "--unix-socket=/tmp/db-test.sock",
        "--unix-socket-mode=0660",
        "--unix-socket-group=docker",
        "--auth-file=/tmp/db-test-auth.json",
      ],
      { start: rec.start },
    );

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].authType).toBe("basic");
    expect(rec.calls[0].socket).toBe("/tmp/db-test.sock");
    expect(rec.calls[0].socketMode).toBe("0660");
    expect(rec.calls[0].socketGroup).toBe("docker");
    expect(rec.calls[0].authFile).toBe("/tmp/db-test-auth.json");
  });
});

describe("REVIEW-DUCKBRAIN-006: explicit --auth=none opt-out is honored and loud", () => {
  /**
   * The default is fail-closed (apikey), so the unauthenticated-mode warning
   * fires EXACTLY when the operator asked for none — it is the operator's
   * evidence that the door is open, not noise on every start.
   */
  it("--auth=none still resolves none and prints the unauthenticated warning to stderr", async () => {
    const rec = makeStartRecorder();
    const errs = await captureErr(() =>
      handleHttpCommand(["--auth=none"], { start: rec.start }),
    );

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].authType).toBe("none");
    const stderr = errs.join("\n");
    expect(stderr).toMatch(/WARNING/);
    expect(stderr).toMatch(/UNAUTHENTICATED/);
    expect(stderr).toContain("--auth=none");
  });

  it("space form (--auth none) is honored and warns the same way", async () => {
    const rec = makeStartRecorder();
    const errs = await captureErr(() =>
      handleHttpCommand(["--auth", "none"], { start: rec.start }),
    );

    expect(rec.calls[0].authType).toBe("none");
    expect(errs.join("\n")).toMatch(/UNAUTHENTICATED/);
  });

  it("no --auth prints NO warning (the default already is apikey)", async () => {
    const rec = makeStartRecorder();
    const errs = await captureErr(() =>
      handleHttpCommand([], { start: rec.start }),
    );

    expect(rec.calls[0].authType).toBe("apikey");
    expect(errs.join("\n")).not.toMatch(/UNAUTHENTICATED/);
  });

  it("explicit --auth=apikey prints NO warning", async () => {
    const rec = makeStartRecorder();
    const errs = await captureErr(() =>
      handleHttpCommand(["--auth=apikey"], { start: rec.start }),
    );

    expect(rec.calls[0].authType).toBe("apikey");
    expect(errs.join("\n")).not.toMatch(/WARNING/);
  });

  it("the printed help advertises apikey as the default and marks none unsafe", async () => {
    const rec = makeStartRecorder();
    const lines = await captureLogs(() =>
      handleHttpCommand(["--help"], { start: rec.start }),
    );
    const out = lines.join("\n");

    expect(rec.calls).toHaveLength(0);
    expect(out).toMatch(/--auth=TYPE/);
    expect(out).toContain("(default: apikey");
    expect(out).toMatch(/UNSAFE/);
  });
});
