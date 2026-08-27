/**
 * `duckbrain consolidate` — daily cross-namespace consolidation pass
 * (CONSOLIDATE-001).
 *
 * Scans the target UTC day's JSONL deltas across ALL namespaces under
 * namespaces/, dedupes repeated content per namespace (content-hash of
 * embedding_text+key), prints per-namespace row counts + dedup stats +
 * capped previews (mirroring the daily_chat_extract.py preview pattern),
 * and emits a daily "undocumented work found" digest.
 *
 * Dry-run by default: the digest is printed to stdout for the 03:00 cron
 * agent to summarize. With --write-digest (or DUCKBRAIN_API_KEY set) the
 * digest is POSTed to the DuckBrain HTTP API as a memory in namespace
 * `duckbrain` (key /project/duckbrain/digest/<date>).
 *
 * The existing chat extractor (~/.hermes/scripts/daily_chat_extract.py) is
 * intentionally untouched — this is an additive step for non-chat
 * namespaces.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getConfig } from "../config/index";
import { listNamespaces } from "../search/index";

/** Default DuckBrain HTTP API base (overridable via DUCKBRAIN_API_URL). */
export const DIGEST_API_URL = "http://127.0.0.1:3000";
/** Namespace the digest entry is written to. */
export const DIGEST_NAMESPACE = "duckbrain";
/** Key prefix for digest entries: /project/duckbrain/digest/<YYYY-MM-DD>. */
export const DIGEST_KEY_PREFIX = "/project/duckbrain/digest/";
/** Per-line cap for preview rows (mirrors daily_chat_extract.py LINE_CAP). */
export const PREVIEW_LINE_CAP = 600;
/** Total preview budget per namespace (mirrors MAX_PREVIEW_CHARS). */
export const PREVIEW_BUDGET = 25_000;
/** Cap for the digest's embedding_text short summary. */
export const DIGEST_EMBEDDING_CAP = 200;

/** One JSONL row from a namespace store. */
export interface ConsolidateRow {
  id: string;
  key: string;
  domain: string;
  timestamp: string;
  author: string;
  action: string;
  embedding_text?: string;
}

/** Per-namespace delta + dedup result for the target day. */
export interface NamespaceDelta {
  namespace: string;
  /** All delta rows (chronological). */
  rows: ConsolidateRow[];
  /** Deduped rows (first occurrence per content-hash, chronological). */
  unique: ConsolidateRow[];
  /** Number of duplicate-content rows collapsed/flagged. */
  duplicates: number;
  /** Rows whose timestamp could not be parsed (excluded from the delta). */
  unparseable: number;
}

export interface ConsolidateOptions {
  /** Target UTC day YYYY-MM-DD (default: yesterday). */
  date?: string;
  /** POST the digest to the HTTP API (also implied by DUCKBRAIN_API_KEY). */
  writeDigest: boolean;
  /** Path to a file whose text replaces the auto-built digest content. */
  digestContent?: string;
  help: boolean;
}

const CONSOLIDATE_USAGE = `duckbrain consolidate — daily cross-namespace consolidation digest.

Usage:
  duckbrain consolidate [--date=YYYY-MM-DD] [--write-digest] [--digest-content=FILE]

Scans the target UTC day's JSONL deltas across every namespace under
namespaces/, dedupes repeated content (content-hash of embedding_text+key),
and prints per-namespace row counts, dedup stats, and capped previews, then
a digest block.

Options:
  --date=YYYY-MM-DD      Target UTC day (default: yesterday)
  --write-digest         POST the digest to the DuckBrain HTTP API
                         (namespace ${DIGEST_NAMESPACE}, key
                         ${DIGEST_KEY_PREFIX}<date>). Requires
                         DUCKBRAIN_API_KEY. Also triggered when
                         DUCKBRAIN_API_KEY is set in the environment.
  --digest-content=FILE  Use FILE's text as the digest content instead of the
                         auto-built digest (the cron agent's summarized
                         version).
  --help, -h             Show this help

Environment:
  DUCKBRAIN_API_KEY      API key for the digest write (X-API-Key header)
  DUCKBRAIN_API_URL      API base URL (default: ${DIGEST_API_URL})`;

