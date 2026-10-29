/**
 * DB-GAP-66 — session activity receipt store (session_activity_receipt/v1).
 *
 * A bounded, queryable record of what was OBSERVED inside a session interval:
 * skill exposure vs activation, tool/model calls and errors, token counts,
 * context peak, wall clock. Without it, "the skill was not used" cannot be
 * distinguished from "nobody saw whether the skill was offered" (SKILL-001).
 *
 * Storage: its own hidden namespace `.duckbrain-receipts/` under the
 * namespaces root (hidden dirs are skipped by the memory census in
 * src/namespaces/census.ts — these rows are NOT memories and never enter the
 * memory JSONL partitions, embeddings, or git autocommit). Append-only JSONL
 * with sealed monotonic segments, the exact pattern of the read ledger
 * (src/http/readLedger.ts): bounded active file, rotation into
 * `receipts.NNNN.jsonl` / `quarantine.NNNN.jsonl`, 0o600 mode, one serialized
 * append tail so concurrent ingests can never interleave or double-rotate.
 *
 * Contract arms (board row DB-GAP-66, verbatim):
 *  1. Closed receipt shape with bounded arrays and opaque references only.
 *     Prompts, transcripts, tool arguments, tool results, filesystem paths
 *     and unsafe key names are rejected BY KEY NAME (FORBIDDEN_KEY_NAMES +
 *     SAFE_KEY_RE scan over the raw payload) and BY SHAPE (strict zod schema,
 *     opaque-ref charset, string length caps, per-receipt byte cap, array
 *     caps).
 *  2. Every counter carries availability in observed/heuristic/unavailable
 *     and measurement in exact/floor. A counter nobody observed is omitted or
 *     unavailable with a null value — never zero, never inferred.
 *  3. Idempotent ingestion on receipt_id: same id + identical observation
 *     records once (status "duplicate", no second row); same id + a different
 *     observation is QUARANTINED and never overwrites the original.
 *  4. Every receipt carries its claim boundary in-band: it is NOT execution,
 *     verification, review, or merge evidence (four required literal-true
 *     flags; a receipt asserting otherwise fails shape validation).
 *  5. Live queries: exposure vs activation for skill X
 *     (querySkillExposure) and the observed counters with their coverage for
 *     session Y (querySessionCounters).
 *
 * The quarantine ledger NEVER stores the offending payload — only the
 * receipt_id (when safely extractable), the reason, a short detail, and the
 * sha256 of the raw body. Persisting rejected content would defeat the
 * rejection.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { z } from "zod";

/** Storage directory — hidden, so the memory namespace census skips it. */
export const RECEIPTS_DIR = ".duckbrain-receipts";
/** Active receipt ledger file. */
export const RECEIPTS_FILE = "receipts.jsonl";
/** Active quarantine ledger file. */
export const QUARANTINE_FILE = "quarantine.jsonl";
/** Byte bound per active segment — same 10 MB budget as the read ledger. */
export const RECEIPTS_MAX_BYTES = 10 * 1024 * 1024;
/** Byte bound for a single receipt payload (defense against content smuggling). */
export const MAX_RECEIPT_BYTES = 64 * 1024;
/** Bound on the skills array per receipt. */
export const MAX_SKILLS_PER_RECEIPT = 256;

/**
 * Opaque reference charset: receipt ids, session refs, skill refs. Deliberately
 * excludes `/`, `\`, whitespace, quotes and scheme separators so a ref can
 * never BE a filesystem path, a URL, or a smuggled text fragment.
 */
export const OPAQUE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

const OpaqueRef = z
  .string()
  .regex(
    OPAQUE_REF_RE,
    "must be an opaque reference (1-256 chars: letters, digits, _ . : -)",
  );

/** The eight counter slots a receipt may report. All optional (arm 2). */
export const COUNTER_NAMES = [
  "tool_calls",
  "tool_errors",
  "model_calls",
  "model_errors",
  "tokens_in",
  "tokens_out",
  "context_peak_tokens",
  "wall_clock_ms",
] as const;

