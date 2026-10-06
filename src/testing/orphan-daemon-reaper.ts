/**
 * Orphaned scratch-daemon reaper (DB-GAP-059).
 *
 * WHY THIS EXISTS (2026-09-25 incident, board row DB-GAP-059):
 *
 * `tests/helpers.ts startDuckbrainHttp` spawns each scratch daemon with
 * `detached: true` so `killProcess` can SIGTERM the whole tree. The daemon
 * therefore owns its process group and SURVIVES its spawner. The only reaper
 * is `killProcess` in a suite's `afterAll`, which never runs when a run is
 * hard-killed or a request stalls. Two orphans were found live at once —
 * pid 1933499 (:33523: 2h13m, 3.7 GB RSS, 10950 FDs) and pid 3427633
 * (:30720: 1h34m, 3.9 GB RSS, 9271 FDs), 41% CPU each, neither dying on
 * SIGTERM (the event loop is starved by DuckDB scratch-file churn, so the
 * signal cannot be handled — SIGKILL is the real kill).
 *
 * `src/duckdb/connection.ts#sweepOrphanScratchFiles` reclaims only FILES whose
 * embedded pid is dead; nothing ever reclaimed an orphaned PROCESS.
 *
 * SCOPE (deliberately narrow — never a general process killer):
 *
 *   - It kills only processes that are BOTH daemon-shaped (a DuckBrain `http`
 *     subcommand with a `--port` flag in argv) AND orphaned (reparented to
 *     pid 1 or to a systemd `--user` manager, i.e. their spawner is gone).
 *     A scratch daemon inside a LIVE run is a direct child of its vitest fork
 *     worker, so a healthy run is never a victim.
 *   - The managed `duckbrain-http.service` daemon is protected by systemd's
 *     OWN reporting (MainPID + ControlGroup of every `duckbrain*` user unit),
 *     not by a cgroup-leaf test: an agent terminal also runs inside a service
 *     cgroup, so "inside a .service cgroup" would classify every
 *     worker-spawned stray as managed. Its port is protected too.
 *   - The reaper never touches its own pid, its ancestors, or its own process
 *     group.
 *
 * OUT OF SCOPE: production daemon lifecycle (systemd --user owns it) and the
 * session-abandoned class where the daemon keeps a LIVE parent (the hermes
 * gateway) — that shape is the host-side guard's job
 * (`~/.hermes/scripts/stray-duckbrain-reaper.py`, 60s timer).
 *
 * WHERE IT RUNS: the integration suite's globalSetup performs a startup sweep
 * (and a teardown sweep) — see `tests/global-setup.integration.ts`. It is safe
 * to call at any time from a test or an operator shell:
 *
 *   // dry run: report only
 *   reapOrphanDaemons({ dryRun: true })
 *
 * MANUAL VERIFICATION PATH: run the integration suite, then
 *   `pgrep -af 'duckbrain.*http'`   -> only the managed unit (port 3000) or nothing
 *   `ls /tmp/duckbrain-*.db`        -> no files whose embedded pid is dead
 * or run the automated wrappers: `tests/orphan-reaper.int.test.ts`
 * (integration) and `src/testing/orphan-daemon-reaper.test.ts` (unit).
 *
 * Linux-only in practice: detection reads /proc. On a platform without /proc
 * every scan returns empty (the reaper is a no-op, never a false kill).
 */

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { isPidAlive } from "../utils/pidfile.js";

/** A process as observed from /proc (or supplied by a test seam). */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Process-group id; a group kill is only safe when this equals `pid`. */
  pgrp: number;
  /** Full argv, space-joined (NUL-separated in /proc/<pid>/cmdline). */
  cmdline: string;
  /** /proc/<ppid>/cmdline belongs to a systemd `--user` manager. */
  ppidIsUserManager: boolean;
  /** TCP ports this pid LISTENs on (evidence; may be empty). */
  listeningPorts: number[];
}

/** Why a daemon-shaped process was spared — an audit trail for `--dry-run`. */
export interface SparedProcess {
  pid: number;
  reason: string;
}

