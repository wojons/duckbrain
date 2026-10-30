/**
 * `duckbrain distill-sessions` — DF-2026-18 nightly session distiller.
 *
 * Turns Hermes agent chat sessions (state.db) into durable, bounded,
 * hash-keyed DuckBrain records. The ledger previously only learned what
 * per-project sync crons chose to write, so decisions made in conversation
 * stayed trapped in state.db. This pass closes that hole: for each session
 * that ENDED inside the window (default: last 24h) it extracts short
 * statements — decisions, verified findings, open items — and writes them
 * under /session/<YYYY-MM-DD>/<session-id>/<hash16> via the repo's own
 * in-process write path (rememberTool).
 *
 * Guarantees (board row DF-2026-18):
 *  - Bounded: at most MAX_RECORDS_PER_SESSION records per session, each
 *    statement capped at STATEMENT_CAP chars; at most
 *    MAX_MESSAGES_PER_SESSION messages scanned per session.
 *  - Hash-keyed + idempotent: the key suffix is sha256(messageHash,
 *    recordType, statement) — a rerun over unchanged input produces the
 *    same keys, which are skipped (skip-if-exists), so it writes ZERO new
 *    records.
 *  - No transcripts/prompts/secrets: only short extracted statements are
 *    stored, each run through redactSecrets() (tokens, API keys, bearer
 *    strings, passwords, JWTs, AWS keys, long hex blobs). System prompts
 *    and tool payloads are never read.
 *  - Cron/system sessions skipped: state.db sessions.source labels
 *    'cron' (scheduler/cron jobs), 'kanban' (kanban workers) and 'tool'
 *    (tool-originated system sessions) are system/automation surfaces and
 *    are never distilled.
 *  - Corrupt transcripts refused: a session whose messages fail to read
 *    (query error, non-text content BLOB, non-finite timestamp) is LOUDLY
 *    reported and skipped whole — no partial garbage write.
 *  - --dry-run lists everything that WOULD be written and writes nothing.
 *
 * Nightly invocation (cron — runs against the live state.db read-only and
 * writes only to the `sessions` namespace):
 *
 *   17 3 * * * node $HOME/duckbrain/bin/duckbrain.js distill-sessions >> $HOME/.hermes/logs/session-distiller.log 2>&1
 *
 * See docs/guide/session-distillation.md.
 */

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { DatabaseSync } from "node:sqlite";
import { rememberTool } from "../mcp/tools/remember";
import { drainAsyncCommits } from "../git/autocommit";
import { resolveNamespacesPath } from "../config/index";

/** Default state.db location (flag/env overridable). */
export const DEFAULT_STATE_DB = path.join(os.homedir(), ".hermes", "state.db");
/** Namespace the distilled records are written to. */
export const DEFAULT_NAMESPACE = "sessions";
/** Default lookback window in hours. */
export const DEFAULT_WINDOW_HOURS = 24;
/** Hard caps keeping a run bounded. */
export const MAX_MESSAGES_PER_SESSION = 2000;
export const MAX_RECORDS_PER_SESSION = 20;
export const STATEMENT_CAP = 240;
/** Minimum trimmed line length considered for extraction (noise floor). */
export const MIN_STATEMENT_CHARS = 20;
/** Domain every distilled record is written under (record type lives in
 *  attributes.record_type) — mirrors the fleet sync-write convention. */
export const RECORD_DOMAIN = "raw_note" as const;

/**
 * state.db `sessions.source` labels treated as system/automation surfaces
 * and skipped: cron (scheduler/cron jobs), kanban (kanban workers), tool
 * (tool-originated system sessions). Everything else (cli, telegram, tui,
 * acp, api_server, subagent, unknown) is conversation-bearing and eligible.
 */
export const SYSTEM_SOURCES: ReadonlySet<string> = new Set([
  "cron",
  "kanban",
  "tool",
]);