export type CounterName = (typeof COUNTER_NAMES)[number];

/**
 * A counter is a discriminated union on availability:
 *  - observed:    a real measurement, exact or a floor.
 *  - heuristic:   derived, always a floor (a heuristic can never be exact).
 *  - unavailable: nobody observed it — value MUST be null, never zero.
 * An absent counter key means the same as unavailable (omitted form).
 */
export const CounterSchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("observed"),
      measurement: z.enum(["exact", "floor"]),
      value: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      availability: z.literal("heuristic"),
      measurement: z.literal("floor"),
      value: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      availability: z.literal("unavailable"),
      measurement: z.enum(["exact", "floor"]),
      value: z.null(),
    })
    .strict(),
]);

export type Counter = z.infer<typeof CounterSchema>;

export const CountersSchema = z
  .object({
    tool_calls: CounterSchema.optional(),
    tool_errors: CounterSchema.optional(),
    model_calls: CounterSchema.optional(),
    model_errors: CounterSchema.optional(),
    tokens_in: CounterSchema.optional(),
    tokens_out: CounterSchema.optional(),
    context_peak_tokens: CounterSchema.optional(),
    wall_clock_ms: CounterSchema.optional(),
  })
  .strict();

export type Counters = z.infer<typeof CountersSchema>;

/**
 * Skill observation: exposure (was it offered into the session context) vs
 * activation (was it actually loaded/used). "unknown" is the explicit
 * nobody-saw state — the distinction the row exists to preserve.
 */
export const SkillObservationSchema = z
  .object({
    skill_ref: OpaqueRef,
    exposure: z.enum(["exposed", "not_exposed", "unknown"]),
    activation: z.enum(["activated", "not_activated", "unknown"]),
  })
  .strict();

export type SkillObservation = z.infer<typeof SkillObservationSchema>;

/**
 * Claim boundary (arm 4): the receipt asserts in-band that it is none of the
 * evidence classes the fleet grades on. All four flags are required literals;
 * a receipt claiming to be execution/verification/review/merge evidence fails
 * validation and is rejected.
 */
export const ClaimBoundarySchema = z
  .object({
    not_execution_evidence: z.literal(true),
    not_verification_evidence: z.literal(true),
    not_review_evidence: z.literal(true),
    not_merge_evidence: z.literal(true),
  })
  .strict();

export type ClaimBoundary = z.infer<typeof ClaimBoundarySchema>;

export const RECEIPT_KIND = "session_activity_receipt/v1" as const;

export const SessionActivityReceiptSchema = z
  .object({
    receipt_kind: z.literal(RECEIPT_KIND),
    receipt_id: OpaqueRef,
    session_ref: OpaqueRef,
    interval: z
      .object({
        started_at: z.string().datetime({ offset: true }),
        ended_at: z.string().datetime({ offset: true }),
      })
      .strict()
      .refine(
        (interval) =>
          Date.parse(interval.ended_at) >= Date.parse(interval.started_at),
        { message: "interval.ended_at must not precede interval.started_at" },
      ),
    skills: z.array(SkillObservationSchema).max(MAX_SKILLS_PER_RECEIPT),
    counters: CountersSchema,
    claim_boundary: ClaimBoundarySchema,
  })
  .strict();

export type SessionActivityReceipt = z.infer<typeof SessionActivityReceiptSchema>;

/** Row persisted in receipts.jsonl — receipt plus storage metadata. */
export const StoredReceiptRowSchema = z
  .object({
    stored_at: z.string().datetime({ offset: true }),
    observation_hash: z.string().regex(/^[0-9a-f]{64}$/),
    receipt: SessionActivityReceiptSchema,
  })
  .strict();

export type StoredReceiptRow = z.infer<typeof StoredReceiptRowSchema>;

export const QuarantineReasonEnum = z.enum([
  "conflicting_observation",
  "oversized",
  "unsafe_key",
  "forbidden_key",
  "forbidden_value",
  "invalid_shape",
]);

