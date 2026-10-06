import { afterEach, describe, expect, it } from "vitest";
import { ChildProcess, spawn } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import {
  DEFAULT_HTTP_PORT,
  ProcessInfo,
  cmdlineFromProc,
  isDaemonShaped,
  isOrphaned,
  listProcesses,
  parseListeningTcpTable,
  parseProcStat,
  pidIsReaped,
  planDaemonReap,
  portFromCmdline,
  procStatShowsZombie,
  reclaimScratchFilesForPid,
  reapOrphanDaemons,
  socketInodesFromLinks,
} from "./orphan-daemon-reaper";
import { CURL_MAX_TIME_S, curl } from "../../tests/helpers";

/**
 * DB-GAP-059 unit coverage for the orphaned scratch-daemon reaper.
 *
 * The module's real work is decision-making, so the parsers and the kill
 * planner are asserted directly against literal /proc data and synthetic
 * process tables; the kill + reclaim path runs against a REAL spawned
 * process, and the integration suite (tests/orphan-reaper.int.test.ts)
 * proves the live /proc + orphan-detection path end to end.
 */

/** Build a ProcessInfo with sensible defaults for the fields under test. */
function proc(
  over: Partial<ProcessInfo> & { pid: number; cmdline: string },
): ProcessInfo {
  return {
    ppid: 1,
    pgrp: over.pid,
    ppidIsUserManager: false,
    listeningPorts: [],
    ...over,
  };
}

/** The managed unit's real argv (duckbrain-http.service, port 3000). */
const MANAGED_CMDLINE =
  "/usr/bin/node bin/duckbrain.js http --port 3000 --bind-all --auth=apikey --rate-limit 600";

/** The scratch-daemon argv startDuckbrainHttp produces. */
const SCRATCH_CMDLINE = "node --import tsx bin/duckbrain.ts http --port=33523";

const spawned: ChildProcess[] = [];

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
});

describe("parseProcStat / cmdlineFromProc (DB-GAP-059)", () => {
  it("reads state, ppid and pgrp from a real stat line", () => {
    const line =
      "1234 (node) S 1 1234 1234 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 11 0 900 123 45 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0";
    expect(parseProcStat(line)).toEqual({ state: "S", ppid: 1, pgrp: 1234 });
  });

  it("counts fields from the LAST ')' so a spaced comm is not mis-parsed", () => {
    // comm is wrapped in parens and may contain spaces and parens itself.
    const line = "42 ((node)) Z 777 42 42 0 -1 0";
    expect(parseProcStat(line)).toEqual({ state: "Z", ppid: 777, pgrp: 42 });
  });

  it("returns null for a malformed stat line", () => {
    expect(parseProcStat("no parens here")).toBeNull();
    expect(parseProcStat("1 (x) S not-a-pid 1")).toBeNull();
  });

  it("joins a NUL-separated cmdline", () => {
    expect(
      cmdlineFromProc("node\0--import\0tsx\0bin/duckbrain.ts\0http\0--port=21000\0"),
    ).toBe("node --import tsx bin/duckbrain.ts http --port=21000");
    expect(cmdlineFromProc("")).toBe("");
  });

  it("treats a zombie state as reaped", () => {
    expect(procStatShowsZombie("9 (node) Z 1 9 9 0 -1 0")).toBe(true);
    expect(procStatShowsZombie("9 (node) S 1 9 9 0 -1 0")).toBe(false);
    expect(procStatShowsZombie("garbage")).toBe(false);
  });

  it("sees a live process as not reaped and a dead pid as reaped", () => {
    expect(pidIsReaped(process.pid)).toBe(false);
    expect(pidIsReaped(2147483647)).toBe(true);
  });
});