/** Heuristic classifiers, first match wins per line (decision > finding > open item). */
const DECISION_RE =
  /\b(decided|decision|we(?:'ll| will) go with|going with|final (?:answer|call|decision)|chose|chosen|locked in|agreed(?: to| on)?)\b/i;
const FINDING_RE =
  /\b(verified|confirmed|proven|tests? pass(?:ed)?|all green|green across|measured|evidence shows|root cause)\b/i;
const OPEN_ITEM_RE =
  /\b(TODO|FIXME|follow[- ]?up|still open|unresolved|next step|remaining|blocked)\b/i;

export type RecordType = "decision" | "finding" | "open_item";

/** One row of the messages table as read by node:sqlite. */
export interface SessionMessageRow {
  id: number;
  role: string;
  content: string | null;
  timestamp: number;
}

/** One extracted record ready to write. */
export interface DistilledRecord {
  /** /session/<date>/<session-id>/<hash16> */
  key: string;
  recordType: RecordType;
  /** Short, redacted statement (never raw transcript). */
  statement: string;
  /** sha256 of "<role>\n<content>" of the source message. */
  messageHash: string;
  messageId: number;
  sessionId: string;
  sessionDate: string;
  sessionSource: string;
}

export interface SkippedCorruptSession {
  sessionId: string;
  reason: string;
}

export interface DistillerReport {
  stateDb: string;
  namespace: string;
  windowHours: number;
  cutoffIso: string;
  dryRun: boolean;
  sessionsConsidered: number;
  sessionsSkippedSystem: number;
  sessionsSkippedCorrupt: SkippedCorruptSession[];
  sessionsDistilled: number;
  recordsPlanned: DistilledRecord[];
  recordsWritten: number;
  recordsSkippedExisting: number;
}

export interface DistillerOptions {
  stateDbPath: string;
  windowHours: number;
  namespace: string;
  dryRun: boolean;
  /** Injectable write seam (defaults to the repo's rememberTool path). */
  writeRecord?: (record: DistilledRecord, namespace: string) => Promise<void>;
  /** Injectable existing-keys seam (defaults to scanning the namespace's
   *  raw_note partitions on disk). */
  existingKeys?: (namespacesRoot: string, namespace: string) => Set<string>;
  /** Clock seam for tests. */
  now?: number;
}

/**
 * Redact anything that looks like a token/key/password from an extracted
 * statement. Values are replaced with [REDACTED]; the surrounding sentence
 * survives so the record stays meaningful.
 */
export function redactSecrets(text: string): string {
  let out = text;
  // key=value / key: value forms for the classic secret names. The
  // separator MUST be ':' or '=' — a bare whitespace separator would
  // redact ordinary prose ("nothing secret in this sentence").
  out = out.replace(
    /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|password|passwd|secret|client[_-]?secret|private[_-]?key|authorization)\b(\s*[:=]\s*)("?)[^\s"']+/gi,
    "$1$2[REDACTED]",
  );
  // Bearer tokens
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  // OpenAI-style keys
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
  // AWS access key ids
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]");
  // Slack tokens
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]+\b/g, "[REDACTED]");
  // JWTs
  out = out.replace(
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    "[REDACTED]",
  );
  // Long bare hex blobs (64+ = sha256-class material)
  out = out.replace(/\b[0-9a-f]{64,}\b/gi, "[REDACTED]");
  return out;
}