export interface ReapOptions {
  /** Report victims but kill nothing. */
  dryRun?: boolean;
  /** Test seam: use these processes instead of scanning /proc. */
  processes?: ProcessInfo[];
  /** Pids that must never be reaped (e.g. a managed unit's MainPID). */
  protectedPids?: Iterable<number>;
  /** Ports that must never be reaped (e.g. the managed unit's port). */
  protectedPorts?: Iterable<number>;
  /** Temp dir holding `duckbrain-<pid>-*.db` scratch files. */
  tmpDir?: string;
  /** How long to wait for SIGTERM before escalating to SIGKILL. */
  sigtermTimeoutMs?: number;
  /** How long to wait for SIGKILL to land. */
  sigkillTimeoutMs?: number;
}

export interface ReapReport {
  dryRun: boolean;
  /** Number of processes examined. */
  scanned: number;
  /** Daemon-shaped ORPHANED, non-protected pids selected for reaping. */
  victims: number[];
  /** Of `victims`, the pids confirmed dead (killed or already gone). */
  killed: number[];
  /** Scratch files reclaimed for the victims. */
  reclaimed: string[];
  /** Daemon-shaped processes deliberately left alone, with the clause. */
  spared: SparedProcess[];
  /**
   * Every daemon-shaped process seen, with the port in its argv and the ports
   * it is actually LISTENing on (evidence — the listener is not a kill
   * precondition: a starved daemon still holds its listening socket, and a
   * half-dead one is still a leak).
   */
  observed: Array<{ pid: number; argvPort: number | null; listening: number[] }>;
  /** Non-fatal errors from the scan/kill/reclaim steps. */
  errors: string[];
}

/** The CLI default HTTP port (`duckbrain http` without `--port`). */
export const DEFAULT_HTTP_PORT = 3000;

/**
 * Executable basenames that may legitimately launch a DuckBrain daemon.
 * A process whose argv[0] is anything else (bash, grep, python, an editor) is
 * a CARRIER — it merely mentions the daemon shape in its arguments — and is
 * never a victim. Learned the hard way by forkbomb-reaper: a substring test
 * killed the very dispatches that described the incident.
 */
const DAEMON_EXECUTABLES = /^(node|nodejs|tsx|bun|deno)$/;

/** `/path/to/bin/duckbrain`, `duckbrain.js`, `duckbrain.ts`. */
const DAEMON_SCRIPT = /(^|\/)duckbrain(\.[jt]s)?$/;

const SCRATCH_FILE_PREFIX = "duckbrain-";
const SCRATCH_FILE_SUFFIX = ".db";

/**
 * Parse the numeric fields we need out of a /proc/<pid>/stat line.
 *
 * The comm field is wrapped in parentheses and MAY contain spaces and
 * parentheses ("(node)"), so the fields are counted from the LAST ')'
 * — splitting naively on whitespace mis-parses any such process.
 */
export function parseProcStat(
  content: string,
): { state: string; ppid: number; pgrp: number } | null {
  const close = content.lastIndexOf(")");
  if (close < 0) return null;
  const fields = content.slice(close + 2).trim().split(/\s+/);
  const state = fields[0];
  const ppid = Number.parseInt(fields[1] ?? "", 10);
  const pgrp = Number.parseInt(fields[2] ?? "", 10);
  if (!state || !Number.isInteger(ppid) || !Number.isInteger(pgrp)) {
    return null;
  }
  return { state, ppid, pgrp };
}

/** Space-join a NUL-separated /proc/<pid>/cmdline, dropping the trailing NUL. */
export function cmdlineFromProc(raw: string): string {
  return raw.split("\0").filter(Boolean).join(" ").trim();
}

/**
 * True when `cmdline` is a DuckBrain HTTP daemon invocation.
 *
 * Every clause is a measured discriminator: the real managed daemon is
 * `/usr/bin/node bin/duckbrain.js http --port 3000 --bind-all ...` and a
 * scratch daemon is `node --import tsx bin/duckbrain.ts http --port=21000`,
 * while `node bin/duckbrain.js stdio` (the MCP server) has no `http`
 * subcommand and no port, and a shell/grep/python carrier has a non-daemon
 * argv[0].
 */
