/**
 * DuckBrain JSONL Storage
 *
 * Partitioned storage with three-level hierarchy:
 * namespace/domain/partition/chunk.jsonl
 *
 * Supports time-based (YYYY-MM) and key-based partitioning.
 * Chunked files for efficient reads (max 1000 lines or 1MB per chunk).
 */

import fs from "fs";
import path from "path";
import { MemorySchema, type MemoryType } from "../schema/memory";
import { safeJsonStringify } from "../utils/serialize";
import { getConfig, resolveDurabilityMode } from "../config";
import { DurabilityError } from "./durability-errors";

/**
 * Maximum lines per chunk file before creating new one
 */
const MAX_LINES_PER_CHUNK = 1000;

/**
 * Maximum size per chunk file in bytes (1MB)
 */
const MAX_BYTES_PER_CHUNK = 1024 * 1024;

/**
 * Get partition directory path based on domain and partition value
 * (namespace path is resolved separately)
 *
 * @param namespace - Namespace folder (unused, kept for API compatibility)
 * @param domain - Memory domain (person, event, concept, etc.)
 * @param partitionType - 'time' or 'key' based partitioning
 * @param partitionValue - Time period (YYYY-MM) or key prefix
 * @returns Relative partition path: domain/partitionValue/
 *
 * @example
 * getPartitionPath('default', 'person', 'time', '2026-03')
 * // Returns: 'person/2026-03/'
 *
 * @example
 * getPartitionPath('default', 'event', 'key', 'projects/mcp')
 * // Returns: 'event/projects/mcp/'
 */
export function getPartitionPath(
  _namespace: string,
  domain: string,
  _partitionType: "time" | "key",
  partitionValue: string,
): string {
  // Sanitize inputs to prevent path traversal
  const safeDomain = domain.replace(/[^a-zA-Z0-9_]/g, "_");
  // Allow slashes in partition value for key-based partitioning
  const safePartition = partitionValue.replace(/[^a-zA-Z0-9._/-]/g, "_");

  return path.join(safeDomain, safePartition) + path.sep;
}

/**
 * Create partition directory structure
 *
 * @param partitionPath - Path from getPartitionPath()
 * Creates directory recursively with .gitkeep file
 */
export function createPartition(partitionPath: string): void {
  // Ensure path ends with separator
  const normalizedPath = partitionPath.endsWith(path.sep)
    ? partitionPath
    : partitionPath + path.sep;

  // Create directory recursively
  fs.mkdirSync(normalizedPath, { recursive: true });

  // Initialize .gitkeep to track empty directories in git
  const gitkeepPath = path.join(normalizedPath, ".gitkeep");
  if (!fs.existsSync(gitkeepPath)) {
    fs.writeFileSync(gitkeepPath, "");
  }
}

/**
 * Get next available chunk filename in partition
 *
 * @param partitionPath - Partition directory path
 * @returns Next chunk filename (e.g., '0001.jsonl')
 */
export function getNextChunkName(partitionPath: string): string {
  // Only numeric chunk files (0001.jsonl, 0002.jsonl, ...) participate in
  // rotation. Non-numeric names — current.jsonl, chunk_<ts>.jsonl, or the
  // legacy 0NaN.jsonl — are ignored. Without this filter, parseInt("current")
  // yields NaN and every rotated write lands in "0NaN.jsonl"; that file then
  // absorbs ALL writes forever because the capacity check in appendToJsonl
  // only inspects the original file path, so rotation never re-fires.
  const existingChunks = fs
    .readdirSync(partitionPath)
    .filter((f) => /^\d+\.jsonl$/.test(f))
    .sort();

  if (existingChunks.length === 0) {
    return "0001.jsonl";
  }

  // Get last chunk number and increment
  const lastChunk = existingChunks[existingChunks.length - 1];
  const lastNum = parseInt(lastChunk.replace(".jsonl", ""), 10);
  const nextNum = lastNum + 1;

  // Zero-pad to 4 digits
  return `${nextNum.toString().padStart(4, "0")}.jsonl`;
}

/**
 * Count lines in a file
 *
 * @param filePath - Path to file
 * @returns Number of newline characters
 */
function countLines(filePath: string): number {
  if (!fs.existsSync(filePath)) {
    return 0;
  }
  const content = fs.readFileSync(filePath, "utf-8");
  return content.split("\n").filter((l) => l.trim() !== "").length;
}