/** Classify one extracted line, or return null when it carries no signal. */
export function classifyStatement(line: string): RecordType | null {
  if (DECISION_RE.test(line)) return "decision";
  if (FINDING_RE.test(line)) return "finding";
  if (OPEN_ITEM_RE.test(line)) return "open_item";
  return null;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Key-safe session id fragment (state.db ids are already safe; belt+braces). */
function sanitizeKeyFragment(fragment: string): string {
  return fragment.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Extract bounded records from one session's messages. Pure function of the
 * message rows — reruns over unchanged input produce byte-identical keys.
 */
export function extractRecordsFromMessages(params: {
  sessionId: string;
  sessionDate: string;
  sessionSource: string;
  messages: SessionMessageRow[];
  maxRecords?: number;
}): DistilledRecord[] {
  const { sessionId, sessionDate, sessionSource, messages } = params;
  const maxRecords = params.maxRecords ?? MAX_RECORDS_PER_SESSION;
  const records: DistilledRecord[] = [];
  const safeSid = sanitizeKeyFragment(sessionId);

  for (const msg of messages) {
    if (records.length >= maxRecords) break;
    if (msg.content === null) continue;
    for (const rawLine of msg.content.split("\n")) {
      if (records.length >= maxRecords) break;
      const line = rawLine.trim();
      if (line.length < MIN_STATEMENT_CHARS) continue;
      const recordType = classifyStatement(line);
      if (recordType === null) continue;
      let statement = redactSecrets(line);
      if (statement.length > STATEMENT_CAP) {
        statement = `${statement.slice(0, STATEMENT_CAP - 1)}…`;
      }
      const messageHash = sha256(`${msg.role}\n${msg.content}`);
      const keySuffix = sha256(
        `${messageHash}:${recordType}:${statement}`,
      ).slice(0, 16);
      records.push({
        key: `/session/${sessionDate}/${safeSid}/${keySuffix}`,
        recordType,
        statement,
        messageHash,
        messageId: msg.id,
        sessionId,
        sessionDate,
        sessionSource,
      });
    }
  }
  return records;
}

/** UTC YYYY-MM-DD for a unix-seconds timestamp. */
export function sessionDateOf(endedAtUnixSeconds: number): string {
  return new Date(endedAtUnixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Collect every /session/… key already stored in the namespace by scanning
 * the raw_note partitions' JSONL chunks on disk (offline, no DuckDB).
 */
export function collectExistingSessionKeys(
  namespacesRoot: string,
  namespace: string,
): Set<string> {
  const keys = new Set<string>();
  const domainRoot = path.join(namespacesRoot, namespace, RECORD_DOMAIN);
  if (!fs.existsSync(domainRoot)) return keys;

  const stack: string[] = [domainRoot];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        let lines: string[];
        try {
          lines = fs.readFileSync(full, "utf8").split("\n");
        } catch {
          continue; // unreadable chunk — dedupe falls back to writer-side safety
        }
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line) as { key?: unknown };
            if (
              typeof row.key === "string" &&
              row.key.startsWith("/session/")
            ) {
              keys.add(row.key);
            }
          } catch {
            continue; // torn line — ignore
          }
        }
      }
    }
  }
  return keys;
}

/**
 * Validate one session's message rows. Returns the rows when readable, or a
 * refusal reason string when the transcript is unreadable/corrupt. Corrupt =
 * a user/assistant message whose content is present but not text (BLOB), or
 * whose timestamp is not a finite number.
 */
