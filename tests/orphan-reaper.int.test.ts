import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  CURL_MAX_TIME_S,
  DAEMON_READY_TIMEOUT_MS,
  curl,
  formatReapReport,
  getRandomPort,
  killProcess,
  reapOrphanDaemons,
  run,
  sleep,
  startDuckbrainHttp,
  waitForUrl,
  type DuckbrainChild,
} from "./helpers";

/**
 * DB-GAP-059 integration coverage: the three defects the incident compounded.
 *
 *   1. An untimed `curl()` probe pinned the suite forever instead of failing.
 *   2. A detached scratch daemon has no reaper that survives a hard-killed
 *      spawner, so it reparents to systemd --user and burns the host forever.
 *   3. A scratch daemon that inherits the HOST namespace root walks the real
 *      store (227 namespaces at 10:1 file churn) instead of its own temp root.
 *
 * The unit suite (src/testing/orphan-daemon-reaper.test.ts) asserts the
 * decision table and the bounded probe; this file proves the LIVE path — a
 * real, genuinely orphaned DuckBrain daemon detected through /proc, killed,
 * and reclaimed, with the managed unit untouched.
 */

const REPO_ROOT = process.cwd();
const BIN_TS = path.join(REPO_ROOT, "bin", "duckbrain.ts");
const TMP = os.tmpdir();

/** Is `pid` still alive (signal-0 probe, no signal delivered)? */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Scratch files the daemon would leave behind for `pid`. */
function scratchFilesFor(pid: number): string[] {
  try {
    return fs
      .readdirSync(TMP)
      .filter((f) => f.startsWith(`duckbrain-${pid}-`) && f.endsWith(".db"));
  } catch {
    return [];
  }
}

/** The managed unit's MainPID, or null when the host has no such unit. */
function managedMainPid(): number | null {
  try {
    const out = run(
      "systemctl --user show duckbrain-http.service -p MainPID --value",
    );
    const pid = Number.parseInt(out.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

const MANAGED_PID = managedMainPid();

/** Poll /health on a pid we did not spawn through the helper. */
async function waitForDaemonHealth(
  port: number,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const code = run(
        `curl -sf -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${port}/health`,
      );
      if (code === "200" || code === "503") return;
    } catch {
      // not up yet (or the fail-closed 401 path answered non-zero)
      try {
        const code = run(
          `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${port}/health`,
        );
        if (code === "200" || code === "401" || code === "503") return;
      } catch {}
    }
    await sleep(250);
  }
  throw new Error(`orphan daemon on port ${port} never answered /health`);
}

describe("DB-GAP-059: scratch daemons are hermetic", () => {
  const port = getRandomPort();
  let server: DuckbrainChild;

  beforeAll(async () => {
    server = await startDuckbrainHttp({ port, authType: "none" });
    await waitForUrl(
      `http://127.0.0.1:${port}/health`,
      DAEMON_READY_TIMEOUT_MS,
      server,
    );
  }, 120_000);

  afterAll(() => {
    killProcess(server);
  });

  it("pins DUCKBRAIN_NAMESPACES_PATH to an isolated temp root, never the production store", async () => {
    const productionRoot = path.resolve(REPO_ROOT, "namespaces");
    expect(server.namespacesPath).toBeTruthy();
    const nsPath = path.resolve(server.namespacesPath!);
    expect(nsPath).not.toBe(productionRoot);
    expect(nsPath.startsWith(path.resolve(os.tmpdir()))).toBe(true);
    expect(nsPath.includes("duckbrain-int-")).toBe(true);
    expect(fs.existsSync(nsPath)).toBe(true);

    // The daemon's own environment (read from /proc, not from the helper's
    // bookkeeping) must carry the pin, and it must also pin the config path:
    // an unpinned config is what made a scratch daemon walk the PRODUCTION
    // namespace registry (227 namespaces) on GET /users.
    const env = fs.readFileSync(`/proc/${server.pid}/environ`, "utf-8");
    const pins = Object.fromEntries(
      env
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const at = entry.indexOf("=");
          return [entry.slice(0, at), entry.slice(at + 1)];
        }),
    );
    expect(pins.DUCKBRAIN_NAMESPACES_PATH).toBe(server.namespacesPath);
    expect(pins.DUCKBRAIN_CONFIG_PATH).toBeTruthy();
    expect(
      path.resolve(pins.DUCKBRAIN_CONFIG_PATH!).startsWith(
        path.resolve(os.tmpdir()),
      ),
    ).toBe(true);

    // The observable consequence: the daemon censuses ITS root, so the
    // isolated store holds only `default` — not the host's real namespaces.
    const res = await curl(`http://127.0.0.1:${port}/api/namespaces`);
    expect(res.status).toBe(200);
    const names: string[] = JSON.parse(res.body).namespaces.map(
      (ns: { name: string }) => ns.name,
    );
    expect(names).toEqual(["default"]);
  });

  it("answers /users through the bounded curl() probe without walking the host store", async () => {
    const res = await curl(`http://127.0.0.1:${port}/users`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.count).toBe(body.users.length);
    // No memory authors exist under the scratch root: the daemon did NOT
    // walk the production store (which has hundreds of authors). A hung read
    // would instead have failed the probe at the --max-time bound.
    expect(body.users.length).toBe(0);
    expect(CURL_MAX_TIME_S).toBe(10);
  });
});

