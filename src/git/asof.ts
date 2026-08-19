/**
 * Memory-as-of git time travel (RETR-004).
 *
 * Read-only recall of a namespace's memory state at a past git ref:
 *   - `resolveAsOfRef` maps an ISO-8601 date to the nearest commit at-or-before
 *     that date (git rev-list --before), or accepts a commit hash / branch /
 *     tag directly. Invalid input throws a clear Error — never crashes.
 *   - `queryMemoriesAtRef` reads the namespace state at a resolved ref:
 *     the namespace manifest and every partition chunk are pulled with
 *     `git show <ref>:<path>` (one execFileSync per file — no checkout, no
 *     worktree mutation), merged across partitions via the manifest, and
 *     filtered/deduped/sorted with the SAME semantics as the DuckDB list path
 *     in src/duckdb/queries.ts.
 *
 * Works on any clone with full history — including S3-synced bundles, which
 * carry the complete namespace repo history (no special casing needed).
 *
 * Per-namespace repos: DuckBrain keeps one git repo per namespace
 * (src/git/autocommit.ts runs `git init` inside the namespace directory), so
 * every git command here runs with cwd = namespacePath and ref-relative paths
 * (manifest.json, <domain>/<partition>/<chunk>.jsonl).
 *
 * Semantics mirrored from queryMemories (src/duckdb/queries.ts):
 *   - malformed JSONL lines are skipped (read_json ignore_errors=true)
 *   - filters apply BEFORE dedup (inner WHERE clause)
 *   - dedup keeps the LATEST record per id (ROW_NUMBER ... ORDER BY timestamp
 *     DESC); the DuckDB window orders by the RAW varchar, this mirror orders
 *     by parsed instant — the corpus is consistent enough that the two agree,
 *     and parsed ordering matches the RETR-005 final ORDER BY intent
 *   - a memory whose latest record is a tombstone is excluded
 *   - final order: timestamp DESC (unparseable last), id ASC; then LIMIT
 *   - after/before bounds match a row when its OWN timestamp satisfies all
 *     bounds OR its key carries a chat-archive date facet (/chats/<view>/
 *     <YYYY-MM-DD>) whose facet date satisfies all bounds — the exact
 *     RETR-003 window semantics (buildTimeRangeConditions).
 *
 * This module NEVER writes: no checkout, no worktree, no index mutation.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { isValidIso8601 } from "../utils/timerange";
import type { Manifest } from "../storage/manifest";

/**
 * Row shape returned by the as-of reader — mirrors the columns
 * queryMemories selects (id, key, domain, timestamp, author, action,
 * embedding_text, attributes).
 */
export interface MemoryRowAtRef {
  id: string;
  key: string;
  domain: string;
  timestamp: string;
  author: string;
  action: string;
  embedding_text: string;
  attributes: Record<string, unknown>;
}

/**
 * Filters for the as-of list path — the subset of MemoryQueryFilters that
 * can be applied to in-memory rows (query/embedding are semantic paths and
 * are rejected by the recall surface before reaching this module).
 */
export interface AsOfFilters {
  key?: string;
  keyPrefix?: string;
  domain?: string;
  author?: string;
  id?: string;
  /** RETR-003: include rows whose timestamp (or chat-archive key facet) is at or after this ISO instant */
  after?: string;
  /** RETR-003: include rows whose timestamp (or chat-archive key facet) is at or before this ISO instant */
  before?: string;
  /** RETR-006: include only rows whose `attributes` contains name → value
   *  (exact match after String() normalization — mirrors DuckDB's
   *  json_extract_string stringification: numeric 403 matches "403"). */
  attr?: Record<string, string>;
  limit?: number;
}

/** Chat-archive key facet: /chats/<view>/<YYYY-MM-DD>[/...] (RETR-003). */
const CHAT_FACET_RE = /^\/chats\/[^/]+\/(\d{4}-\d{2}-\d{2})(\/|$)/;