function readSessionMessages(
  db: DatabaseSync,
  sessionId: string,
): { rows: SessionMessageRow[] } | { corrupt: string } {
  let rawRows: unknown[];
  try {
    rawRows = db
      .prepare(
        `SELECT id, role, content, timestamp FROM messages
         WHERE session_id = ? AND role IN ('user', 'assistant') AND active = 1
         ORDER BY timestamp ASC, id ASC
         LIMIT ?`,
      )
      .all(sessionId, MAX_MESSAGES_PER_SESSION);
  } catch (error) {
    return {
      corrupt: `messages query failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const rows: SessionMessageRow[] = [];
  for (const raw of rawRows) {
    const row = raw as Record<string, unknown>;
    const id = row.id;
    const role = row.role;
    const content = row.content;
    const timestamp = row.timestamp;
    if (typeof id !== "number" || typeof role !== "string") {
      return { corrupt: "message row missing numeric id or string role" };
    }
    if (content !== null && typeof content !== "string") {
      return {
        corrupt: `message ${id} content is ${Array.isArray(content) ? "array" : typeof content} (non-text/BLOB) — transcript unreadable`,
      };
    }
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
      return { corrupt: `message ${id} timestamp is not a finite number` };
    }
    rows.push({ id, role, content, timestamp });
  }
  return { rows };
}

/** Default writer: the repo's own rememberTool in-process write path. */
async function defaultWriteRecord(
  record: DistilledRecord,
  namespace: string,
): Promise<void> {
  const result = await rememberTool({
    key: record.key,
    domain: RECORD_DOMAIN,
    attributes: {
      session_id: record.sessionId,
      session_date: record.sessionDate,
      session_source: record.sessionSource,
      record_type: record.recordType,
      message_hash: record.messageHash,
      message_id: record.messageId,
      distilled_by: "session-distiller",
    },
    embedding_text: record.statement,
    namespace,
  });
  if (!result.success) {
    throw new Error(
      `rememberTool failed for ${record.key}: ${result.error ?? "unknown"}`,
    );
  }
}

/**
 * Run the distillation pass. Reads state.db READ-ONLY; writes go through
 * rememberTool into the target namespace unless dryRun is set.
 */
export async function distillSessions(
  opts: DistillerOptions,
): Promise<DistillerReport> {
  const now = opts.now ?? Date.now();
  const cutoffSeconds = (now - opts.windowHours * 3_600_000) / 1000;
  const writeRecord = opts.writeRecord ?? defaultWriteRecord;
  const existingKeysFn = opts.existingKeys ?? collectExistingSessionKeys;

  const report: DistillerReport = {
    stateDb: opts.stateDbPath,
    namespace: opts.namespace,
    windowHours: opts.windowHours,
    cutoffIso: new Date(cutoffSeconds * 1000).toISOString(),
    dryRun: opts.dryRun,
    sessionsConsidered: 0,
    sessionsSkippedSystem: 0,
    sessionsSkippedCorrupt: [],
    sessionsDistilled: 0,
    recordsPlanned: [],
    recordsWritten: 0,
    recordsSkippedExisting: 0,
  };

  const db = new DatabaseSync(opts.stateDbPath, { readOnly: true });
  try {
    const sessionRows = db
      .prepare(
        `SELECT id, source, ended_at FROM sessions
         WHERE ended_at IS NOT NULL AND ended_at >= ?
         ORDER BY ended_at ASC`,
      )
      .all(cutoffSeconds) as unknown as Array<Record<string, unknown>>;

    // Load existing /session/ keys once per run (skip-if-exists dedupe).
    const seenKeys = opts.dryRun
      ? new Set<string>()
      : existingKeysFn(resolveNamespacesPath(), opts.namespace);

    for (const raw of sessionRows) {
      const id = raw.id;
      const source = raw.source;
      const endedAt = raw.ended_at;
      if (
        typeof id !== "string" ||
        typeof source !== "string" ||
        typeof endedAt !== "number"
      ) {
        // A session row we cannot even identify — loud, skipped.
        report.sessionsSkippedCorrupt.push({
          sessionId: typeof id === "string" ? id : "<unreadable row>",
          reason: "session row missing id/source/ended_at",
        });
        continue;
      }
      report.sessionsConsidered += 1;

      if (SYSTEM_SOURCES.has(source)) {
        report.sessionsSkippedSystem += 1;
        continue;
      }

      const read = readSessionMessages(db, id);
      if ("corrupt" in read) {
        report.sessionsSkippedCorrupt.push({
          sessionId: id,
          reason: read.corrupt,
        });
        console.error(
          `✗ distill-sessions: REFUSING corrupt session ${id}: ${read.corrupt}`,
        );
        continue;
      }

      const records = extractRecordsFromMessages({
        sessionId: id,
        sessionDate: sessionDateOf(endedAt),
        sessionSource: source,
        messages: read.rows,
      });
      if (records.length === 0) continue;
      report.sessionsDistilled += 1;

      for (const record of records) {
        if (seenKeys.has(record.key)) {
          report.recordsSkippedExisting += 1;
          continue;
        }
        report.recordsPlanned.push(record);
        if (!opts.dryRun) {
          await writeRecord(record, opts.namespace);
          seenKeys.add(record.key);
          report.recordsWritten += 1;
        }
      }
    }
  } finally {
    db.close();
  }

  return report;
}

export interface DistillerCliOptions {
  stateDbPath: string;
  windowHours: number;
  namespace: string;
  dryRun: boolean;
  help: boolean;
}

const DISTILLER_USAGE = `duckbrain distill-sessions — nightly state.db session distiller (DF-2026-18).

Usage:
  duckbrain distill-sessions [--state-db=PATH] [--window-hours=N]
                             [--namespace=NAME] [--dry-run]

Extracts bounded, hash-keyed records (decisions, verified findings, open
items) from chat sessions that ended inside the window and writes them under
/session/<date>/<session-id>/<hash> in the target namespace. Cron/system
sessions (sources: cron, kanban, tool) are skipped; corrupt transcripts are
refused loudly; reruns over unchanged input write zero new records
(skip-if-exists by message-hash-derived key).

Options:
  --state-db=PATH      Hermes state.db (default: ${DEFAULT_STATE_DB};
                       env HERMES_STATE_DB)
  --window-hours=N     Lookback window in hours (default: ${DEFAULT_WINDOW_HOURS})
  --namespace=NAME     Target namespace (default: ${DEFAULT_NAMESPACE})
  --dry-run            List what WOULD be written; write nothing
  --help, -h           Show this help

Nightly cron:
  17 3 * * * node $HOME/duckbrain/bin/duckbrain.js distill-sessions >> $HOME/.hermes/logs/session-distiller.log 2>&1`;

/** Normalize the space-separated `--flag value` forms to `--flag=value`. */
function normalizeDistillerFlagArgs(args: string[]): string[] {
  const out = args.slice();
  const valueFlags = new Set(["--state-db", "--window-hours", "--namespace"]);
  for (let i = 0; i < out.length - 1; i++) {
    if (valueFlags.has(out[i])) {
      out.splice(i, 2, `${out[i]}=${out[i + 1]}`);
    }
  }
  return out;
}

/** Parse CLI args into options. Unknown flags are rejected loudly. */
export function parseDistillerArgs(args: string[]): DistillerCliOptions {
  const out: DistillerCliOptions = {
    stateDbPath: process.env.HERMES_STATE_DB || DEFAULT_STATE_DB,
    windowHours: DEFAULT_WINDOW_HOURS,
    namespace: DEFAULT_NAMESPACE,
    dryRun: false,
    help: false,
  };
  for (const arg of normalizeDistillerFlagArgs(args)) {
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg.startsWith("--state-db=")) {
      out.stateDbPath = arg.slice("--state-db=".length);
    } else if (arg.startsWith("--window-hours=")) {
      const n = Number(arg.slice("--window-hours=".length));
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(
          `--window-hours must be a positive number (got '${arg}')`,
        );
      }
      out.windowHours = n;
    } else if (arg.startsWith("--namespace=")) {
      out.namespace = arg.slice("--namespace=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag '${arg}' for 'distill-sessions'`);
    }
  }
  return out;
}