describe("isDaemonShaped / portFromCmdline (DB-GAP-059)", () => {
  it("accepts both real daemon shapes", () => {
    expect(isDaemonShaped(MANAGED_CMDLINE)).toBe(true);
    expect(isDaemonShaped(SCRATCH_CMDLINE)).toBe(true);
    expect(isDaemonShaped("/usr/bin/node /opt/db/bin/duckbrain.ts http --port 8080")).toBe(
      true,
    );
  });

  it("rejects the stdio MCP server (no http subcommand, no port)", () => {
    expect(isDaemonShaped("node bin/duckbrain.js stdio")).toBe(false);
    expect(isDaemonShaped("/home/kara/.local/bin/node bin/duckbrain.js stdio")).toBe(
      false,
    );
  });

  it("rejects carriers that merely quote the daemon shape", () => {
    // The incident's own audit was polluted by exactly these two shapes.
    expect(isDaemonShaped("pgrep -af duckbrain http --port=21000")).toBe(false);
    expect(isDaemonShaped('grep -rn "duckbrain http --port=21000" .')).toBe(false);
    expect(
      isDaemonShaped(
        'bash -lic set +m; hermes chat -q "node --import tsx bin/duckbrain.ts http --port=21000"',
      ),
    ).toBe(false);
    expect(isDaemonShaped("python3 /home/kara/duckbrain_sync.py --port 3000")).toBe(
      false,
    );
  });

  it("rejects daemon-shaped argv missing the http subcommand or a port", () => {
    expect(isDaemonShaped("node bin/duckbrain.js")).toBe(false);
    expect(isDaemonShaped("node bin/duckbrain.js http")).toBe(false);
    expect(isDaemonShaped("node bin/duckbrain.js --port=3000")).toBe(false);
  });

  it("parses both port spellings and rejects nonsense", () => {
    expect(portFromCmdline(SCRATCH_CMDLINE)).toBe(33523);
    expect(portFromCmdline(MANAGED_CMDLINE)).toBe(3000);
    expect(portFromCmdline("node bin/duckbrain.js http")).toBeNull();
    expect(portFromCmdline("node bin/duckbrain.js http --port=abc")).toBeNull();
    expect(portFromCmdline("node bin/duckbrain.js http --port=99999")).toBeNull();
  });
});

describe("parseListeningTcpTable / socketInodesFromLinks (DB-GAP-059)", () => {
  it("maps only LISTEN sockets to their ports", () => {
    const table = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000:635D 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1079232081 1 0 0 10 0",
      "   1: 0100007F:4F12 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1639498524 2 0 0 10 0",
      "   2: 0100007F:1F90 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 1944248617 1 0 0 10 0",
      "",
    ].join("\n");
    const byInode = parseListeningTcpTable(table);
    expect([...byInode.entries()]).toEqual([
      [1079232081, 0x635d],
      [1639498524, 0x4f12],
    ]);
    // The ESTABLISHED (state 01) socket is NOT a listener.
    expect(byInode.has(1944248617)).toBe(false);
  });

  it("extracts socket inodes from fd link targets", () => {
    expect(
      socketInodesFromLinks([
        "socket:[1944248617]",
        "socket:[42]",
        "anon_inode:[eventfd]",
        "/tmp/duckbrain-x.db",
        "",
      ]),
    ).toEqual([1944248617, 42]);
  });
});