export function isDaemonShaped(cmdline: string): boolean {
  const tokens = cmdline.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return false;

  const exec = path.basename(tokens[0]);
  if (!DAEMON_EXECUTABLES.test(exec) && !DAEMON_SCRIPT.test(exec)) return false;

  // The daemon script must be the executable itself or an early argument
  // (node --import tsx <script>, or a node wrapper's argv[1]).
  const scriptIdx = tokens.findIndex(
    (token, index) => index <= 5 && DAEMON_SCRIPT.test(token),
  );
  if (scriptIdx < 0) return false;

  const subcommand = tokens[scriptIdx + 1];
  const subcommand2 = tokens[scriptIdx + 2];
  if (subcommand !== "http" && subcommand2 !== "http") return false;

  return portFromCmdline(cmdline) !== null;
}

/** The `--port=N` / `--port N` value, or null when absent/still in braces. */
export function portFromCmdline(cmdline: string): number | null {
  const tokens = cmdline.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("--port")) continue;
    const inline = /^--port=(.+)$/.exec(token)?.[1];
    const value = inline ?? tokens[i + 1];
    if (!value) return null;
    const port = Number.parseInt(value, 10);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  }
  return null;
}

/**
 * Map LISTEN-ing sockets from a /proc/net/tcp[6] table to their ports.
 * `inode -> port`. Pure: `content` is the file's text, so the decoder is
 * testable without a live listener.
 */
export function parseListeningTcpTable(content: string): Map<number, number> {
  const byInode = new Map<number, number>();
  for (const line of content.split("\n").slice(1)) {
    // sl local_address rem_address st tx:rx tr:tm retrnsmt uid timeout inode
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const localAddress = fields[1];
    const state = fields[3];
    const inode = fields[9];
    if (state !== "0A") continue; // TCP_LISTEN
    const port = Number.parseInt(localAddress?.split(":")[1] ?? "", 16);
    const socketInode = Number.parseInt(inode ?? "", 10);
    if (!Number.isInteger(port) || !Number.isInteger(socketInode)) continue;
    byInode.set(socketInode, port);
  }
  return byInode;
}

/** Socket inodes referenced by /proc/<pid>/fd symlink targets. */
export function socketInodesFromLinks(links: string[]): number[] {
  const inodes: number[] = [];
  for (const link of links) {
    const match = /^socket:\[(\d+)\]$/.exec(link.trim());
    if (match) inodes.push(Number.parseInt(match[1], 10));
  }
  return inodes;
}

function readTextFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/** True when /proc/<ppid> is a systemd `--user` manager (reparenting target). */
export function isSystemdUserManager(ppid: number, procRoot = "/proc"): boolean {
  const comm = readTextFile(path.join(procRoot, String(ppid), "comm"));
  if (!comm || comm.trim() !== "systemd") return false;
  const cmdline = readTextFile(path.join(procRoot, String(ppid), "cmdline"));
  if (!cmdline) return false;
  const tokens = cmdlineFromProc(cmdline).split(" ").filter(Boolean);
  return (
    tokens.length >= 2 &&
    path.basename(tokens[0]).startsWith("systemd") &&
    tokens.includes("--user")
  );
}

/** TCP ports a pid is LISTENing on (best-effort; [] when unreadable). */
export function listeningPortsForPid(pid: number, procRoot = "/proc"): number[] {
  const fdDir = path.join(procRoot, String(pid), "fd");
  let links: string[];
  try {
    links = fs.readdirSync(fdDir).map((fd) => {
      try {
        return fs.readlinkSync(path.join(fdDir, fd));
      } catch {
        return "";
      }
    });
  } catch {
    return [];
  }
  const inodes = new Set(socketInodesFromLinks(links));
  if (inodes.size === 0) return [];

  const byInode = new Map<number, number>();
  for (const table of ["net/tcp", "net/tcp6"]) {
    const content = readTextFile(path.join(procRoot, table));
    if (!content) continue;
    for (const [inode, port] of parseListeningTcpTable(content)) {
      byInode.set(inode, port);
    }
  }
  const ports = new Set<number>();
  for (const inode of inodes) {
    const port = byInode.get(inode);
    if (port !== undefined) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** Enumerate every process visible in /proc (Linux). */
export function listProcesses(procRoot = "/proc"): ProcessInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(procRoot);
  } catch {
    return []; // not Linux / no procfs: the reaper is a no-op
  }
  const processes: ProcessInfo[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number.parseInt(name, 10);
    const stat = readTextFile(path.join(procRoot, name, "stat"));
    if (!stat) continue;
    const parsed = parseProcStat(stat);
    if (!parsed) continue;
    const rawCmdline = readTextFile(path.join(procRoot, name, "cmdline"));
    const cmdline = rawCmdline ? cmdlineFromProc(rawCmdline) : "";
    if (!cmdline) continue; // kernel threads have an empty cmdline
    processes.push({
      pid,
      ppid: parsed.ppid,
      pgrp: parsed.pgrp,
      cmdline,
      ppidIsUserManager: false,
      listeningPorts: [],
    });
  }
  for (const proc of processes) {
    proc.ppidIsUserManager = isSystemdUserManager(proc.ppid, procRoot);
  }
  return processes;
}

