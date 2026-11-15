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

function systemdProperties(stdout: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    properties.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return properties;
}

function parsePositivePeak(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function cgroupCandidates(controlGroup: string, fileNames: string[]): string[] {
  const normalized = controlGroup.trim().replace(/^\/+/, "");
  if (!normalized) return [];
  const root = "/sys/fs/cgroup";
  return [
    ...fileNames.map((fileName) => path.join(root, normalized, fileName)),
    ...fileNames.map((fileName) => path.join(root, "memory", normalized, fileName)),
  ];
}

function unitCgroupPeak(
  controlGroup: string,
  fileNames: string[],
): { value?: number; source: string; error?: string; content?: string } {
  const candidates = cgroupCandidates(controlGroup, fileNames);
  if (candidates.length === 0) {
    return {
      source: "cgroupfs:<unresolved>",
      error: "systemd ControlGroup was empty; unit cgroup path cannot be resolved",
    };
  }
  const errors: string[] = [];
  for (const candidate of candidates) {
    const snapshot = readSnapshot(candidate);
    if (!snapshot.ok) {
      errors.push(`${candidate}: ${String(snapshot.error ?? "read failed")}`);
      continue;
    }
    const value = parsePositivePeak(String(snapshot.content ?? ""));
    if (value !== undefined) {
      return { value, source: `cgroupfs:${candidate}`, content: String(snapshot.content) };
    }
    errors.push(`${candidate}: missing or zero peak`);
  }
  return {
    source: `cgroupfs:${candidates[0]}`,
    error: errors.join("; "),
  };
}

function parseSystemdTimestamp(value: string | undefined): Date | undefined {
  if (!value || value === "0") return undefined;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp;
}

function peakEvidence(
  properties: Map<string, string>,
  propertyName: "MemoryPeak" | "MemorySwapPeak",
  controlGroup: string,
  fileNames: string[],
): Record<string, unknown> {
  const systemdValue = parsePositivePeak(properties.get(propertyName));
  if (systemdValue !== undefined) {
    return {
      value: systemdValue,
      source: "systemd-memory-peak",
      rawControlGroup: controlGroup,
    };
  }
  const fallback = unitCgroupPeak(controlGroup, fileNames);
  return {
    value: fallback.value ?? null,
    source: fallback.source,
    rawControlGroup: controlGroup,
    ...(fallback.error ? { error: fallback.error } : {}),
    ...(fallback.content !== undefined ? { content: fallback.content } : {}),
  };
}

const REPORT_MTIME_SLACK_MS = 5 * 60 * 1_000;

function copyReports(
  evidenceDir: string,
  bundlePath: string,
  minimumMtimeMs: number,
): Record<string, unknown>[] {
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

  for (const name of names) {
    const source = path.join(evidenceDir, name);
    // The bundle directory itself lives inside the report directory; it is our
    // own output rather than an invocation report, so it is not a candidate.
    if (path.resolve(source) === path.resolve(bundlePath)) continue;
    try {
      const stat = fs.lstatSync(source);
      if (!stat.isFile()) {
        results.push({ ok: false, name, source, action: "skipped", reason: "not a regular file" });
        continue;
      }
      if (stat.mtimeMs < minimumMtimeMs) {
        results.push({
          ok: false,
          name,
          source,
          action: "skipped",
          reason: `mtime ${new Date(stat.mtimeMs).toISOString()} is before invocation window`,
        });
        continue;
      }
      const destination = path.join(bundlePath, name);
      fs.copyFileSync(source, destination);
      results.push({ ok: true, name, source, destination, action: "copied" });
    } catch (error) {
      results.push({
        ok: false,
        name,
        source,
        action: "skipped",
        reason: error instanceof Error ? error.message : String(error),
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

  const unit = env.INVOCATION_UNIT || env.SYSTEMD_UNIT || env.DUCKBRAIN_CRASH_UNIT || DEFAULT_UNIT;
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
      "--property",
      "MemoryPeak,MemorySwapPeak,ControlGroup,ActiveEnterTimestamp,InvocationID,MemoryHigh,MemoryMax",
    ],
    timeoutMs,
  );
  const journal = commandRecord(
    deps,
    "journalctl",
    ["--user", "-u", unit, "-n", String(journalLines), "--no-pager"],
    timeoutMs,
  );
  const systemd = systemdProperties(String(memory.stdout ?? ""));
  const controlGroup = systemd.get("ControlGroup") ?? "";
  const activeEnter = parseSystemdTimestamp(systemd.get("ActiveEnterTimestamp"));
  const invocationWindow = (activeEnter?.getTime() ?? now.getTime()) - REPORT_MTIME_SLACK_MS;
  const memoryPeak = peakEvidence(systemd, "MemoryPeak", controlGroup, ["memory.peak", "memory.max_usage_in_bytes"]);
  const memorySwapPeak = peakEvidence(
    systemd,
    "MemorySwapPeak",
    controlGroup,
    ["memory.swap.peak", "memory.memsw.max_usage_in_bytes"],
  );
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
      cgroupMemoryPeak: memoryPeak,
      cgroupMemorySwapPeak: memorySwapPeak,
    },
    systemd: {
      controlGroup,
      activeEnterTimestamp: systemd.get("ActiveEnterTimestamp") ?? "",
      invocationId: systemd.get("InvocationID") ?? "",
    },
    commandTimeoutMs: timeoutMs,
  };

  try {
    const reports = copyReports(evidenceDir, bundlePath, invocationWindow);
    (evidence as { v8Reports?: Record<string, unknown>[] }).v8Reports = reports;
    fs.writeFileSync(path.join(bundlePath, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    fs.writeFileSync(path.join(bundlePath, "journal.txt"), `${journal.stdout}${journal.stderr}`);
    fs.writeFileSync(path.join(bundlePath, "proc-meminfo.txt"), String((evidence.probes.procMeminfo as { content?: string }).content ?? ""));
    fs.writeFileSync(path.join(bundlePath, "cgroup-memory.peak.txt"), `${memoryPeak.value ?? ""}\n`);
    fs.writeFileSync(path.join(bundlePath, "cgroup-memory.swap.peak.txt"), `${memorySwapPeak.value ?? ""}\n`);
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