/**
 * Serialize a memory record to a single JSONL line (no trailing newline).
 *
 * DB-GAP-035: never hand out a line that would corrupt the store. The schema
 * check happens before this call; a value can still fail to serialize (e.g. a
 * circular reference — zod accepts it, JSON.stringify throws). Such a line
 * would break every downstream reader (read_json, readFromJsonl), so verify
 * the serialized line round-trips and return null on failure. Callers decide
 * whether to skip the append (buffered path) or fail loudly.
 *
 * Shared with the SUPA-1 durability appenders so fsync/direct mode writes the
 * exact same bytes the buffered path would.
 *
 * @param record - Record to serialize
 * @returns JSON line, or null when the record is unserializable
 */
export function serializeJsonlLine(record: unknown): string | null {
  try {
    const line = safeJsonStringify(record);
    JSON.parse(line);
    return line;
  } catch {
    return null;
  }
}

/**
 * Resolve the file the next append lands in, applying chunk rotation.
 *
 * Rotation fires when the current file is at MAX_BYTES_PER_CHUNK or
 * MAX_LINES_PER_CHUNK; the rotated target is `getNextChunkName(dirPath)` —
 * a NEW file whose directory entry itself must be fsynced in fsync/direct
 * mode (SUPA-1) or the name can be lost on crash even though the data was
 * fsynced.
 *
 * @param filePath - Candidate file path (e.g. .../current.jsonl)
 * @param line - The serialized line about to be appended
 * @returns Path the append should target
 */
export function resolveJsonlTargetPath(filePath: string, line: string): string {
  if (!fs.existsSync(filePath)) {
    return filePath;
  }

  const stats = fs.statSync(filePath);
  const lines = countLines(filePath);

  if (
    stats.size + line.length > MAX_BYTES_PER_CHUNK ||
    lines >= MAX_LINES_PER_CHUNK
  ) {
    const dirPath = path.dirname(filePath) + path.sep;
    return path.join(dirPath, getNextChunkName(dirPath));
  }

  return filePath;
}

/**
 * Create the directory chain for a file path, reporting exactly which
 * directories were CREATED by this call (shallowest first, deepest last).
 *
 * SUPA-1: in fsync/direct mode the parent of the deepest newly-created
 * directory must be fsynced in addition to the file's own parent — a brand new
 * directory whose entry never reached stable storage can vanish on crash.
 *
 * @param dir - Directory that must exist
 * @returns Paths created by this call (empty when it already existed)
 */
export function ensureJsonlDir(dir: string): string[] {
  if (fs.existsSync(dir)) {
    return [];
  }

  // Walk up to the deepest existing ancestor so we know which levels are new.
  const created: string[] = [];
  let current = path.resolve(dir);
  const chain: string[] = [];
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(current)) {
      break;
    }
    chain.push(current);
    current = path.dirname(current);
  }

  fs.mkdirSync(dir, { recursive: true });

  // chain is deepest-first; return shallowest-first for deterministic fsync
  // order (parents before children).
  for (let i = chain.length - 1; i >= 0; i--) {
    created.push(chain[i]);
  }
  return created;
}

/**
 * Derive the namespace name a JSONL file belongs to, from its path.
 *
 * SUPA-1 bypass guard support: `<namespacesPath>/<ns>/<domain>/<partition>/
 * <chunk>.jsonl`. Returns undefined when the file is not inside the configured
 * namespaces root (e.g. ad-hoc temp paths) — callers then cannot make a
 * statement about the namespace's mode and must not guess.
 *
 * @param filePath - Absolute or relative JSONL path
 */