/** systemd-reported MainPIDs and ControlGroups of every `duckbrain*` unit. */
export function managedUnitDaemons(): {
  pids: number[];
  cgroups: string[];
} {
  const result = { pids: [] as number[], cgroups: [] as string[] };
  let out: string;
  try {
    const res = spawnSync(
      "systemctl",
      [
        "--user",
        "show",
        "duckbrain*",
        "-p",
        "Id",
        "-p",
        "MainPID",
        "-p",
        "ControlGroup",
        "--no-pager",
      ],
      { encoding: "utf-8", timeout: 5000 },
    );
    if (res.status !== 0 || typeof res.stdout !== "string") return result;
    out = res.stdout;
  } catch {
    return result;
  }
  for (const line of out.split("\n")) {
    const match = /^(MainPID|ControlGroup)=(.*)$/.exec(line.trim());
    if (!match) continue;
    if (match[1] === "MainPID") {
      const pid = Number.parseInt(match[2], 10);
      if (Number.isInteger(pid) && pid > 0) result.pids.push(pid);
    } else if (match[2].startsWith("/")) {
      result.cgroups.push(match[2]);
    }
  }
  return result;
}

/** The process's cgroup path (`/proc/<pid>/cgroup`, last `:`-separated field). */
export function cgroupPathForPid(pid: number, procRoot = "/proc"): string | null {
  const content = readTextFile(path.join(procRoot, String(pid), "cgroup"));
  if (!content) return null;
  const first = content.split("\n").find((line) => line.includes(":"));
  if (!first) return null;
  return first.slice(first.lastIndexOf(":") + 1);
}

/** `pid` and every ancestor of `pid` (so a sweep never kills its own tree). */
export function ownProcessTree(procRoot = "/proc"): number[] {
  const tree = new Set<number>([process.pid]);
  let cursor = process.pid;
  for (let hop = 0; hop < 64; hop++) {
    const stat = readTextFile(path.join(procRoot, String(cursor), "stat"));
    if (!stat) break;
    const parsed = parseProcStat(stat);
    if (!parsed || parsed.ppid <= 0 || tree.has(parsed.ppid)) break;
    tree.add(parsed.ppid);
    cursor = parsed.ppid;
  }
  return [...tree];
}

/** A daemon-shaped process whose spawner is gone. */
export function isOrphaned(proc: ProcessInfo): boolean {
  return proc.ppid === 1 || proc.ppidIsUserManager;
}

/**
 * Decide which daemon-shaped processes to reap. Pure — every input is data,
 * so the full decision table is unit-testable.
 */