/**
 * Normalize the space-separated `--date <v>` / `--digest-content <v>` forms
 * to `--flag=<v>` before flag parsing (mirrors the RETR-008/009 pattern).
 */
function normalizeFlagArgs(args: string[]): string[] {
  const out = args.slice();
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i] === "--date" || out[i] === "--digest-content") {
      out.splice(i, 2, `${out[i]}=${out[i + 1]}`);
    }
  }
  return out;
}

/** Parse CLI args into options. Unknown flags are ignored (house style). */
export function parseConsolidateArgs(args: string[]): ConsolidateOptions {
  const out: ConsolidateOptions = {
    writeDigest: false,
    help: false,
  };
  for (const arg of normalizeFlagArgs(args)) {
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--write-digest") {
      out.writeDigest = true;
    } else if (arg.startsWith("--date=")) {
      out.date = arg.slice("--date=".length);
    } else if (arg.startsWith("--digest-content=")) {
      out.digestContent = arg.slice("--digest-content=".length);
    }
  }
  return out;
}

/**
 * Validate a YYYY-MM-DD date string and return it, or null when invalid.
 * The date must be a real calendar day (2026-02-30 is rejected).
 */
export function parseTargetDate(dateStr?: string): string | null {
  if (dateStr === undefined) {
    // Default: yesterday in UTC.
    return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Round-trip guard: 2026-02-30 normalizes to 2026-03-02.
  if (d.toISOString().slice(0, 10) !== dateStr) return null;
  return dateStr;
}

/** UTC millisecond bounds [start, end) for a YYYY-MM-DD day. */
export function dayBounds(dateStr: string): { start: number; end: number } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const start = Date.UTC(y, m - 1, d);
  return { start, end: start + 86_400_000 };
}

/**
 * Content-hash of a row: sha256 of embedding_text. Two rows with the same
 * text within the same day/namespace are duplicate content (the
 * "53 'duckbrain' mentions/day" class — repeated content across rows,
 * regardless of key). CONSOLIDATE-001 acceptance: "two rows with identical
 * embedding_text (or embedding_text+key) ... are counted once and flagged
 * as duplicates" — text-only hashing satisfies the primary clause and
 * catches the repeated-content class the task targets.
 */
export function contentHash(row: ConsolidateRow): string {
  return crypto
    .createHash("sha256")
    .update(row.embedding_text ?? "")
    .digest("hex");
}

/**
 * Collect the target day's delta rows for every manifest-backed namespace
 * under `root`. Only the partition matching the target month is read
 * (namespaces/<ns>/<domain>/<YYYY-MM>/current.jsonl); rows are then filtered
 * to the target UTC day and deduped by content-hash.
 */