describe("planDaemonReap (DB-GAP-059)", () => {
  const own = { ownTree: [process.pid], ownPgrp: undefined };

  it("spares the managed unit daemon by MainPID", () => {
    const managed = proc({
      pid: 1306104,
      ppid: 3198877,
      ppidIsUserManager: true,
      cmdline: MANAGED_CMDLINE,
    });
    const { victims, spared } = planDaemonReap([managed], {
      ...own,
      protectedPids: [1306104],
    });
    expect(victims).toEqual([]);
    expect(spared).toEqual([
      { pid: 1306104, reason: "protected pid (managed unit MainPID)" },
    ]);
  });

  it("spares a daemon on a protected port even without its MainPID", () => {
    const managed = proc({
      pid: 555,
      ppid: 1,
      cmdline: MANAGED_CMDLINE,
    });
    const { victims, spared } = planDaemonReap([managed], {
      ...own,
      protectedPorts: [DEFAULT_HTTP_PORT],
    });
    expect(victims).toEqual([]);
    expect(spared[0].reason).toMatch(/protected port 3000/);
  });

  it("spares a daemon inside a managed unit's ControlGroup", () => {
    const managed = proc({ pid: 556, ppid: 1, cmdline: MANAGED_CMDLINE });
    const { victims, spared } = planDaemonReap([managed], {
      ...own,
      candidateCgroups: new Map([
        [556, "/user.slice/app.slice/duckbrain-http.service"],
      ]),
      managedCgroups: ["/user.slice/app.slice/duckbrain-http.service"],
    });
    expect(victims).toEqual([]);
    expect(spared[0].reason).toMatch(/managed unit cgroup/);
  });

  it("selects the incident shape: an orphaned scratch daemon (ppid 1)", () => {
    const orphan = proc({ pid: 1933499, ppid: 1, cmdline: SCRATCH_CMDLINE });
    const { victims, spared } = planDaemonReap([orphan], own);
    expect(victims.map((p) => p.pid)).toEqual([1933499]);
    expect(spared).toEqual([]);
  });

  it("selects an orphan reparented to the systemd --user manager", () => {
    const orphan = proc({
      pid: 3427633,
      ppid: 3198877,
      ppidIsUserManager: true,
      cmdline: SCRATCH_CMDLINE,
    });
    const { victims } = planDaemonReap([orphan], own);
    expect(victims.map((p) => p.pid)).toEqual([3427633]);
  });

  it("spares a scratch daemon whose spawner is still alive", () => {
    const live = proc({
      pid: 4000,
      ppid: process.pid,
      cmdline: SCRATCH_CMDLINE,
    });
    const { victims, spared } = planDaemonReap([live], own);
    expect(victims).toEqual([]);
    expect(spared[0].reason).toMatch(/live parent/);
  });

  it("never selects itself or its own process group", () => {
    const self = proc({ pid: process.pid, ppid: 1, cmdline: SCRATCH_CMDLINE });
    const ownGroup = proc({
      pid: 4001,
      ppid: 1,
      pgrp: 7777,
      cmdline: SCRATCH_CMDLINE,
    });
    const { victims, spared } = planDaemonReap([self, ownGroup], {
      ownTree: [process.pid],
      ownPgrp: 7777,
    });
    expect(victims).toEqual([]);
    expect(spared.map((s) => s.reason)).toEqual([
      "own process tree",
      "own process group",
    ]);
  });

  it("ignores non-daemon processes entirely", () => {
    const stdio = proc({ pid: 4002, ppid: 1, cmdline: "node bin/duckbrain.js stdio" });
    const carrier = proc({ pid: 4003, ppid: 1, cmdline: "grep duckbrain http --port=1" });
    const { victims, spared } = planDaemonReap([stdio, carrier], own);
    expect(victims).toEqual([]);
    expect(spared).toEqual([]);
  });

  it("reports isOrphaned for both reparenting targets", () => {
    expect(isOrphaned(proc({ pid: 1, ppid: 1, cmdline: SCRATCH_CMDLINE }))).toBe(true);
    expect(
      isOrphaned(
        proc({
          pid: 2,
          ppid: 9,
          ppidIsUserManager: true,
          cmdline: SCRATCH_CMDLINE,
        }),
      ),
    ).toBe(true);
    expect(isOrphaned(proc({ pid: 3, ppid: 4, cmdline: SCRATCH_CMDLINE }))).toBe(false);
  });
});

describe("reclaimScratchFilesForPid (DB-GAP-059)", () => {
  it("removes only the dead pid's scratch files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbgap059-reclaim-"));
    const mine = path.join(dir, "duckbrain-4242-abc-0.db");
    const mine2 = path.join(dir, "duckbrain-4242-abc-1.db");
    const otherPid = path.join(dir, "duckbrain-9999-abc-0.db");
    const notScratch = path.join(dir, "duckbrain-4242-abc-0.tmp");
    for (const file of [mine, mine2, otherPid, notScratch]) {
      fs.writeFileSync(file, "x");
    }
    expect(reclaimScratchFilesForPid(4242, dir).sort()).toEqual(
      [mine, mine2].sort(),
    );
    expect(fs.existsSync(mine)).toBe(false);
    expect(fs.existsSync(otherPid)).toBe(true); // another pid's file survives
    expect(fs.existsSync(notScratch)).toBe(true); // non-.db survives
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op on an unreadable temp dir", () => {
    expect(reclaimScratchFilesForPid(4242, "/no/such/dir")).toEqual([]);
  });
});