export function planDaemonReap(
  processes: ProcessInfo[],
  options: {
    protectedPids?: Iterable<number>;
    protectedPorts?: Iterable<number>;
    ownTree?: Iterable<number>;
    ownPgrp?: number;
    /** cgroup path per candidate pid (read from /proc by the caller). */
    candidateCgroups?: Map<number, string>;
    /** ControlGroup paths reported by systemd for every `duckbrain*` unit. */
    managedCgroups?: Iterable<string>;
  } = {},
): { victims: ProcessInfo[]; spared: SparedProcess[] } {
  const protectedPids = new Set(options.protectedPids ?? []);
  const protectedPorts = new Set(options.protectedPorts ?? []);
  const ownTree = new Set(options.ownTree ?? [process.pid]);
  const managedCgroups = [...(options.managedCgroups ?? [])];
  const victims: ProcessInfo[] = [];
  const spared: SparedProcess[] = [];

  for (const proc of processes) {
    if (!isDaemonShaped(proc.cmdline)) continue;

    const port = portFromCmdline(proc.cmdline);
    const spare = (reason: string) => spared.push({ pid: proc.pid, reason });

    if (proc.pid === process.pid || ownTree.has(proc.pid)) {
      spare("own process tree");
      continue;
    }
    if (protectedPids.has(proc.pid)) {
      spare("protected pid (managed unit MainPID)");
      continue;
    }
    if (options.ownPgrp !== undefined && proc.pgrp === options.ownPgrp) {
      spare("own process group");
      continue;
    }
    if (port !== null && protectedPorts.has(port)) {
      spare(`protected port ${port} (managed unit)`);
      continue;
    }
    const cgroup = options.candidateCgroups?.get(proc.pid);
    if (
      cgroup &&
      managedCgroups.some(
        (managed) => cgroup === managed || cgroup.startsWith(`${managed}/`),
      )
    ) {
      spare(`inside managed unit cgroup ${cgroup}`);
      continue;
    }
    if (!isOrphaned(proc)) {
      spare(`live parent ${proc.ppid} (not orphaned)`);
      continue;
    }
    victims.push(proc);
  }
  return { victims, spared };
}

/** True once a pid is gone — including the zombie state (already dead). */
export function pidIsReaped(pid: number, procRoot = "/proc"): boolean {
  if (!isPidAlive(pid)) return true;
  const stat = readTextFile(path.join(procRoot, String(pid), "stat"));
  if (!stat) return true;
  return procStatShowsZombie(stat);
}

/**
 * A killed process stays visible to a signal-0 probe until its parent reaps
 * it (state `Z`). Treat that as dead: otherwise SIGTERM→"still alive"→SIGKILL
 * would report a kill failure on a process that has already exited.
 */
export function procStatShowsZombie(statContent: string): boolean {
  return parseProcStat(statContent)?.state === "Z";
}