/** Run git in the namespace repo. Returns stdout ("" on any failure). */
function gitOut(repoDir: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

/**
 * Reject manifest-supplied paths that would escape the repo root
 * (defense-in-depth: partitions come from git history, but a hostile or
 * corrupt manifest must never turn `git show` into a path traversal).
 */
function assertSafeRepoPath(p: string): void {
  if (p.startsWith("/") || p.split(/[\\/]/).includes("..")) {
    throw new Error(`Unsafe path in namespace manifest: '${p}'`);
  }
}

/**
 * Resolve an --as-of value to a concrete commit SHA.
 *
 * @param rawRef - ISO-8601 date/datetime (date-only is inclusive of that
 *   whole day, matching git's own --before date parsing), or a commit hash
 *   (full or short), branch name, or tag.
 * @param repoDir - Namespace directory (its own git repo).
 * @returns Full commit SHA.
 * @throws Error with a human-readable message for: a namespace without git
 *   history, a date with no commit at-or-before it, or an unresolvable ref.
 */
export function resolveAsOfRef(rawRef: string, repoDir: string): string {
  const trimmed = rawRef.trim();
  if (trimmed === "") {
    throw new Error("--as-of requires a date or a git commit reference");
  }
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    throw new Error(
      `Namespace at ${repoDir} is not a git repository — as-of recall requires namespace git history`,
    );
  }

  if (isValidIso8601(trimmed)) {
    // Nearest commit at-or-before the given date. Date-only input is
    // inclusive of the whole day, so normalize it to an explicit UTC
    // end-of-day instant: git parses a BARE date-only --before value in the
    // HOST timezone (end-of-day in UTC-5, midnight in UTC — TZ-dependent,
    // verified 2026-08-19: TZ=UTC returned the previous day's commit). The
    // explicit .999Z bound is machine-independent. Datetimes already carry
    // Z or ±HH:MM and pass through unchanged.
    const bound = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
      ? `${trimmed}T23:59:59.999Z`
      : trimmed;
    const sha = gitOut(repoDir, [
      "rev-list",
      "-1",
      `--before=${bound}`,
      "HEAD",
    ]).trim();
    if (sha === "") {
      throw new Error(`No commit found at or before ${trimmed}`);
    }
    return sha;
  }

  // Direct ref: commit hash (full or short), branch, or tag.
  const sha = gitOut(repoDir, [
    "rev-parse",
    "--verify",
    `${trimmed}^{commit}`,
  ]).trim();
  if (sha === "") {
    throw new Error(
      `Invalid --as-of value '${trimmed}': not an ISO-8601 date and not a resolvable git commit, branch, or tag`,
    );
  }
  return sha;
}

/**
 * Read the namespace manifest as it existed at a ref.
 *
 * @returns The manifest, or null when the namespace had no manifest at that
 *   ref (i.e. it did not exist at that point in history).
 */
export function readManifestAtRef(
  repoDir: string,
  ref: string,
): Manifest | null {
  const raw = gitOut(repoDir, ["show", `${ref}:manifest.json`]);
  if (raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Manifest>;
    if (!Array.isArray(parsed.partitions)) return null;
    return {
      partitions: parsed.partitions,
      lastUpdated: parsed.lastUpdated ?? "",
    };
  } catch (error) {
    // Mirrors getManifest: a corrupt manifest degrades to an empty one.
    console.warn(
      `Warning: Could not parse manifest at ref ${ref} in ${repoDir}, treating as empty`,
    );
    return { partitions: [], lastUpdated: "" };
  }
}

/**
 * Read every memory row present in the namespace at a ref.
 *
 * Walks the manifest at that ref, lists each partition's chunk files with
 * `git ls-tree`, and reads every *.jsonl chunk with `git show`. Malformed
 * lines are skipped (mirrors read_json ignore_errors=true); chunks that
 * vanish between listing and reading are skipped.
 *
 * @throws Error when the manifest lists an unsafe (escaping) partition path.
 */
export function readRowsAtRef(repoDir: string, ref: string): MemoryRowAtRef[] {
  const manifest = readManifestAtRef(repoDir, ref);
  if (!manifest) return [];

  const rows: MemoryRowAtRef[] = [];
  for (const partition of manifest.partitions) {
    assertSafeRepoPath(partition);
    const listing = gitOut(repoDir, [
      "ls-tree",
      "-r",
      "--name-only",
      ref,
      "--",
      partition,
    ]);
    for (const line of listing.split("\n")) {
      const file = line.trim();
      if (file === "" || !file.endsWith(".jsonl")) continue;
      assertSafeRepoPath(file);

      const content = gitOut(repoDir, ["show", `${ref}:${file}`]);
      if (content === "") continue; // chunk not present at ref — skip

      for (const line2 of content.split("\n")) {
        const jsonLine = line2.trim();
        if (jsonLine === "") continue;
        try {
          const rec = JSON.parse(jsonLine) as Record<string, unknown>;
          if (typeof rec.id !== "string" || rec.id === "") continue;
          rows.push({
            id: rec.id,
            key: typeof rec.key === "string" ? rec.key : "",
            domain: typeof rec.domain === "string" ? rec.domain : "",
            timestamp: typeof rec.timestamp === "string" ? rec.timestamp : "",
            author: typeof rec.author === "string" ? rec.author : "",
            action: typeof rec.action === "string" ? rec.action : "add",
            embedding_text:
              typeof rec.embedding_text === "string" ? rec.embedding_text : "",
            attributes:
              typeof rec.attributes === "object" && rec.attributes !== null
                ? (rec.attributes as Record<string, unknown>)
                : {},
          });
        } catch {
          // Malformed line — skip (ignore_errors=true mirror).
        }
      }
    }
  }
  return rows;
}