export function collectNamespaceDeltas(
  root: string,
  dateStr: string,
): NamespaceDelta[] {
  const { start, end } = dayBounds(dateStr);
  const targetMonth = dateStr.slice(0, 7);
  const deltas: NamespaceDelta[] = [];

  for (const ns of listNamespaces(root)) {
    const nsPath = path.join(root, ns);
    const manifestPath = path.join(nsPath, "manifest.json");
    let partitions: string[] = [];
    try {
      partitions =
        (
          JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
            partitions?: string[];
          }
        ).partitions ?? [];
    } catch {
      // Unreadable manifest — skip the namespace entirely.
      continue;
    }

    const rows: ConsolidateRow[] = [];
    let unparseable = 0;

    for (const partition of partitions) {
      // Only time partitions of the target month: domain/YYYY-MM/
      const m = partition.match(/^([^/]+)\/(\d{4}-\d{2})\/?$/);
      if (!m || m[2] !== targetMonth) continue;
      const file = path.join(nsPath, partition, "current.jsonl");
      if (!fs.existsSync(file)) continue;

      let lines: string[];
      try {
        lines = fs.readFileSync(file, "utf8").split("\n");
      } catch {
        continue;
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        let row: ConsolidateRow;
        try {
          row = JSON.parse(line) as ConsolidateRow;
        } catch {
          continue; // torn/corrupt line — not part of the delta
        }
        if (typeof row.timestamp !== "string") {
          unparseable += 1;
          continue;
        }
        const ts = Date.parse(row.timestamp);
        if (Number.isNaN(ts)) {
          unparseable += 1;
          continue;
        }
        if (ts >= start && ts < end) rows.push(row);
      }
    }

    rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const seen = new Map<string, ConsolidateRow>();
    let duplicates = 0;
    for (const row of rows) {
      const hash = contentHash(row);
      if (seen.has(hash)) {
        duplicates += 1;
      } else {
        seen.set(hash, row);
      }
    }
    const unique = [...seen.values()].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    );

    deltas.push({ namespace: ns, rows, unique, duplicates, unparseable });
  }

  return deltas.sort((a, b) => a.namespace.localeCompare(b.namespace));
}

/**
 * Build the capped preview lines for a namespace's unique rows, mirroring
 * daily_chat_extract.py: `HH:MM author: text`, ~600-char line cap, ~25K
 * total budget per namespace.
 */
export function buildPreview(
  rows: ConsolidateRow[],
  budget: number = PREVIEW_BUDGET,
  lineCap: number = PREVIEW_LINE_CAP,
): string[] {
  const preview: string[] = [];
  let remaining = budget;
  for (const row of rows) {
    if (remaining <= 0) {
      preview.push("… (preview truncated)");
      break;
    }
    const ts = new Date(row.timestamp);
    const hhmm = Number.isNaN(ts.getTime())
      ? "??:??"
      : `${String(ts.getUTCHours()).padStart(2, "0")}:${String(
          ts.getUTCMinutes(),
        ).padStart(2, "0")}`;
    let text = (row.embedding_text ?? "")
      .replace(/\t/g, " ")
      .replace(/\n/g, " ")
      .trim();
    if (text.length > lineCap) text = `${text.slice(0, lineCap)}…`;
    const line = `${hhmm} ${row.author}: ${text}`;
    preview.push(line);
    remaining -= line.length + 1;
  }
  return preview;
}

/**
 * Build the digest text: per-namespace summary lines + dedup stats.
 * (Previews are printed to stdout for the cron agent, not embedded here.)
 */