function sleepSync(ms: number): void {
  // Atomics.wait is the only synchronous sleep available without a busy loop.
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * Signal a victim. A group kill is used ONLY when the target is its own
 * process-group leader (the `detached: true` spawn shape): `kill(-pid)` on a
 * non-leader would target an unrelated group, so those get a direct signal.
 */
function signalProcess(proc: ProcessInfo, signal: NodeJS.Signals): boolean {
  if (proc.pid === process.pid) return false;
  if (proc.pgrp === proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return true;
    } catch {
      // fall through to a direct kill
    }
  }
  try {
    process.kill(proc.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Remove `duckbrain-<pid>-*.db` scratch files left by a dead daemon. */
export function reclaimScratchFilesForPid(
  pid: number,
  tmpDir: string = os.tmpdir(),
): string[] {
  const removed: string[] = [];
  const prefix = `${SCRATCH_FILE_PREFIX}${pid}-`;
  let entries: string[];
  try {
    entries = fs.readdirSync(tmpDir);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(SCRATCH_FILE_SUFFIX)) {
      continue;
    }
    const file = path.join(tmpDir, entry);
    try {
      fs.unlinkSync(file);
      removed.push(file);
    } catch {
      // Best-effort: the file may be busy or already gone.
    }
  }
  return removed;
}

/**
 * Scan for orphaned DuckBrain HTTP daemons, kill them, and reclaim their
 * scratch files. Never throws: every failure lands in `report.errors`.
 */
export function reapOrphanDaemons(options: ReapOptions = {}): ReapReport {
  const report: ReapReport = {
    dryRun: options.dryRun === true,
    scanned: 0,
    victims: [],
    killed: [],
    reclaimed: [],
    spared: [],
    observed: [],
    errors: [],
  };
  const tmpDir = options.tmpDir ?? os.tmpdir();

  try {
    const processes = options.processes ?? listProcesses();
    report.scanned = processes.length;

    // A supplied process list is a test seam: it may already carry the
    // listening ports, otherwise daemon-shaped entries get scanned once.
    for (const proc of processes) {
      if (proc.listeningPorts.length > 0 || !isDaemonShaped(proc.cmdline)) {
        continue;
      }
      proc.listeningPorts = listeningPortsForPid(proc.pid);
    }
    report.observed = processes
      .filter((proc) => isDaemonShaped(proc.cmdline))
      .map((proc) => ({
        pid: proc.pid,
        argvPort: portFromCmdline(proc.cmdline),
        listening: proc.listeningPorts,
      }));

    const managed = managedUnitDaemons();
    const protectedPids = new Set<number>(options.protectedPids ?? []);
    for (const pid of managed.pids) protectedPids.add(pid);
    const ownTree = ownProcessTree();
    for (const pid of ownTree) protectedPids.add(pid);

    // Ports of the managed units (read from their own cmdlines) plus the CLI
    // default and the operator-configured port.
    const protectedPorts = new Set<number>(options.protectedPorts ?? []);
    protectedPorts.add(DEFAULT_HTTP_PORT);
    const apiPort = Number.parseInt(process.env.DUCKBRAIN_API_PORT ?? "", 10);
    if (Number.isInteger(apiPort) && apiPort > 0) protectedPorts.add(apiPort);
    for (const proc of processes) {
      if (!managed.pids.includes(proc.pid)) continue;
      const port = portFromCmdline(proc.cmdline);
      if (port !== null) protectedPorts.add(port);
    }

    const ownPgrp = (() => {
      const stat = readTextFile(path.join("/proc", String(process.pid), "stat"));
      return stat ? parseProcStat(stat)?.pgrp : undefined;
    })();

    // Belt and braces on top of the MainPID match: a daemon running INSIDE a
    // managed unit's ControlGroup is that unit's daemon whatever its argv.
    const candidateCgroups = new Map<number, string>();
    if (managed.cgroups.length > 0) {
      for (const proc of processes) {
        if (!isDaemonShaped(proc.cmdline)) continue;
        const cgroup = cgroupPathForPid(proc.pid);
        if (cgroup) candidateCgroups.set(proc.pid, cgroup);
      }
    }

    const { victims, spared } = planDaemonReap(processes, {
      protectedPids,
      protectedPorts,
      ownTree,
      ownPgrp,
      candidateCgroups,
      managedCgroups: managed.cgroups,
    });
    report.victims = victims.map((proc) => proc.pid);
    report.spared = spared;

    if (options.dryRun === true) return report;

    const sigtermTimeoutMs = options.sigtermTimeoutMs ?? 3000;
    const sigkillTimeoutMs = options.sigkillTimeoutMs ?? 2000;

    for (const proc of victims) {
      try {
        if (pidIsReaped(proc.pid)) {
          report.killed.push(proc.pid);
        } else {
          signalProcess(proc, "SIGTERM");
          const deadline = Date.now() + sigtermTimeoutMs;
          while (!pidIsReaped(proc.pid) && Date.now() < deadline) {
            sleepSync(50);
          }
          if (!pidIsReaped(proc.pid)) {
            // The incident's signature: a starved event loop never handles
            // SIGTERM, so SIGKILL is the real kill.
            signalProcess(proc, "SIGKILL");
            const killDeadline = Date.now() + sigkillTimeoutMs;
            while (!pidIsReaped(proc.pid) && Date.now() < killDeadline) {
              sleepSync(50);
            }
          }
          if (pidIsReaped(proc.pid)) {
            report.killed.push(proc.pid);
          } else {
            report.errors.push(`pid ${proc.pid} survived SIGTERM+SIGKILL`);
          }
        }
        report.reclaimed.push(...reclaimScratchFilesForPid(proc.pid, tmpDir));
      } catch (err) {
        report.errors.push(
          `pid ${proc.pid}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err));
  }
  return report;
}

/** One-line summary for a suite's startup/teardown log. */
export function formatReapReport(report: ReapReport): string {
  const action = report.dryRun ? "would reap" : "reaped";
  return (
    `[orphan-reaper] scanned ${report.scanned} process(es): ${action} ` +
    `${report.victims.length} orphaned daemon(s) ` +
    `[${report.victims.join(", ")}], killed [${report.killed.join(", ")}], ` +
    `reclaimed ${report.reclaimed.length} scratch file(s)` +
    (report.errors.length ? `, errors: ${report.errors.join("; ")}` : "")
  );
}