/** Parse a row timestamp to an instant; unparseable → -Infinity (sorts last). */
function parseTs(value: string): number {
  const t = Date.parse(value);
  return Number.isNaN(t) ? -Infinity : t;
}

/** RETR-003 window semantics: timestamp satisfies all bounds OR chat-archive key facet does. */
function matchesTimeWindow(
  row: MemoryRowAtRef,
  after?: string,
  before?: string,
): boolean {
  if (after === undefined && before === undefined) return true;
  const afterTs = after !== undefined ? Date.parse(after) : undefined;
  const beforeTs = before !== undefined ? Date.parse(before) : undefined;

  const ts = parseTs(row.timestamp);
  const tsOk =
    ts !== -Infinity &&
    (afterTs === undefined || ts >= afterTs) &&
    (beforeTs === undefined || ts <= beforeTs);
  if (tsOk) return true;

  const facet = CHAT_FACET_RE.exec(row.key);
  if (!facet) return false;
  const facetTs = Date.parse(`${facet[1]}T00:00:00.000Z`);
  return (
    (afterTs === undefined || facetTs >= afterTs) &&
    (beforeTs === undefined || facetTs <= beforeTs)
  );
}

/** Apply the list-path filters (inner WHERE mirror) to one row. */
function matchesFilters(row: MemoryRowAtRef, filters: AsOfFilters): boolean {
  if (filters.key !== undefined && row.key !== filters.key) return false;
  if (filters.id !== undefined && row.id !== filters.id) return false;
  if (
    filters.keyPrefix !== undefined &&
    !row.key.startsWith(filters.keyPrefix)
  ) {
    return false;
  }
  if (filters.domain !== undefined && row.domain !== filters.domain) {
    return false;
  }
  if (filters.author !== undefined && row.author !== filters.author) {
    return false;
  }
  // RETR-006: attribute filters — in-memory mirror of the DuckDB
  // json_extract_string conditions: every name→value pair must match, and
  // scalars compare by their string form (403 → "403"). A missing key
  // never matches.
  if (filters.attr !== undefined) {
    for (const [name, value] of Object.entries(filters.attr)) {
      const actual = row.attributes[name];
      if (actual === undefined || String(actual) !== value) return false;
    }
  }
  return matchesTimeWindow(row, filters.after, filters.before);
}

/** Dedup by id keeping the latest record (parsed timestamp; tie → last occurrence). */
function dedupeById(rows: MemoryRowAtRef[]): MemoryRowAtRef[] {
  const byId = new Map<string, MemoryRowAtRef>();
  for (const row of rows) {
    const existing = byId.get(row.id);
    if (
      existing === undefined ||
      parseTs(row.timestamp) >= parseTs(existing.timestamp)
    ) {
      byId.set(row.id, row);
    }
  }
  return [...byId.values()];
}

/** RETR-005 default order: timestamp DESC (unparseable last), id ASC. */
function compareNewestFirst(a: MemoryRowAtRef, b: MemoryRowAtRef): number {
  const ta = parseTs(a.timestamp);
  const tb = parseTs(b.timestamp);
  if (tb !== ta) return tb - ta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Query the namespace state at a ref with the list-path filter semantics.
 *
 * Equivalent to queryMemories + countMemories over the partition files AS
 * THEY EXISTED at `ref` — including dedup-by-id (latest wins), tombstone
 * exclusion, RETR-003 time windows, and RETR-005 newest-first ordering.
 *
 * @param repoDir - Namespace directory (its own git repo).
 * @param ref - A RESOLVED commit SHA (see resolveAsOfRef).
 * @param filters - List-path filters; limit slices the final ordering.
 * @returns { memories, total } — total is the full match count, unlimited by
 *   limit (GAP-024 semantics).
 */
export function queryMemoriesAtRef(
  repoDir: string,
  ref: string,
  filters: AsOfFilters = {},
): { memories: MemoryRowAtRef[]; total: number } {
  const rows = readRowsAtRef(repoDir, ref);
  const filtered = rows.filter((r) => matchesFilters(r, filters));
  const deduped = dedupeById(filtered);
  // Outer WHERE mirror: a memory whose latest record is a tombstone is gone.
  const live = deduped.filter((r) => r.action !== "tombstone");
  const sorted = live.sort(compareNewestFirst);
  const memories =
    filters.limit !== undefined ? sorted.slice(0, filters.limit) : sorted;
  return { memories, total: sorted.length };
}