export function namespaceForJsonlPath(filePath: string): string | undefined {
  let nsRoot: string;
  try {
    nsRoot = path.resolve(getConfig(".").namespacesPath || "./namespaces");
  } catch {
    return undefined;
  }
  const resolved = path.resolve(filePath);
  const rel = path.relative(nsRoot, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  const segments = rel.split(path.sep).filter((s) => s !== "");
  if (segments.length < 2) {
    return undefined;
  }
  return segments[0];
}

/**
 * SUPA-1 bypass guard: the buffered append path must never be used for an
 * fsync/direct namespace.
 *
 * `docs/specs/SUPA-1-write-durability.md` assigns all file writes for
 * fsync/direct namespaces to the durability appenders (and, once it lands, the
 * SUPA-2 serializer). A direct `appendToJsonl` call against such a namespace
 * would ack an unbarriered write while the operator believes RPO = 0 — so it
 * is a loud contract violation, not a silent downgrade.
 *
 * No-op when the namespace cannot be derived from the path or when config
 * loading itself fails (that failure surfaces on its own).
 */
function assertBufferedAppendAllowed(filePath: string): void {
  const ns = namespaceForJsonlPath(filePath);
  if (ns === undefined) {
    return;
  }
  let mode: string;
  try {
    mode = resolveDurabilityMode(ns);
  } catch {
    return;
  }
  if (mode !== "buffered") {
    throw new DurabilityError(
      "DURABILITY_BYPASS",
      `appendToJsonl (buffered path) refused for namespace '${ns}' configured ` +
        `with durability mode '${mode}' — durable namespaces must be written ` +
        "through appendJsonlDurable/appendJsonlDirect (SUPA-1) or the SUPA-2 " +
        `serializer. File: ${filePath}`,
    );
  }
}

/**
 * Append memory record to JSONL file
 *
 * Synchronous write for durability (git commits are async).
 * Validates record against MemorySchema before writing.
 *
 * Durability contract (SUPA-1): this is the BUFFERED path — page-cache write,
 * no fdatasync/fsync before the caller acknowledges. Process-kill safe, NOT
 * OS-crash/power-loss safe. Namespaces configured `fsync`/`direct` must use
 * `appendJsonlDurable`/`appendJsonlDirect` (`src/storage/durability.ts`).
 *
 * @param filePath - Full path to JSONL file
 * @param record - Memory record to append
 * @returns Number of lines written (1 on success)
 * @throws Error if validation fails or write errors
 * @throws DurabilityError DURABILITY_BYPASS for an fsync/direct namespace
 */
export function appendToJsonl(filePath: string, record: MemoryType): number {
  // Validate record before writing
  MemorySchema.parse(record);

  // SUPA-1: refuse the buffered path for durable namespaces (contract guard).
  assertBufferedAppendAllowed(filePath);

  // Ensure directory exists
  const dir = path.dirname(filePath);
  ensureJsonlDir(dir);

  // Serialize to JSON (single line, no trailing newline yet).
  // DB-GAP-035: refuse to append an unserializable record — log and SKIP the
  // append (the record is dropped rather than poisoning the store).
  const line = serializeJsonlLine(record);
  if (line === null) {
    console.error(
      `[jsonl] appendToJsonl: refusing to append unserializable record to ${filePath}`,
    );
    return 0;
  }

  // Check if we need a new chunk
  const targetPath = resolveJsonlTargetPath(filePath, line);

  // Append with newline
  fs.appendFileSync(targetPath, line + "\n", "utf-8");

  return 1;
}

/**
 * Read memory records from JSONL file
 *
 * @param filePath - Full path to JSONL file
 * @param limit - Maximum records to return (optional)
 * @returns Array of validated MemoryType records
 * @throws Error if file doesn't exist or validation fails
 */
export function readFromJsonl(filePath: string, limit?: number): MemoryType[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim() !== "");
  const records: MemoryType[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (limit && records.length >= limit) {
      break;
    }

    try {
      const parsed = JSON.parse(lines[i]);
      const validated = MemorySchema.parse(parsed);
      records.push(validated);
    } catch (error) {
      throw new Error(
        `Invalid JSON or schema at line ${i + 1}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  return records;
}

/**
 * Read all chunks from a partition
 *
 * @param partitionPath - Partition directory path
 * @param limit - Maximum total records across all chunks
 * @returns Array of validated MemoryType records
 */
export function readPartition(
  partitionPath: string,
  limit?: number,
): MemoryType[] {
  if (!fs.existsSync(partitionPath)) {
    return [];
  }

  const chunks = fs
    .readdirSync(partitionPath)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

  const allRecords: MemoryType[] = [];

  for (const chunk of chunks) {
    const chunkPath = path.join(partitionPath, chunk);
    const records = readFromJsonl(chunkPath);
    allRecords.push(...records);

    if (limit && allRecords.length >= limit) {
      return allRecords.slice(0, limit);
    }
  }

  return allRecords;
}

/**
 * Create a complete partition and return the path
 *
 * Convenience function combining getPartitionPath and createPartition
 *
 * @param namespace - Namespace folder
 * @param domain - Memory domain
 * @param partitionType - 'time' or 'key'
 * @param partitionValue - Partition identifier
 * @returns Created partition path
 */
export function createPartitionAtPath(
  namespace: string,
  domain: string,
  partitionType: "time" | "key",
  partitionValue: string,
): string {
  const partitionPath = getPartitionPath(
    namespace,
    domain,
    partitionType,
    partitionValue,
  );
  createPartition(partitionPath);
  return partitionPath;
}