describe("reapOrphanDaemons kill path (DB-GAP-059)", () => {
  it("kills a live daemon-shaped orphan and reclaims its scratch file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbgap059-kill-"));
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    const script = path.join(binDir, "duckbrain.js");
    // A stand-in daemon: daemon-shaped argv, alive until signalled.
    fs.writeFileSync(script, "setInterval(() => {}, 1000);\n");
    const port = 21500 + Math.floor(Math.random() * 400);
    const child = spawn(process.execPath, [script, "http", `--port=${port}`], {
      detached: true,
      stdio: "ignore",
    });
    spawned.push(child);
    const pid = child.pid!;
    expect(pid).toBeGreaterThan(0);

    const scratch = path.join(dir, `duckbrain-${pid}-deadbeef-0.db`);
    const foreign = path.join(dir, `duckbrain-${process.pid}-deadbeef-0.db`);
    fs.writeFileSync(scratch, "scratch");
    fs.writeFileSync(foreign, "foreign");

    // The seam supplies the shape read from /proc: this process is detached
    // (own session/process group) and reparents to the user manager once its
    // spawner exits — modelled here as ppid 1.
    const fake = proc({ pid, ppid: 1, cmdline: `${process.execPath} ${script} http --port=${port}` });
    const report = reapOrphanDaemons({ processes: [fake], tmpDir: dir });

    expect(report.victims).toEqual([pid]);
    expect(report.killed).toEqual([pid]);
    expect(report.reclaimed).toEqual([scratch]);
    expect(report.errors).toEqual([]);
    expect(fs.existsSync(scratch)).toBe(false);
    expect(fs.existsSync(foreign)).toBe(true);
    expect(pidIsReaped(pid)).toBe(true);
    expect(report.observed).toEqual([
      { pid, argvPort: port, listening: [] },
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves a daemon-shaped process with a LIVE parent running", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbgap059-live-"));
    const script = path.join(dir, "duckbrain.js");
    fs.writeFileSync(script, "setInterval(() => {}, 1000);\n");
    const child = spawn(process.execPath, [script, "http", "--port=21600"], {
      detached: true,
      stdio: "ignore",
    });
    spawned.push(child);
    const pid = child.pid!;

    const fake = proc({
      pid,
      ppid: process.pid,
      cmdline: `${process.execPath} ${script} http --port=21600`,
    });
    const report = reapOrphanDaemons({ processes: [fake], tmpDir: dir, dryRun: true });
    expect(report.victims).toEqual([]);
    expect(report.spared[0].reason).toMatch(/live parent/);
    expect(pidIsReaped(pid)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("dry-run reports the victim without killing it", () => {
    const fake = proc({
      pid: 1933499,
      ppid: 1,
      cmdline: SCRATCH_CMDLINE,
    });
    const report = reapOrphanDaemons({ processes: [fake], dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.victims).toEqual([1933499]);
    expect(report.killed).toEqual([]);
  });

  it("scans the real process table without throwing", () => {
    // Live /proc scan: shape only, no assertion about the host's daemons.
    const processes = listProcesses();
    if (process.platform !== "linux") {
      expect(processes).toEqual([]);
      return;
    }
    expect(processes.length).toBeGreaterThan(0);
    for (const entry of processes) {
      expect(entry.pid).toBeGreaterThan(0);
      expect(entry.ppid).toBeGreaterThanOrEqual(0);
    }
    const report = reapOrphanDaemons({ dryRun: true });
    expect(report.scanned).toBe(processes.length);
    // The managed unit is protected, so it can never be a victim.
    for (const victim of report.victims) {
      expect(victim).not.toBe(process.pid);
    }
  });
});

describe("curl() probe bound (DB-GAP-059)", () => {
  it("fails a stalled probe at the --max-time bound instead of hanging", async () => {
    expect(CURL_MAX_TIME_S).toBe(10);
    const sockets = new Set<net.Socket>();
    // A server that accepts the connection and never answers.
    const server = net.createServer((socket) => {
      sockets.add(socket);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const port = (server.address() as net.AddressInfo).port;

    const started = Date.now();
    await expect(curl(`http://127.0.0.1:${port}/users`)).rejects.toThrow(
      /exceeded --max-time 10s/,
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(9_000);
    expect(elapsed).toBeLessThan(CURL_MAX_TIME_S * 1_000 + 5_000);

    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 30_000);
});