export type QuarantineReason = z.infer<typeof QuarantineReasonEnum>;

/**
 * Quarantine row: the audit trail for rejected/conflicting ingests. Carries
 * NO payload — only identity, reason, a bounded human detail, and the sha256
 * of the raw body for correlation.
 */
export const QuarantineRowSchema = z
  .object({
    quarantined_at: z.string().datetime({ offset: true }),
    receipt_id: OpaqueRef.nullable(),
    reason: QuarantineReasonEnum,
    detail: z.string().max(256),
    payload_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type QuarantineRow = z.infer<typeof QuarantineRowSchema>;

/**
 * Key names that carry exactly the content classes the contract forbids:
 * prompts, transcripts, tool arguments, tool results, and filesystem paths
 * (plus the generic content carriers). Matched case-insensitively on the raw
 * payload BEFORE shape validation — rejection by key name, not just by shape.
 * None of these collide with the closed receipt key set (all snake_case
 * schema keys above).
 */
export const FORBIDDEN_KEY_NAMES: ReadonlySet<string> = new Set([
  "prompt",
  "prompts",
  "system_prompt",
  "transcript",
  "transcripts",
  "message",
  "messages",
  "content",
  "text",
  "body",
  "arguments",
  "args",
  "tool_arguments",
  "tool_args",
  "parameters",
  "params",
  "result",
  "results",
  "tool_results",
  "output",
  "outputs",
  "response",
  "response_body",
  "path",
  "paths",
  "file",
  "files",
  "filepath",
  "file_path",
  "filename",
  "cwd",
  "working_directory",
  "dir",
  "directory",
  "command",
  "commands",
  "cmd",
  "shell",
  "exec",
  "stdin",
  "stdout",
  "stderr",
  "env",
  "environment",
  "sql",
  "query",
  "queries",
]);

/**
 * Safe key shape: lower snake_case, bounded length. Anything else — capitals,
 * dots, slashes, spaces, leading underscores (`__proto__`), dunder tricks —
 * is an unsafe key name and rejected on sight.
 */
export const SAFE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * String values that cannot appear in an opaque-reference-only receipt:
 * absolute POSIX paths, home-relative paths, ./.., Windows drive paths, any
 * backslash separator, URL schemes, and multi-line text (transcript
 * smuggling). Timestamps and opaque refs never match these.
 */
const FORBIDDEN_VALUE_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /^\//, label: "absolute filesystem path" },
  { re: /^~[\\/]/, label: "home-relative filesystem path" },
  { re: /^\.\.?[\\/]/, label: "relative filesystem path" },
  { re: /^[A-Za-z]:[\\/]/, label: "Windows drive path" },
  { re: /\\/, label: "backslash path separator" },
  { re: /:\/\//, label: "URL with scheme (not an opaque reference)" },
  { re: /\r|\n/, label: "multi-line text content" },
];

export type PayloadRejection =
  | { ok: true; receipt: SessionActivityReceipt }
  | { ok: false; reason: QuarantineReason; detail: string };

/**
 * Recursively scan the RAW payload for unsafe key names, forbidden key names,
 * and forbidden value shapes — the by-key-name half of the contract, applied
 * before zod ever sees the object. Returns the first violation found (the
 * scan is a gate, not a linter).
 */
function scanPayloadKeysAndValues(
  node: unknown,
  location: string,
): { reason: QuarantineReason; detail: string } | null {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const hit = scanPayloadKeysAndValues(node[i], `${location}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (!SAFE_KEY_RE.test(key)) {
        return {
          reason: "unsafe_key",
          detail: `unsafe key name '${key.slice(0, 64)}' at ${location}`,
        };
      }
      if (FORBIDDEN_KEY_NAMES.has(key.toLowerCase())) {
        return {
          reason: "forbidden_key",
          detail: `forbidden key name '${key}' at ${location}`,
        };
      }
      const hit = scanPayloadKeysAndValues(value, `${location}.${key}`);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node === "string") {
    for (const { re, label } of FORBIDDEN_VALUE_PATTERNS) {
      if (re.test(node)) {
        return {
          reason: "forbidden_value",
          detail: `forbidden value shape (${label}) at ${location}`,
        };
      }
    }
  }
  return null;
}

/**
 * Validate a raw (already JSON-parsed) payload against the receipt contract:
 * by-key-name/by-value scan first, then the closed strict schema.
 */
export function validateReceiptPayload(payload: unknown): PayloadRejection {
  const scan = scanPayloadKeysAndValues(payload, "$");
  if (scan) return { ok: false, reason: scan.reason, detail: scan.detail };
  const parsed = SessionActivityReceiptSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "$";
    return {
      ok: false,
      reason: "invalid_shape",
      detail: `${where}: ${issue ? issue.message : "schema mismatch"}`.slice(
        0,
        256,
      ),
    };
  }
  return { ok: true, receipt: parsed.data };
}

/** Canonical JSON (recursively sorted keys) — the idempotency basis. */
export function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 of the canonical receipt — identical observation ⇔ identical hash. */
export function observationHash(receipt: SessionActivityReceipt): string {
  return crypto
    .createHash("sha256")
    .update(canonicalStringify(receipt), "utf-8")
    .digest("hex");
}

/** Sealed-segment names, the auditLedger numeric basis (see readLedger). */
export function receiptsSegmentName(value: number): string {
  return `receipts.${String(value).padStart(4, "0")}.jsonl`;
}
export function receiptsSegmentNumber(name: string): number | null {
  const match = /^receipts\.(\d{4,})\.jsonl$/.exec(name);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
export function quarantineSegmentName(value: number): string {
  return `quarantine.${String(value).padStart(4, "0")}.jsonl`;
}
export function quarantineSegmentNumber(name: string): number | null {
  const match = /^quarantine\.(\d{4,})\.jsonl$/.exec(name);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export type IngestResult =
  | { status: "recorded"; receipt_id: string; observation_hash: string }
  | { status: "duplicate"; receipt_id: string; observation_hash: string }
  | {
      status: "quarantined";
      receipt_id: string;
      reason: "conflicting_observation";
    }
  | { status: "rejected"; reason: QuarantineReason; detail: string };

export interface SessionReceiptStore {
  /** Validate + idempotently ingest one raw payload. Never throws. */
  ingest(payload: unknown): Promise<IngestResult>;
}

export interface SessionReceiptStoreOptions {
  /** Byte bound for each active segment (default RECEIPTS_MAX_BYTES). */
  maxBytes?: number;
  /** Byte bound for a single receipt payload (default MAX_RECEIPT_BYTES). */
  maxReceiptBytes?: number;
  /** Failure sink (default console.error). */
  log?: (message: string) => void;
  /** Clock seam for tests. */
  now?: () => Date;
}

interface StoreState {
  loaded: boolean;
  /** receipt_id → observation_hash for every durably stored receipt. */
  index: Map<string, string>;
}

/**
 * Module-level per-root state, mirroring the read-ledger tail pattern: one
 * serialized promise chain for ALL appends (receipts and quarantine alike),
 * so concurrent ingests can never interleave a rotation, and the idempotency
 * index is loaded lazily from disk exactly once per root per process.
 */
const storeStates = new Map<string, StoreState>();
let ingestTail: Promise<void> = Promise.resolve();

function stateFor(root: string): StoreState {
  let state = storeStates.get(root);
  if (!state) {
    state = { loaded: false, index: new Map() };
    storeStates.set(root, state);
  }
  return state;
}

/** Test seam: drop the cached idempotency index (simulates a process restart). */
export function resetSessionReceiptStoresForTests(): void {
  storeStates.clear();
}

/** Await every pending ingest (test seam, mirrors flushReadLedgerForTests). */
export async function flushSessionReceiptsForTests(): Promise<void> {
  await ingestTail;
}

/** Append one line with rotation — the read-ledger pattern, parameterized. */
async function appendLedgerLine(
  dir: string,
  activeFile: string,
  segmentNumber: (name: string) => number | null,
  segmentName: (value: number) => string,
  line: string,
  maxBytes: number,
): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, activeFile);
  const lineBytes = Buffer.byteLength(line, "utf-8");
  if (lineBytes > maxBytes) {
    throw new Error("ledger row exceeds the configured segment bound");
  }
  let size = 0;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (size + lineBytes > maxBytes) {
    const existing = await fs.promises.readdir(dir);
    const highest = existing.reduce(
      (max, name) => Math.max(max, segmentNumber(name) ?? 0),
      0,
    );
    await fs.promises.rename(file, path.join(dir, segmentName(highest + 1)));
  }
  await fs.promises.appendFile(file, line, { encoding: "utf-8", mode: 0o600 });
}

/** Load the idempotency index from disk (first ingest per root per process). */
function loadIndex(root: string, state: StoreState): void {
  if (state.loaded) return;
  const { rows } = readReceiptRows(root);
  for (const row of rows) {
    state.index.set(row.receipt.receipt_id, row.observation_hash);
  }
  state.loaded = true;
}

export function createSessionReceiptStore(
  namespacesPath: string,
  options: SessionReceiptStoreOptions = {},
): SessionReceiptStore {
  const root = path.resolve(namespacesPath);
  const dir = path.join(root, RECEIPTS_DIR);
  const maxBytes = options.maxBytes ?? RECEIPTS_MAX_BYTES;
  const maxReceiptBytes = options.maxReceiptBytes ?? MAX_RECEIPT_BYTES;
  const log = options.log ?? ((message: string) => console.error(message));
  const now = options.now ?? (() => new Date());

  const quarantine = async (
    receiptId: string | null,
    reason: QuarantineReason,
    detail: string,
    raw: unknown,
  ): Promise<void> => {
    const row: QuarantineRow = {
      quarantined_at: now().toISOString(),
      receipt_id: receiptId,
      reason,
      detail: detail.slice(0, 256),
      payload_sha256: crypto
        .createHash("sha256")
        .update(canonicalStringify(raw), "utf-8")
        .digest("hex"),
    };
    await appendLedgerLine(
      dir,
      QUARANTINE_FILE,
      quarantineSegmentNumber,
      quarantineSegmentName,
      JSON.stringify(row) + "\n",
      maxBytes,
    );
  };

  return {
    ingest(payload: unknown): Promise<IngestResult> {
      let result: IngestResult | null = null;
      const run = async (): Promise<void> => {
        // Byte cap first — measured on the caller's payload, before any work.
        const approxBytes = Buffer.byteLength(
          canonicalStringify(payload),
          "utf-8",
        );
        if (approxBytes > maxReceiptBytes) {
          await quarantine(null, "oversized", `payload ${approxBytes}B exceeds ${maxReceiptBytes}B`, payload);
          result = {
            status: "rejected",
            reason: "oversized",
            detail: `payload ${approxBytes} bytes exceeds the ${maxReceiptBytes} byte receipt bound`,
          };
          return;
        }

        const validated = validateReceiptPayload(payload);
        if (!validated.ok) {
          const rawId =
            payload !== null &&
            typeof payload === "object" &&
            typeof (payload as Record<string, unknown>).receipt_id === "string" &&
            OPAQUE_REF_RE.test(
              (payload as Record<string, unknown>).receipt_id as string,
            )
              ? ((payload as Record<string, unknown>).receipt_id as string)
              : null;
          await quarantine(rawId, validated.reason, validated.detail, payload);
          result = {
            status: "rejected",
            reason: validated.reason,
            detail: validated.detail,
          };
          return;
        }

        const receipt = validated.receipt;
        const hash = observationHash(receipt);
        const state = stateFor(root);
        loadIndex(root, state);

        const existing = state.index.get(receipt.receipt_id);
        if (existing !== undefined) {
          if (existing === hash) {
            // Arm 3a: same id + identical observation — accepted once, no dup.
            result = {
              status: "duplicate",
              receipt_id: receipt.receipt_id,
              observation_hash: hash,
            };
            return;
          }
          // Arm 3b: same id + different observation — quarantine, never
          // overwrite the original.
          await quarantine(
            receipt.receipt_id,
            "conflicting_observation",
            `receipt_id re-ingested with a different observation (stored ${existing.slice(0, 12)}, received ${hash.slice(0, 12)})`,
            payload,
          );
          result = { status: "quarantined", receipt_id: receipt.receipt_id, reason: "conflicting_observation" };
          return;
        }

        const row: StoredReceiptRow = {
          stored_at: now().toISOString(),
          observation_hash: hash,
          receipt,
        };
        await appendLedgerLine(
          dir,
          RECEIPTS_FILE,
          receiptsSegmentNumber,
          receiptsSegmentName,
          JSON.stringify(row) + "\n",
          maxBytes,
        );
        state.index.set(receipt.receipt_id, hash);
        result = {
          status: "recorded",
          receipt_id: receipt.receipt_id,
          observation_hash: hash,
        };
      };
      const chained = ingestTail.then(run);
      // Failures are logged and swallowed into a rejected result — an ingest
      // must never take down a response with an unhandled rejection.
      ingestTail = chained.catch((error) => {
        log(
          `[duckbrain] session receipt ingest failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return ingestTail.then(() => {
        if (result === null) {
          return {
            status: "rejected",
            reason: "invalid_shape",
            detail: "ingest failed; see server log",
          } as IngestResult;
        }
        return result;
      });
    },
  };
}

export interface ReceiptLedgerContents {
  /** Valid rows, chronological: sealed segments first, active file last. */
  rows: StoredReceiptRow[];
  /** Lines that were not parseable as a valid row — skipped, never fatal. */
  skippedMalformed: number;
  /** Files actually read, in traversal order. */
  filesRead: string[];
}

function readLedgerDir(
  namespacesPath: string,
  activeFile: string,
  segmentNumber: (name: string) => number | null,
): { lines: string[]; filesRead: string[] } {
  const dir = path.join(path.resolve(namespacesPath), RECEIPTS_DIR);
  const out = { lines: [] as string[], filesRead: [] as string[] };
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => name === activeFile || segmentNumber(name) !== null);
  } catch {
    return out;
  }
  names.sort((left, right) => {
    const l = segmentNumber(left);
    const r = segmentNumber(right);
    if (l !== null && r !== null) return l - r;
    if (l !== null) return -1; // sealed segments precede the active file
    return left === right ? 0 : 1;
  });
  for (const name of names) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, name), "utf-8");
    } catch {
      continue;
    }
    out.filesRead.push(name);
    for (const line of text.split("\n")) {
      if (line.trim() !== "") out.lines.push(line);
    }
  }
  return out;
}

