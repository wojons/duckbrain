/**
 * Capture evidence when systemd reports that the HTTP daemon did not exit cleanly.
 *
 * This runs from ExecStopPost, so the clean-stop path must remain a genuinely
 * cheap no-op. Every best-effort probe is recorded rather than allowed to abort
 * the evidence bundle.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

export const DEFAULT_UNIT = "duckbrain-http.service";
export const DEFAULT_JOURNAL_LINES = 200;
export const DEFAULT_COMMAND_TIMEOUT_MS = 1_000;

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface CrashAttributionDeps {
  runCommand(command: string, args: string[], timeoutMs: number): CommandResult;
}

export interface CrashAttributionOptions {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  evidenceDir?: string;
  journalLines?: number;
  commandTimeoutMs?: number;
  deps?: CrashAttributionDeps;
}

export type CrashClassification = "clean" | "signal" | "non-zero";

export interface CrashAttributionResult {
  exitCode: number;
  captured: boolean;
  classification: CrashClassification;
  bundlePath?: string;
  detail: string;
}

function defaultEvidenceDir(env: NodeJS.ProcessEnv): string {
  const stateHome = env.XDG_STATE_HOME?.trim();
  const home = env.HOME?.trim() || os.homedir();
  return path.join(
    stateHome || path.join(home, ".local", "state"),
    "duckbrain",
    "crash-evidence",
  );
}

function defaultDeps(): CrashAttributionDeps {
  return {
    runCommand(command, args, timeoutMs) {
      try {
        return {
          ok: true,
          stdout: execFileSync(command, args, {
            encoding: "utf8",
            timeout: timeoutMs,
            stdio: ["ignore", "pipe", "pipe"],
          }),
          stderr: "",
        };
      } catch (error) {
        const failure = error as {
          message?: string;
          stdout?: string | Buffer;
          stderr?: string | Buffer;
        };
        return {
          ok: false,
          stdout: failure.stdout?.toString() ?? "",
          stderr: failure.stderr?.toString() ?? "",
          error: failure.message ?? String(error),
        };
      }
    },
  };
}

function commandRecord(
  deps: CrashAttributionDeps,
  command: string,
  args: string[],
  timeoutMs: number,
): Record<string, unknown> {
  const result = deps.runCommand(command, args, timeoutMs);
  return {
    command: [command, ...args],
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error ? { error: result.error } : {}),
  };
}

function readSnapshot(filePath: string): Record<string, unknown> {
  try {
    return { path: filePath, ok: true, content: fs.readFileSync(filePath, "utf8") };
  } catch (error) {
    return {
      path: filePath,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function cgroupSnapshot(cgroupContent: string, fileName: string): Record<string, unknown> {
  const unified = cgroupContent
    .split(/\r?\n/)
    .find((line) => line.startsWith("0::"))
    ?.slice(3)
    .trim();
  const normalized = unified?.replace(/^\/+/, "") ?? "";
  const candidates = [
    ...(normalized ? [path.join("/sys/fs/cgroup", normalized, fileName)] : []),
    path.join("/sys/fs/cgroup", fileName),
  ];
  for (const candidate of candidates) {
    const snapshot = readSnapshot(candidate);
    if (snapshot.ok) return snapshot;
  }
  return readSnapshot(candidates[0]);
}

function safeUnitName(unit: string): string {
  return unit.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function timestampFor(date: Date): string {
  return date.toISOString().replace(/:/g, "").replace(/\.\d{3}Z$/, "Z");
}

function uniqueBundlePath(baseDir: string, date: Date, unit: string): string {
  const stem = `${timestampFor(date)}-${safeUnitName(unit)}`;
  let candidate = path.join(baseDir, stem);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(baseDir, `${stem}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function reportFile(name: string): boolean {
  return name.includes(".report.") || name.startsWith("report.");
}

function moveReports(evidenceDir: string, bundlePath: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(evidenceDir);
  } catch (error) {
    return [
      {
        ok: false,
        error: `cannot list report directory: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }

  for (const name of names.filter(reportFile)) {
    const source = path.join(evidenceDir, name);
    const destination = path.join(bundlePath, `v8-${name}`);
    try {
      fs.renameSync(source, destination);
      results.push({ ok: true, source, destination });
    } catch (error) {
      results.push({
        ok: false,
        source,
        destination,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

function exitNumber(status: string | undefined): number | null {
  if (!status || !/^\d+$/.test(status)) return null;
  return Number.parseInt(status, 10);
}

function classify(env: NodeJS.ProcessEnv): {
  classification: CrashClassification;
  serviceResult: string;
  exitCode: string;
  exitStatus: string;
} {
  const serviceResult = env.SERVICE_RESULT ?? "unknown";
  const exitCode = env.EXIT_CODE ?? "unknown";
  const exitStatus = env.EXIT_STATUS ?? "unknown";
  const status = exitNumber(env.EXIT_STATUS);
  if (
    serviceResult === "success" &&
    exitCode === "exited" &&
    status === 0
  ) {
    return { classification: "clean", serviceResult, exitCode, exitStatus };
  }
  if (
    serviceResult === "signal" ||
    exitCode === "dumped" ||
    status === 6 ||
    status === 11
  ) {
    return { classification: "signal", serviceResult, exitCode, exitStatus };
  }
  return { classification: "non-zero", serviceResult, exitCode, exitStatus };
}

/**
 * Capture one systemd exit. The returned exit code is 0 after a best-effort
 * capture so ExecStopPost cannot turn a daemon crash into a second failure.
 */
