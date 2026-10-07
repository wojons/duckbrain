/**
 * OBS-DUCKBRAIN-001 — per-route read ledger.
 *
 * Writes are audited (SUPA-2 `_audit` ledgers plus the server-level
 * `.duckbrain-audit/denials.jsonl`); reads were invisible. This module gives
 * every recorded read-path request exactly one JSONL row in
 * `.duckbrain-audit/reads.jsonl`, mirroring the server denial ledger's
 * storage pattern (src/serialization/audit.ts:appendServerDenial): bounded
 * append-only file, single `.1` rotation, 0o600 mode, non-blocking serialized
 * append whose failure can never break a served response.
 *
 * Row shape (exactly one row per recorded read):
 *   { ts: ISO, route: normalized route template, method, ns, status, dur_ms }
 *
 * `route` is a NORMALIZED TEMPLATE — real key/id/namespace VALUES are never
 * written (`GET /api/memories/key/:key`, never the key itself). Query strings
 * are never logged. `ns` is the namespace the request EXPLICITLY scoped (a
 * path parameter or `?namespace=`) and is null when it named none — the
 * resolved default is deliberately NOT materialized, to keep per-request
 * config I/O off the hot read path (null here means "request named no
 * namespace", a documented reason, not an unexplained hole). Rows therefore
 * never carry memory content, tokens, principals, or raw query strings.
 *
 * Recorded read paths (GET/HEAD only): /api/memories, /api/keys,
 * /api/namespaces, /api/ns/:ns/tables, /activity, /api/events/:ns(+ /stats).
 * Deliberately NOT recorded: /health and /stats (metrics noise), write
 * methods, unknown routes, the query surface itself (/api/reads — no
 * self-recording), the realtime SSE stream (/api/ns/:ns/changes — a long-lived
 * subscription, not a query; out of the OBS-DUCKBRAIN-001 route set).
 *
 * Querying: GET /api/reads (src/http/routes/reads.ts) aggregates this ledger
 * over an arbitrary ts window — including windows entirely older than the
 * process's uptime, because the ledger is durable on disk, not in memory.
 */

import fs from "fs";
import path from "path";
import { z } from "zod";

/** Storage directory — the existing server audit dir convention. */
export const READS_DIR = ".duckbrain-audit";
/** Active ledger file (the segment new rows append to). */
export const READS_FILE = "reads.jsonl";
/** Byte bound — same 10 MB budget as the server denial ledger. */
export const READS_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Sealed-segment name for a segment number: `reads.0001.jsonl`, … zero-padded
 * to 4 digits (the auditLedger.ts numeric-segment basis, namespaced with a
 * `reads.` prefix because .duckbrain-audit/ holds more than one ledger).
 * Sealed segments are never reopened, rewritten, or deleted — rotation renames
 * the previous active file into the next number, so no row is ever lost, and
 * read-back is always oldest-segment-first, active file last.
 */
export function readsSegmentName(value: number): string {
  return `reads.${String(value).padStart(4, "0")}.jsonl`;
}