/**
 * Read the whole receipt ledger. A malformed line is counted and skipped —
 * one torn line must never break a query about sessions.
 */
export function readReceiptRows(namespacesPath: string): ReceiptLedgerContents {
  const { lines, filesRead } = readLedgerDir(
    namespacesPath,
    RECEIPTS_FILE,
    receiptsSegmentNumber,
  );
  const contents: ReceiptLedgerContents = {
    rows: [],
    skippedMalformed: 0,
    filesRead,
  };
  for (const line of lines) {
    try {
      contents.rows.push(StoredReceiptRowSchema.parse(JSON.parse(line)));
    } catch {
      contents.skippedMalformed += 1;
    }
  }
  return contents;
}

export interface QuarantineLedgerContents {
  rows: QuarantineRow[];
  skippedMalformed: number;
  filesRead: string[];
}

/** Read the whole quarantine ledger (audit surface for rejected ingests). */
export function readQuarantineRows(
  namespacesPath: string,
): QuarantineLedgerContents {
  const { lines, filesRead } = readLedgerDir(
    namespacesPath,
    QUARANTINE_FILE,
    quarantineSegmentNumber,
  );
  const contents: QuarantineLedgerContents = {
    rows: [],
    skippedMalformed: 0,
    filesRead,
  };
  for (const line of lines) {
    try {
      contents.rows.push(QuarantineRowSchema.parse(JSON.parse(line)));
    } catch {
      contents.skippedMalformed += 1;
    }
  }
  return contents;
}

