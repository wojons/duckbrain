/**
 * QA-DUCKBRAIN-022: shared JSONL corruption policy.
 *
 * A crash (or a full disk) can leave a torn line at the tail of a chunk —
 * a record truncated mid-JSON. The DuckDB serving read path tolerates that
 * with `ignore_errors=true` (intentional: one bad line must not take the
 * whole namespace down), but until now nothing counted the skipped rows, so
 * `recall`/`search` returned a short page and `status` still said `OK`.
 *
 * This module is the ONE place that decides what counts as corruption and
 * ONE place that says so out loud, so the serving read path (`src/duckdb/
 * queries.ts`), the JSONL reader (`readFromJsonl`) and the CLI all report
 * the same numbers for the same namespace (AC4).
 *
 * Dependency-free: fs + path + JSON.parse, nothing else.
 */

import fs from "fs";
import path from "path";

/** One chunk file that contains at least one unparseable line. */
export interface MalformedFile {
  /** Absolute path to the offending chunk. */
  path: string;
  /** 1-based line number of the FIRST malformed line in that file. */
  line: number;
  /** How many lines in that file failed to parse. */
  skipped: number;
}

/** Aggregate corruption report for a set of chunk files. */
export interface CorruptionReport {
  /** Total number of malformed records across all files. */
  skipped: number;
  /** Per-file detail (empty when the namespace is clean). */
  files: MalformedFile[];
}

interface ScanCacheEntry {
  size: number;
  mtimeMs: number;
  files: MalformedFile[];
}

/** Cache keyed by absolute path; invalidated by (size, mtimeMs). */
const scanCache = new Map<string, ScanCacheEntry>();
const MAX_CACHE_ENTRIES = 8192;

/** Files we already warned about, keyed by path+line+count. */
const warned = new Set<string>();

/**
 * Scan chunk files for malformed (unparseable) lines.
 *
 * Blank lines are not records and are never counted. Results are cached per
 * (path, size, mtimeMs) so a hot read does not re-parse unchanged chunks.
 */
export function scanMalformedLines(files: string[]): CorruptionReport {
  const found: MalformedFile[] = [];
  for (const file of files) {
    found.push(...scanFile(file));
  }
  return {
    skipped: found.reduce((total, entry) => total + entry.skipped, 0),
    files: found,
  };
}

function scanFile(filePath: string): MalformedFile[] {
  const abs = path.resolve(filePath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    // A missing chunk is not corruption — it is simply absent.
    return [];
  }

  const cached = scanCache.get(abs);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.files;
  }

  let content: string;
  try {
    content = fs.readFileSync(abs, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split("\n");
  let skipped = 0;
  let firstLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    try {
      JSON.parse(line);
    } catch {
      skipped += 1;
      if (firstLine === 0) firstLine = i + 1;
    }
  }

  const files: MalformedFile[] =
    skipped > 0 ? [{ path: abs, line: firstLine, skipped }] : [];

  if (scanCache.size >= MAX_CACHE_ENTRIES) scanCache.clear();
  scanCache.set(abs, { size: stat.size, mtimeMs: stat.mtimeMs, files });
  return files;
}

/**
 * Emit ONE stderr line per corrupt chunk (deduped per process).
 *
 * Shared by the serving read path and `readFromJsonl` so both readers say
 * exactly the same thing about the same bytes.
 *
 * @returns true when something was printed.
 */
export function warnMalformedFile(
  file: MalformedFile,
  sink: (message: string) => void = (message) => console.error(message),
): boolean {
  const key = `${file.path}:${file.line}:${file.skipped}`;
  if (warned.has(key)) return false;
  warned.add(key);
  const noun = file.skipped === 1 ? "record" : "records";
  sink(
    `WARNING: ${file.skipped} malformed ${noun} skipped in ${file.path}:${file.line} — run \`duckbrain squash --segments\` to repair`,
  );
  return true;
}

/** Emit the shared warning for every corrupt chunk in a report. */
export function warnOnCorruption(
  report: CorruptionReport,
  sink?: (message: string) => void,
): boolean {
  let warnedAny = false;
  for (const file of report.files) {
    if (warnMalformedFile(file, sink)) warnedAny = true;
  }
  return warnedAny;
}

/** Collect every `*.jsonl` chunk under a namespace directory (sorted). */
export function collectNamespaceChunkFiles(namespacePath: string): string[] {
  const out: string[] = [];

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  };

  walk(namespacePath);
  out.sort();
  return out;
}

/**
 * Scan a whole namespace and warn about any corruption.
 * Convenience entry point for the CLI (`recall`, `search`, `status`).
 */
export function auditNamespace(
  namespacePath: string,
  warn = true,
): CorruptionReport {
  const report = scanMalformedLines(collectNamespaceChunkFiles(namespacePath));
  if (warn) warnOnCorruption(report);
  return report;
}

/** Human-readable one-liner for a degraded status/health surface. */
export function describeCorruption(report: CorruptionReport): string {
  if (report.skipped === 0) return "no malformed records";
  const first = report.files[0];
  const where = first ? `${first.path}:${first.line}` : "unknown file";
  const noun = report.skipped === 1 ? "record" : "records";
  return `${report.skipped} malformed ${noun} skipped in ${where}`;
}

/** Test/CLI helper: drop cached scan results (used after a repair). */
export function resetCorruptionCache(): void {
  scanCache.clear();
  warned.clear();
}