export function readsSegmentNumber(name: string): number | null {
  const match = /^reads\.(\d{4,})\.jsonl$/.exec(name);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export const ReadRowSchema = z.object({
  /** Request completion time, ISO 8601 UTC. */
  ts: z.string().datetime(),
  /** Normalized route template — no real key/id/ns values (see module doc). */
  route: z.string().min(1),
  /** Uppercase HTTP verb of the recorded read (GET/HEAD only, by design). */
  method: z.string().min(1),
  /** Explicitly scoped namespace, or null when the request named none. */
  ns: z.string().min(1).nullable(),
  /** Response status code. */
  status: z.number().int().min(100).max(599),
  /** Wall duration of the request in whole milliseconds. */
  dur_ms: z.number().int().min(0),
});

export type ReadRow = z.infer<typeof ReadRowSchema>;
export type ReadRowInput = z.input<typeof ReadRowSchema>;

/**
 * Serialized append tail — the exact pattern of `denialAuditTail` in
 * src/serialization/audit.ts: every append chains onto one module-level
 * promise so concurrent rotations can never interleave, errors are logged and
 * swallowed, and tests can await the chain via flushReadLedgerForTests().
 */
let readLedgerTail: Promise<void> = Promise.resolve();

export interface ReadLedgerStore {
  /** Queue one row; resolves once the row is durably appended (or dropped). */
  append(row: ReadRowInput): Promise<void>;
}

export interface ReadLedgerStoreOptions {
  /** Byte bound for the active segment (default READS_MAX_BYTES). */
  maxBytes?: number;
  /** Failure sink (default console.error). */
  log?: (message: string) => void;
}

export function createReadLedgerStore(
  namespacesPath: string,
  options: ReadLedgerStoreOptions = {},
): ReadLedgerStore {
  const root = path.resolve(namespacesPath);
  const maxBytes = options.maxBytes ?? READS_MAX_BYTES;
  const log =
    options.log ?? ((message: string) => console.error(message));

  return {
    append(input: ReadRowInput): Promise<void> {
      const run = async (): Promise<void> => {
        const row = ReadRowSchema.parse(input);
        const dir = path.join(root, READS_DIR);
        const file = path.join(dir, READS_FILE);
        await fs.promises.mkdir(dir, { recursive: true });
        const line = JSON.stringify(row) + "\n";
        const lineBytes = Buffer.byteLength(line, "utf-8");
        if (lineBytes > maxBytes) {
          throw new Error("read ledger row exceeds the configured log bound");
        }
        let size = 0;
        try {
          size = (await fs.promises.stat(file)).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (size + lineBytes > maxBytes) {
          // Seal the active segment under the next monotonic number. Sealed
          // segments are never reopened or deleted, so a long-running server
          // never loses history to rotation (unlike a single `.1` slot).
          const existing = await fs.promises.readdir(dir);
          const highest = existing.reduce(
            (max, name) => Math.max(max, readsSegmentNumber(name) ?? 0),
            0,
          );
          await fs.promises.rename(file, path.join(dir, readsSegmentName(highest + 1)));
        }
        await fs.promises.appendFile(file, line, {
          encoding: "utf-8",
          mode: 0o600,
        });
      };
      readLedgerTail = readLedgerTail
        .then(run)
        .catch((error) => {
          log(
            `[duckbrain] read ledger append failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      return readLedgerTail;
    },
  };
}

/** Await every pending ledger append (test seam, mirrors the denial sink). */
export async function flushReadLedgerForTests(): Promise<void> {
  await readLedgerTail;
}

export interface ReadLedgerContents {
  /** Valid rows, chronological: rotated generation first, then current. */
  rows: ReadRow[];
  /** Lines that were not parseable as a valid row — skipped, never fatal. */
  skippedMalformed: number;
  /** Files actually read, in traversal order. */
  filesRead: string[];
}

/**
 * Read the whole ledger: sealed numeric segments in ascending order, then the
 * active file (the canonical auditLedger.ts traversal — oldest first, active
 * last). A malformed line is counted in `skippedMalformed` and skipped: this
 * is observability telemetry, and one torn line must never break a query
 * about reads — the count keeps the gap visible instead of silent.
 */
export function readReadRows(namespacesPath: string): ReadLedgerContents {
  const dir = path.join(path.resolve(namespacesPath), READS_DIR);
  const contents: ReadLedgerContents = {
    rows: [],
    skippedMalformed: 0,
    filesRead: [],
  };
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => {
      if (name === READS_FILE) return true;
      return readsSegmentNumber(name) !== null;
    });
  } catch {
    return contents;
  }
  names.sort((left, right) => {
    const l = readsSegmentNumber(left);
    const r = readsSegmentNumber(right);
    if (l !== null && r !== null) return l - r;
    if (l !== null) return -1; // sealed segments precede the active file
    return left === right ? 0 : 1;
  });
  for (const name of names) {
    const file = path.join(dir, name);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    contents.filesRead.push(name);
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        contents.rows.push(ReadRowSchema.parse(JSON.parse(line)));
      } catch {
        contents.skippedMalformed += 1;
      }
    }
  }
  return contents;
}

/**
 * Normalize one request into its recorded route template, or null when the
 * request is not a recorded read. Combines the read-path truth table and the
 * value-stripping rules in one place so the middleware has a single decision
 * to make. Trailing slashes are folded (Express non-strict routing); query
 * strings never reach this function's output because only req.path is taken.
 */
export function normalizeReadRoute(
  method: string,
  rawPath: string,
): string | null {
  const verb = method.toUpperCase();
  if (verb !== "GET" && verb !== "HEAD") return null;
  let p = rawPath.split("?")[0];
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (p === "") p = "/";
  const route = (template: string): string => `${verb} ${template}`;

  // memories
  if (/^\/api\/memories$/.test(p)) return route("/api/memories");
  if (/^\/api\/memories\/key\/.+$/.test(p)) return route("/api/memories/key/:key");
  if (/^\/api\/memories\/[^/]+$/.test(p)) return route("/api/memories/:id");
  // keys
  if (/^\/api\/keys$/.test(p)) return route("/api/keys");
  if (/^\/api\/keys\/flat$/.test(p)) return route("/api/keys/flat");
  // namespaces
  if (/^\/api\/namespaces$/.test(p)) return route("/api/namespaces");
  // tables (declared table→REST layer)
  if (/^\/api\/ns\/[^/]+\/tables$/.test(p)) return route("/api/ns/:ns/tables");
  if (/^\/api\/ns\/[^/]+\/tables\/[^/]+$/.test(p)) {
    return route("/api/ns/:ns/tables/:table");
  }
  // activity feed
  if (/^\/activity$/.test(p)) return route("/activity");
  // legacy events feed (SSE subscription + its stats probe)
  if (/^\/api\/events\/[^/]+\/stats$/.test(p)) return route("/api/events/:ns/stats");
  if (/^\/api\/events\/[^/]+$/.test(p)) return route("/api/events/:ns");
  return null;
}

/**
 * The namespace a request EXPLICITLY scoped, or null when it named none.
 * Priority: path parameter (/api/events/:ns, /api/ns/:ns/...) then the
 * ?namespace= query parameter. Query values other than a non-empty string
 * (arrays, objects) yield null. Malformed percent-encoding falls back to the
 * raw segment rather than throwing on the hot path.
 */
export function readRowNamespace(
  rawPath: string,
  query: Record<string, unknown>,
): string | null {
  let p = rawPath.split("?")[0];
  if (p.length > 1) p = p.replace(/\/+$/, "");
  const fromPath = /^(?:\/api\/events|\/api\/ns)\/([^/]+)/.exec(p);
  if (fromPath) {
    try {
      return decodeURIComponent(fromPath[1]);
    } catch {
      return fromPath[1];
    }
  }
  const ns = query.namespace;
  return typeof ns === "string" && ns !== "" ? ns : null;
}

export interface ReadLedgerQuery {
  /** Inclusive lower ts bound (ISO 8601). Null/undefined = no lower bound. */
  from?: string | null;
  /** Inclusive upper ts bound (ISO 8601). Null/undefined = no upper bound. */
  to?: string | null;
  /** Exact normalized route template (e.g. "GET /api/memories"). */
  route?: string | null;
  /** Exact explicitly-scoped namespace value. */
  ns?: string | null;
  /**
   * Namespace allow-list for scope-confined principals (DB-GAP-062 doctrine).
   * undefined = unrestricted (unscoped token or auth=none). When set, rows
   * whose ns is an ungranted namespace are excluded; null-ns rows stay visible
   * (they carry no namespace name at all).
   */
  visibleNamespaces?: readonly string[] | undefined;
}

export interface ReadLedgerRouteAggregate {
  route: string;
  method: string;
  count: number;
  /** status code → count, within this route. */
  statuses: Record<string, number>;
}

export interface ReadLedgerAggregate {
  window: { from: string | null; to: string | null };
  filter: { route: string | null; ns: string | null };
  /** Rows matching every filter. */
  total: number;
  /** Per-route tallies, count descending then route ascending. */
  routes: ReadLedgerRouteAggregate[];
  /** status code → count across all matching rows. */
  by_status: Record<string, number>;
  /** Malformed ledger lines skipped while reading (never silent). */
  skipped_malformed: number;
  /** Ledger files read, in traversal order. */
  files_read: string[];
}

/**
 * Aggregate the ledger over an arbitrary historical window. `from`/`to` must
 * already be valid ISO timestamps (the route layer turns bad input into a
 * 400 before calling this); bounds are inclusive and compared on epoch
 * milliseconds so windows spanning process restarts behave.
 */
export function aggregateReadRows(
  namespacesPath: string,
  query: ReadLedgerQuery = {},
): ReadLedgerAggregate {
  const { rows, skippedMalformed, filesRead } = readReadRows(namespacesPath);
  const fromMs =
    query.from !== undefined && query.from !== null
      ? Date.parse(query.from)
      : null;
  const toMs =
    query.to !== undefined && query.to !== null ? Date.parse(query.to) : null;
  const visible = query.visibleNamespaces;

  const perRoute = new Map<
    string,
    { route: string; method: string; count: number; statuses: Record<string, number> }
  >();
  const byStatus: Record<string, number> = {};
  let total = 0;

  for (const row of rows) {
    const t = Date.parse(row.ts);
    if (fromMs !== null && !(t >= fromMs)) continue;
    if (toMs !== null && !(t <= toMs)) continue;
    if (query.route != null && row.route !== query.route) continue;
    if (query.ns != null && row.ns !== query.ns) continue;
    if (visible !== undefined && row.ns !== null && !visible.includes(row.ns)) {
      continue;
    }

    total += 1;
    const statusKey = String(row.status);
    byStatus[statusKey] = (byStatus[statusKey] ?? 0) + 1;
    const key = `${row.method} ${row.route}`;
    let entry = perRoute.get(key);
    if (!entry) {
      entry = { route: row.route, method: row.method, count: 0, statuses: {} };
      perRoute.set(key, entry);
    }
    entry.count += 1;
    entry.statuses[statusKey] = (entry.statuses[statusKey] ?? 0) + 1;
  }

  const routes = [...perRoute.values()].sort((left, right) =>
    left.count !== right.count
      ? right.count - left.count
      : left.route.localeCompare(right.route),
  );

  const by_status: Record<string, number> = {};
  for (const key of Object.keys(byStatus).sort()) {
    by_status[key] = byStatus[key];
  }

  return {
    window: {
      from: query.from ?? null,
      to: query.to ?? null,
    },
    filter: { route: query.route ?? null, ns: query.ns ?? null },
    total,
    routes,
    by_status,
    skipped_malformed: skippedMalformed,
    files_read: filesRead,
  };
}