/**
 * Query 1 (arm 5): "for skill X, how often was it exposed vs activated."
 * Counts are over receipts that MENTION the skill; the unknown buckets keep
 * "nobody saw" distinct from "did not happen" (the SKILL-001 distinction).
 */
export interface SkillExposureReport {
  skill_ref: string;
  receipts_mentioning: number;
  sessions_observed: number;
  exposed: number;
  not_exposed: number;
  exposure_unknown: number;
  activated: number;
  not_activated: number;
  activation_unknown: number;
}

export function querySkillExposure(
  namespacesPath: string,
  skillRef: string,
): SkillExposureReport {
  const report: SkillExposureReport = {
    skill_ref: skillRef,
    receipts_mentioning: 0,
    sessions_observed: 0,
    exposed: 0,
    not_exposed: 0,
    exposure_unknown: 0,
    activated: 0,
    not_activated: 0,
    activation_unknown: 0,
  };
  const sessions = new Set<string>();
  for (const row of readReceiptRows(namespacesPath).rows) {
    const skill = row.receipt.skills.find((s) => s.skill_ref === skillRef);
    if (!skill) continue;
    report.receipts_mentioning += 1;
    sessions.add(row.receipt.session_ref);
    if (skill.exposure === "exposed") report.exposed += 1;
    else if (skill.exposure === "not_exposed") report.not_exposed += 1;
    else report.exposure_unknown += 1;
    if (skill.activation === "activated") report.activated += 1;
    else if (skill.activation === "not_activated") report.not_activated += 1;
    else report.activation_unknown += 1;
  }
  report.sessions_observed = sessions.size;
  return report;
}