export function runCrashAttribution(
  options: CrashAttributionOptions = {},
): CrashAttributionResult {
  const env = options.env ?? process.env;
  const result = classify(env);
  if (result.classification === "clean") {
    return {
      exitCode: 0,
      captured: false,
      classification: "clean",
      detail: "clean exit; no crash evidence written",
    };
  }

  const unit = env.INVOCATION_UNIT ?? env.UNIT ?? DEFAULT_UNIT;
  const evidenceDir = options.evidenceDir ?? defaultEvidenceDir(env);
  const now = options.now ?? new Date();
  const timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const journalLines = options.journalLines ?? DEFAULT_JOURNAL_LINES;
  const deps = options.deps ?? defaultDeps();
  const bundlePath = uniqueBundlePath(evidenceDir, now, unit);

  try {
    fs.mkdirSync(bundlePath, { recursive: true });
  } catch (error) {
    return {
      exitCode: 1,
      captured: false,
      classification: result.classification,
      detail: `cannot create evidence bundle: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const memory = commandRecord(
    deps,
    "systemctl",
    [
      "--user",
      "show",
      unit,
      "-p",
      "MemoryPeak",
      "-p",
      "MemorySwapPeak",
      "-p",
      "MemoryHigh",
      "-p",
      "MemoryMax",
    ],
    timeoutMs,
  );
  const journal = commandRecord(
    deps,
    "journalctl",
    ["--user", "-u", unit, "-n", String(journalLines), "--no-pager"],
    timeoutMs,
  );
  const cgroupPath = readSnapshot("/proc/self/cgroup");
  const evidence = {
    schema: 1,
    capturedAt: now.toISOString(),
    unit,
    classification: result.classification,
    exit: {
      serviceResult: result.serviceResult,
      exitCode: result.exitCode,
      exitStatus: result.exitStatus,
    },
    probes: {
      systemdMemory: memory,
      journal,
      procMeminfo: readSnapshot("/proc/meminfo"),
      cgroup: cgroupPath,
      cgroupMemoryPeak: readSnapshot("/sys/fs/cgroup/memory.peak"),
      cgroupMemorySwapPeak: cgroupSnapshot(String((cgroupPath.content as string | undefined) ?? ""), "memory.swap.peak"),
      cgroupV1MemoryPeak: cgroupSnapshot(String((cgroupPath.content as string | undefined) ?? ""), "memory.max_usage_in_bytes"),
      cgroupV1MemorySwapPeak: cgroupSnapshot(String((cgroupPath.content as string | undefined) ?? ""), "memory.memsw.max_usage_in_bytes"),
    },
    commandTimeoutMs: timeoutMs,
  };

  try {
    const reports = moveReports(evidenceDir, bundlePath);
    (evidence as { v8Reports?: Record<string, unknown>[] }).v8Reports = reports;
    fs.writeFileSync(path.join(bundlePath, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    fs.writeFileSync(path.join(bundlePath, "journal.txt"), `${journal.stdout}${journal.stderr}`);
    fs.writeFileSync(path.join(bundlePath, "proc-meminfo.txt"), String((evidence.probes.procMeminfo as { content?: string }).content ?? ""));
    fs.writeFileSync(path.join(bundlePath, "cgroup-memory.peak.txt"), String((evidence.probes.cgroupMemoryPeak as { content?: string }).content ?? ""));
    fs.writeFileSync(path.join(bundlePath, "cgroup-memory.swap.peak.txt"), String((evidence.probes.cgroupMemorySwapPeak as { content?: string }).content ?? ""));
    fs.writeFileSync(path.join(bundlePath, "v8-reports.json"), `${JSON.stringify(reports, null, 2)}\n`);
  } catch (error) {
    return {
      exitCode: 1,
      captured: false,
      classification: result.classification,
      bundlePath,
      detail: `evidence bundle write failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    exitCode: 0,
    captured: true,
    classification: result.classification,
    bundlePath,
    detail: `captured ${result.classification} exit for ${unit}`,
  };
}

export async function runCrashAttributionCli(
  _args: string[] = [],
): Promise<number> {
  const result = runCrashAttribution();
  if (result.detail.startsWith("cannot ") || result.detail.startsWith("evidence bundle write failed")) {
    console.error(`crash-attribution: ${result.detail}`);
  }
  return result.exitCode;
}

export { defaultEvidenceDir };