/** Run the `duckbrain distill-sessions` command. */
export async function distillSessionsCommand(args: string[]): Promise<void> {
  let opts: DistillerCliOptions;
  try {
    opts = parseDistillerArgs(args);
  } catch (error) {
    console.error(
      `✗ ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(
      "Usage: duckbrain distill-sessions [--state-db=PATH] [--window-hours=N] [--namespace=NAME] [--dry-run]",
    );
    process.exit(1);
  }
  if (opts.help) {
    console.log(DISTILLER_USAGE);
    return;
  }

  if (!fs.existsSync(opts.stateDbPath)) {
    console.error(`✗ state.db not found at ${opts.stateDbPath}`);
    process.exit(1);
  }

  let report: DistillerReport;
  try {
    report = await distillSessions({
      stateDbPath: opts.stateDbPath,
      windowHours: opts.windowHours,
      namespace: opts.namespace,
      dryRun: opts.dryRun,
    });
  } catch (error) {
    console.error(
      `✗ distill-sessions failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }

  // Let debounced namespace git commits settle before the cron process exits.
  if (!opts.dryRun && report.recordsWritten > 0) {
    await drainAsyncCommits();
  }

  const planned = report.recordsPlanned.length;
  console.log(
    `# duckbrain distill-sessions (${report.dryRun ? "DRY-RUN" : "WRITE"}): ` +
      `window=${report.windowHours}h cutoff=${report.cutoffIso} state-db=${report.stateDb}`,
  );
  console.log(
    `sessions: ${report.sessionsConsidered} considered, ` +
      `${report.sessionsSkippedSystem} system-skipped, ` +
      `${report.sessionsSkippedCorrupt.length} corrupt-refused, ` +
      `${report.sessionsDistilled} distilled`,
  );
  for (const skipped of report.sessionsSkippedCorrupt) {
    console.log(`  CORRUPT ${skipped.sessionId}: ${skipped.reason}`);
  }
  if (report.dryRun) {
    console.log(
      `records: ${planned} would be written (0 written — dry-run) into namespace '${report.namespace}'`,
    );
    for (const record of report.recordsPlanned) {
      console.log(`  WOULD-WRITE ${record.key} [${record.recordType}]`);
    }
  } else {
    console.log(
      `records: ${report.recordsWritten} written, ` +
        `${report.recordsSkippedExisting} already existed (skipped), ` +
        `namespace '${report.namespace}'`,
    );
  }
}