/**
 * Query 2 (arm 5): "for session Y, the observed counters with their
 * coverage." Per-receipt counters are returned verbatim (only the counters
 * the receipt actually carried — omitted stays omitted); coverage tallies,
 * per counter name, how many of the session's receipts observed it, derived
 * it heuristically, declared it unavailable, or omitted it. An omitted or
 * unavailable counter NEVER surfaces as zero.
 */
export interface SessionCountersReport {
  session_ref: string;
  receipt_count: number;
  receipts: Array<{
    receipt_id: string;
    interval: { started_at: string; ended_at: string };
    counters: Counters;
  }>;
  coverage: Record<
    CounterName,
    { observed: number; heuristic: number; unavailable: number; omitted: number }
  >;
}

export function querySessionCounters(
  namespacesPath: string,
  sessionRef: string,
): SessionCountersReport {
  const coverage = Object.fromEntries(
    COUNTER_NAMES.map((name) => [
      name,
      { observed: 0, heuristic: 0, unavailable: 0, omitted: 0 },
    ]),
  ) as SessionCountersReport["coverage"];

  const report: SessionCountersReport = {
    session_ref: sessionRef,
    receipt_count: 0,
    receipts: [],
    coverage,
  };
  for (const row of readReceiptRows(namespacesPath).rows) {
    if (row.receipt.session_ref !== sessionRef) continue;
    report.receipt_count += 1;
    report.receipts.push({
      receipt_id: row.receipt.receipt_id,
      interval: row.receipt.interval,
      counters: row.receipt.counters,
    });
    for (const name of COUNTER_NAMES) {
      const counter = row.receipt.counters[name];
      if (counter === undefined) coverage[name].omitted += 1;
      else coverage[name][counter.availability] += 1;
    }
  }
  return report;
}
