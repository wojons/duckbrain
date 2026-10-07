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
 *   - dedup keeps the LATEST record per id (ROW_NUMBER ... ORDER BY
 *     try_cast(timestamp AS TIMESTAMP) DESC NULLS LAST); the DuckDB window
 *     and this mirror BOTH order by parsed instant (SYNC-2026-09-28-001 — the
 *     DuckDB window previously ordered by the RAW varchar, which misordered
 *     mixed-format timestamps), matching the RETR-005 final ORDER BY intent
 *   - a memory whose latest record is a tombstone is excluded
 *   - final order: timestamp DESC (unparseable last), id ASC; then LIMIT
 *   - after/before bounds match a row when its OWN timestamp satisfies all
 *     bounds OR its key carries a chat-archive date facet (/chats/<view>/
 *     <YYYY-MM-DD>) whose facet date satisfies all bounds — the exact
 *     RETR-003 window semantics (buildTimeRangeConditions).
 *
 * This module NEVER writes: no checkout, no worktree, no index mutation.
 */

import { execFileSync, spawnSync } from "child_process";
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
  /** DB-GAP-046: page window start — mirrors MemoryQueryFilters.offset so the
   *  as-of read (in-memory mirror of the list path) pages identically:
   *  rows [offset, offset+limit) of the newest-first ordering. */
  offset?: number;
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
 * PERF-011: batch-read every blob path in ONE `git cat-file --batch` process.
 *
 * Input: a list of ref-relative paths. Output: a map path → file content
 * (blob text; missing paths and non-blob entries are simply absent). Binaries
 * are not expected (chunks and manifests are JSONL/JSON text), but a corrupt
 * or binary blob is tolerated by treating only the FIRST line as its path —
 * pathological content just degrades to that path being unparseable, never a
 * crash (spawnSync errors / empty git output yield an empty map).
 *
 * This is the latency fix: the old reader spawned one `git show` per chunk
 * (hundreds of child processes on prod-scale namespaces); cat-file --batch
 * reads all of them from a single git process over one pipe round-trip.
 */
export function catFileBatch(
  repoDir: string,
  paths: string[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  try {
    const res = spawnSync("git", ["cat-file", "--batch"], {
      cwd: repoDir,
      input: paths.join("\n") + "\n",
      // NOTE: no `encoding` option — stdout/stdin are Buffers by default.
      // (encoding: "buffer" is not a valid encoding and makes spawnSync
      // throw ERR_UNKNOWN_ENCODING on Node 22.)
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (res.error || res.status !== 0 || !res.stdout) return out;
    const buf = res.stdout;
    let pos = 0;
    // cat-file --batch answers requests IN ORDER:
    //   hit:     "<oid> SP blob SP <size> LF <content> LF"
    //   missing: "<request> LF missing LF"
    // Hits do NOT echo the requested path, so responses are matched to the
    // requests by position (git preserves request order).
    for (const request of paths) {
      if (pos >= buf.length) break;
      const nl1 = buf.indexOf(0x0a, pos);
      if (nl1 === -1) break;
      const header = buf.toString("utf-8", pos, nl1);
      const m = /^[0-9a-f]{40} blob (\d+)$/.exec(header.trim());
      if (m) {
        const len = Number(m[1]);
        const contentStart = nl1 + 1;
        const contentEnd = contentStart + len;
        if (contentEnd > buf.length) break; // truncated output — stop safely
        out.set(request, buf.toString("utf-8", contentStart, contentEnd));
        pos = contentEnd + 1; // trailing newline after the blob body
      } else {
        // Missing / non-blob: consume the "<request>\nmissing\n" pair.
        const nl2 = buf.indexOf(0x0a, nl1 + 1);
        if (nl2 === -1) break;
        pos = nl2 + 1;
      }
    }
  } catch {
    // Fall through: an unusable batch read returns whatever was parsed.
  }
  return out;
}

/** Shared manifest parse (warn + degrade to empty on corrupt input). */
function parseManifestRaw(
  raw: string,
  ref: string,
  repoDir: string,
): Manifest | null {
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
 * Read the namespace manifest as it existed at a ref, from a pre-fetched
 * batch of file contents (PERF-011 hot path — avoids a dedicated git call).
 */
export function readManifestAtRef(
  repoDir: string,
  ref: string,
  preloaded?: Map<string, string>,
): Manifest | null {
  const raw =
    preloaded?.get("manifest.json") ??
    gitOut(repoDir, ["show", `${ref}:manifest.json`]);
  return parseManifestRaw(raw, ref, repoDir);
}

/**
 * Read every memory row present in the namespace at a ref (PERF-011).
 *
 * Walks the manifest at that ref, lists ALL chunk files in ONE
 * `git ls-tree -r` over the whole tree (instead of one per partition),
 * and reads the manifest + every *.jsonl chunk in ONE
 * `git cat-file --batch` process (instead of one `git show` per file).
 * Malformed lines are skipped (mirrors read_json ignore_errors=true);
 * chunks that vanish between listing and reading are skipped.
 *
 * @throws Error when the manifest lists an unsafe (escaping) partition path.
 */
export function readRowsAtRef(repoDir: string, ref: string): MemoryRowAtRef[] {
  // PERF-011: one whole-tree ls-tree + ONE cat-file --batch for the manifest
  // and every chunk (cat-file resolves REVISIONS, hence the ref: prefix).
  const revOf = (file: string): string => `${ref}:${file}`;
  const allPaths = new Set<string>(["manifest.json"]);
  const listing = gitOut(repoDir, ["ls-tree", "-r", "--name-only", ref]);
  for (const line of listing.split("\n")) {
    const file = line.trim();
    if (file === "" || !file.endsWith(".jsonl")) continue;
    try {
      assertSafeRepoPath(file);
      allPaths.add(file);
    } catch {
      // A manifest-independent tree entry cannot be validated — skip it.
    }
  }
  const contents = catFileBatch(repoDir, [...allPaths].map(revOf));

  const manifestRaw = contents.get(revOf("manifest.json"));
  const manifest =
    manifestRaw !== undefined
      ? parseManifestRaw(manifestRaw, ref, repoDir)
      : readManifestAtRef(repoDir, ref);
  if (!manifest) return [];

  const rows: MemoryRowAtRef[] = [];
  for (const partition of manifest.partitions) {
    assertSafeRepoPath(partition);
    // Manifests may carry trailing slashes (historical format) — normalize
    // so the tree-path prefix match stays exact (matches git pathspec
    // semantics of the previous per-partition `ls-tree -- <partition>`).
    const prefix = `${partition.replace(/\/+$/, "")}/`;
    for (const file of allPaths) {
      if (file === "manifest.json") continue;
      if (!file.startsWith(prefix)) continue;
      const content = contents.get(revOf(file));
      if (content === undefined || content === "") continue;

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
  // DB-GAP-046: the page window is [offset, offset+limit) of the ordering —
  // same semantics as the DuckDB list path's SQL LIMIT/OFFSET.
  const offset = filters.offset ?? 0;
  const memories =
    filters.limit !== undefined
      ? sorted.slice(offset, offset + filters.limit)
      : sorted.slice(offset);
  return { memories, total: sorted.length };
}