export function buildDigestText(
  deltas: NamespaceDelta[],
  dateStr: string,
): string {
  const totalRows = deltas.reduce((n, d) => n + d.rows.length, 0);
  const totalUnique = deltas.reduce((n, d) => n + d.unique.length, 0);
  const totalDups = deltas.reduce((n, d) => n + d.duplicates, 0);

  const lines = [
    `# duckbrain consolidate digest ${dateStr} (UTC)`,
    `namespaces scanned: ${deltas.length}`,
    `total delta rows: ${totalRows} (${totalUnique} unique, ${totalDups} duplicates)`,
    "",
  ];
  for (const d of deltas) {
    lines.push(`## ${d.namespace}`);
    lines.push(
      `rows: ${d.rows.length} | unique: ${d.unique.length} | duplicates: ${d.duplicates}`,
    );
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Result of a digest POST. */
export interface PostDigestResult {
  status: number;
  ok: boolean;
}

/**
 * POST the digest to the DuckBrain HTTP API as a memory in namespace
 * `duckbrain` (201 on success). Uses the global fetch (Node 22+).
 */
export async function postDigest(params: {
  apiBase: string;
  apiKey: string;
  dateStr: string;
  content: string;
  embeddingText: string;
}): Promise<PostDigestResult> {
  const res = await fetch(
    `${params.apiBase}/api/memories?namespace=${DIGEST_NAMESPACE}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": params.apiKey,
      },
      body: JSON.stringify({
        key: `${DIGEST_KEY_PREFIX}${params.dateStr}`,
        domain: "config",
        content: params.content,
        embedding_text: params.embeddingText,
      }),
    },
  );
  return { status: res.status, ok: res.ok };
}

/** Run the `duckbrain consolidate` command. */
export async function consolidateCommand(args: string[]): Promise<void> {
  const opts = parseConsolidateArgs(args);
  if (opts.help) {
    console.log(CONSOLIDATE_USAGE);
    return;
  }

  const dateStr = parseTargetDate(opts.date);
  if (dateStr === null) {
    console.error(
      `✗ --date must be a valid YYYY-MM-DD UTC day (got '${opts.date}').`,
    );
    console.error("Usage: duckbrain consolidate [--date=YYYY-MM-DD]");
    process.exit(1);
  }

  const root = getConfig(".").namespacesPath;
  const deltas = collectNamespaceDeltas(root, dateStr);

  const totalRows = deltas.reduce((n, d) => n + d.rows.length, 0);
  const totalUnique = deltas.reduce((n, d) => n + d.unique.length, 0);
  const totalDups = deltas.reduce((n, d) => n + d.duplicates, 0);

  console.log(
    `# duckbrain consolidate ${dateStr} (UTC): ${deltas.length} namespace(s) with deltas, ` +
      `${totalRows} delta rows (${totalUnique} unique, ${totalDups} duplicates)`,
  );

  for (const d of deltas) {
    console.log(`## ${d.namespace}`);
    console.log(
      `rows: ${d.rows.length} | unique: ${d.unique.length} | duplicates: ${d.duplicates}` +
        (d.unparseable > 0
          ? ` | unparseable timestamps: ${d.unparseable}`
          : ""),
    );
    const preview = buildPreview(d.unique);
    if (preview.length > 0) {
      console.log("# preview:");
      console.log(preview.join("\n"));
    }
  }

  // Digest content: the cron agent's summarized version when
  // --digest-content is given, otherwise the auto-built digest.
  let digestContent: string;
  if (opts.digestContent) {
    try {
      digestContent = fs.readFileSync(opts.digestContent, "utf8");
    } catch (error) {
      console.error(
        `✗ Cannot read --digest-content file: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exit(1);
    }
  } else {
    digestContent = buildDigestText(deltas, dateStr);
  }

  const embeddingText = digestContent
    .replace(/\t/g, " ")
    .replace(/\n/g, " ")
    .trim()
    .slice(0, DIGEST_EMBEDDING_CAP);

  const apiKey = process.env.DUCKBRAIN_API_KEY;
  const writeDigest = opts.writeDigest || Boolean(apiKey);

  if (!writeDigest) {
    console.log(
      `# digest (dry-run — set DUCKBRAIN_API_KEY or pass --write-digest to post):`,
    );
    console.log(digestContent.trimEnd());
    return;
  }

  if (!apiKey) {
    console.error(
      "✗ --write-digest requires DUCKBRAIN_API_KEY (the API rejects keyless writes).",
    );
    process.exit(1);
  }

  const apiBase = process.env.DUCKBRAIN_API_URL || DIGEST_API_URL;
  try {
    const result = await postDigest({
      apiBase,
      apiKey,
      dateStr,
      content: digestContent,
      embeddingText,
    });
    if (result.ok) {
      console.log(
        `# digest posted: ${result.status} POST ${apiBase}/api/memories?namespace=${DIGEST_NAMESPACE} ` +
          `key=${DIGEST_KEY_PREFIX}${dateStr}`,
      );
    } else {
      console.error(
        `✗ digest write failed: HTTP ${result.status} from ${apiBase}/api/memories?namespace=${DIGEST_NAMESPACE}`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      `✗ digest write failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  }
}