describe("DB-GAP-059: orphaned scratch daemon reaper (live /proc)", () => {
  const scratchRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "duckbrain-dbgap059-"),
  );
  const port = getRandomPort();
  let orphanPid = 0;
  let report: ReturnType<typeof reapOrphanDaemons> | null = null;
  let harnessScratch = "";

  beforeAll(async () => {
    fs.mkdirSync(path.join(scratchRoot, "namespaces", "default"), {
      recursive: true,
    });
    // Spawn a REAL daemon from a short-lived intermediate shell: the shell
    // exits immediately, so the daemon reparents to the systemd --user
    // manager (or pid 1) — exactly the incident shape. `setsid` gives it its
    // own session/process group, as startDuckbrainHttp's `detached: true`
    // does for every scratch daemon.
    const log = path.join(scratchRoot, "orphan.log");
    const env = [
      `DUCKBRAIN_NAMESPACES_PATH=${path.join(scratchRoot, "namespaces")}`,
      `DUCKBRAIN_DATA_DIR=${scratchRoot}`,
      `DUCKBRAIN_CONFIG_PATH=${path.join(scratchRoot, "duckbrain.config.json")}`,
      "DUCKBRAIN_EMBEDDING_PROVIDER=openai",
      "DUCKBRAIN_EMBEDDING_API_KEY=",
    ].join(" ");
    const launcher =
      `${env} setsid ${process.execPath} --import tsx ${BIN_TS} ` +
      `http --port=${port} --auth=none >${log} 2>&1 & echo $!`;
    const res = spawnSync("bash", ["-c", launcher], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 30_000,
    });
    orphanPid = Number.parseInt((res.stdout ?? "").trim().split("\n").pop() ?? "", 10);
    if (!Number.isInteger(orphanPid) || orphanPid <= 0) {
      throw new Error(
        `could not start the orphan daemon launcher: ${res.stdout} ${res.stderr}`,
      );
    }
    await waitForDaemonHealth(port);

    // Force the daemon to open namespace connections, so its scratch files
    // exist for the reclaim assertion (best-effort — the harness file below
    // is the deterministic one).
    try {
      await curl(`http://127.0.0.1:${port}/api/namespaces`);
      await curl(`http://127.0.0.1:${port}/users`);
    } catch {
      // /users is bounded now: a stall here must not fail setup.
    }

    harnessScratch = path.join(TMP, `duckbrain-${orphanPid}-harness-0.db`);
    fs.writeFileSync(harnessScratch, "scratch");

    const procStat = fs.readFileSync(`/proc/${orphanPid}/stat`, "utf-8");
    const close = procStat.lastIndexOf(")");
    const ppid = Number.parseInt(procStat.slice(close + 2).trim().split(/\s+/)[1], 10);
    const parentComm = fs.readFileSync(`/proc/${ppid}/comm`, "utf-8").trim();
    // The precondition this whole file rests on: the daemon really is
    // orphaned (reparented to init/systemd --user), not a child of the worker.
    expect(ppid === 1 || parentComm === "systemd").toBe(true);
    expect(isAlive(orphanPid)).toBe(true);

    report = reapOrphanDaemons();
  }, 180_000);

  afterAll(() => {
    // Belt and braces: this file must never leave a daemon behind, even when
    // an assertion above failed before the reaper ran.
    if (orphanPid > 0 && isAlive(orphanPid)) {
      try {
        process.kill(-orphanPid, "SIGKILL");
      } catch {
        try {
          process.kill(orphanPid, "SIGKILL");
        } catch {}
      }
    }
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  it("detects the orphan as a daemon-shaped live listener", () => {
    const observed = report!.observed.find((o) => o.pid === orphanPid);
    expect(observed, formatReapReport(report!)).toBeTruthy();
    expect(observed!.argvPort).toBe(port);
    expect(observed!.listening).toContain(port);
  });

  it("reaps it: killed, and its scratch files reclaimed", () => {
    expect(report!.victims).toContain(orphanPid);
    expect(report!.killed).toContain(orphanPid);
    expect(report!.errors).toEqual([]);
    expect(isAlive(orphanPid)).toBe(false);
    // The reclaim ASSERTION is deterministic even though the removal may be
    // attributed two ways: a daemon that dies on SIGTERM cleans its own
    // scratch files (src/duckdb/connection.ts signal handlers), while the
    // incident's starved daemons only die on SIGKILL and depend on the
    // reaper's reclaim pass. The reaper's own reclaim path is pinned
    // deterministically by the unit suite, on a stand-in daemon with no
    // signal handler.
    expect(fs.existsSync(harnessScratch)).toBe(false);
    // No `duckbrain-<pid>-*` file survives anywhere in the temp dir.
    expect(scratchFilesFor(orphanPid)).toEqual([]);
  });

  it("leaves nothing behind: a fresh scan finds no orphan on that port", () => {
    const rescan = reapOrphanDaemons({ dryRun: true });
    const leftover = rescan.observed.filter((o) => o.pid === orphanPid);
    expect(leftover).toEqual([]);
    expect(rescan.victims).not.toContain(orphanPid);
  });

  it.skipIf(MANAGED_PID === null)(
    "never touches the managed duckbrain-http.service daemon",
    () => {
      const scan = reapOrphanDaemons({ dryRun: true });
      expect(scan.victims).not.toContain(MANAGED_PID);
      const spared = scan.spared.find((s) => s.pid === MANAGED_PID);
      expect(spared?.reason).toMatch(/protected pid|protected port/);
      expect(isAlive(MANAGED_PID!)).toBe(true);
    },
  );
});
