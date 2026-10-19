import fs from "fs";
import path from "path";
import { z } from "zod";
import { AUDIT_DIR, auditSegmentOrderOnDisk } from "./auditLedger";
import {
  contentHashFor,
  declaredSchemaVersion,
  keyMaterialFor,
} from "./changeRecord";

export const AuditEntrySchema = z.object({
  ts: z.string().datetime(),
  ns: z.string().min(1),
  table: z.string().optional(),
  op: z.string(),
  principal: z.string().nullable().optional(),
  outcome: z.enum(["accepted", "denied"]),
  reason: z.string().optional(),
  seq: z.number().int().positive().optional(),
  // --- DB-SUPA-5 accepted change-record fields ---------------------------
  // Additive on the SUPA-2 audit row: absent on denial rows and on legacy
  // accepted rows, present (and then fully required) on every change record
  // the serializer appends for an accepted write. See
  // src/serialization/changeRecord.ts.
  row: z.unknown().optional(),
  key: z.record(z.string(), z.unknown()).optional(),
  targetPath: z.string().min(1).optional(),
  /**
   * SCHED-GAP-1574: the audit ledger's content digest. Present (as a 64-hex
   * SHA-256 of the serialized data line) on every change record the
   * serializer appends for an accepted write. Legacy rows and denial rows
   * omit it.
   */
  contentHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  tombstone: z.boolean().optional(),
  schemaVersion: z.number().int().positive().optional(),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/**
 * Input for an accepted table-mutation change record (DB-SUPA-5 AC).
 *
 * The REST table layer mutates rows by rewriting the table's JSONL file, so it
 * cannot hand the serializer a `WriteRequest`; what it CAN hand over is the
 * exact serialized line that the mutation produced (update) or removed
 * (delete), plus the physical file that carried it. That is everything a
 * change record needs: `contentHash` is the SHA-256 of that line, so replay
 * can prove the record still describes a real row image rather than trusting
 * a fabricated hash.
 */
export interface AcceptedTableMutationAuditInput {
  ns: string;
  /** Namespace directory — resolves declared key columns and schema version. */
  namespacePath: string;
  table: string;
  op: "update" | "delete";
  principal: string | null;
  /** Namespace-relative POSIX path of the data file the row lives in. */
  targetPath: string;
  /** Exact serialized data line, WITHOUT a trailing newline (as on disk). */
  dataLine: string;
  /** Row image in API shape (object keyed by column name). */
  row: unknown;
  /**
   * True only when the row image is the row as it existed BEFORE the mutation.
   * Replay resolves a tombstone's hash against the parent commit, because a
   * physical delete removes the line from the child tree.
   */
  removed?: boolean;
  ts?: string;
}

/**
 * Promote an accepted table mutation into a real DB-SUPA-5 change record.
 *
 * Every marker `isChangeRecordCandidate` looks for (`contentHash`, `key`,
 * `targetPath`, `tombstone`, `schemaVersion`) is produced here, so the change
 * feed replays the mutation instead of skipping it as a marker-less audit row.
 *
 * Semantics of `contentHash` per operation:
 *   - `update` — the post-mutation line, which is present at the commit that
 *     carries the mutation.
 *   - `delete` — the pre-mutation line; the row itself is gone from the child
 *     tree, so the record names the last committed row image (tombstone
 *     semantics, never `row: null`).
 */
export function acceptedTableMutationRecord(
  input: AcceptedTableMutationAuditInput,
): AuditEntry {
  return AuditEntrySchema.parse({
    ts: input.ts ?? new Date().toISOString(),
    ns: input.ns,
    table: input.table,
    op: input.op,
    principal: input.principal,
    outcome: "accepted",
    targetPath: input.targetPath,
    contentHash: contentHashFor(input.dataLine),
    key: keyMaterialFor(input.namespacePath, input.table, input.row),
    tombstone: input.op === "delete",
    schemaVersion: declaredSchemaVersion(input.namespacePath, input.table),
  });
}

export interface AuditSink {
  enqueueAudit(entry: AuditEntry): Promise<void>;
}

/**
 * Append an internal audit row through the namespace writer. Supplying a sink
 * avoids a module cycle in the writer; other callers resolve the module-level
 * writer lazily.
 */
export async function appendAuditRow(
  ns: string,
  entry: AuditEntry,
  sink?: AuditSink,
): Promise<void> {
  const validated = AuditEntrySchema.parse({ ...entry, ns });
  if (sink) {
    await sink.enqueueAudit(validated);
    return;
  }
  const { getNamespaceWriter } = await import("./namespaceWriter.js");
  await getNamespaceWriter(ns).enqueueAudit(validated);
}

export interface DenialAuditInput {
  ts: string;
  ns?: string;
  table?: string;
  op: string;
  principal?: string | null;
  outcome: "denied";
  reason: string;
}

export const SERVER_AUDIT_MAX_BYTES = 10 * 1024 * 1024;
let denialAuditTail: Promise<void> = Promise.resolve();

async function appendServerDenial(
  namespacesPath: string,
  input: DenialAuditInput,
): Promise<void> {
  const dir = path.join(namespacesPath, ".duckbrain-audit");
  const file = path.join(dir, "denials.jsonl");
  await fs.promises.mkdir(dir, { recursive: true });
  const row = AuditEntrySchema.parse({
    ...input,
    ns: "server",
    principal: input.principal ?? null,
  });
  const line = JSON.stringify(row) + "\n";
  const lineBytes = Buffer.byteLength(line, "utf-8");
  if (lineBytes > SERVER_AUDIT_MAX_BYTES) {
    throw new Error("server denial audit row exceeds the configured log bound");
  }
  let size = 0;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (size + lineBytes > SERVER_AUDIT_MAX_BYTES) {
    const rotated = `${file}.1`;
    await fs.promises.rm(rotated, { force: true });
    await fs.promises.rename(file, rotated);
  }
  await fs.promises.appendFile(file, line, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * True when `ns` names an existing namespace directory under `root`.
 *
 * Used to decide whether a denial row can be appended to that namespace's
 * SUPA-2 `_audit` ledger. A name that is not a single in-root directory (and
 * therefore has no storage) is never given one by an audit append.
 */
function namespaceStorageExists(root: string, ns: string): boolean {
  const candidate = path.resolve(root, ns);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    return false;
  }
  return fs.existsSync(candidate);
}

/**
 * Build the non-blocking denial sink installed by the HTTP server. Namespace
 * denials reuse the SUPA-2 writer; pre-namespace denials use the bounded
 * server JSONL file. Errors are logged and swallowed so denial responses can
 * never recurse into auth or wait on audit I/O.
 *
 * Card t_369581ef: a denial that NAMES a namespace with no storage yet (an
 * MCP/REST refusal to create, switch to, or delete a namespace that does not
 * exist) cannot be appended to that namespace's ledger — the SUPA-2 writer
 * rejects audit rows for a missing namespace, and creating the directory here
 * would materialize storage for a caller we just refused. Such a denial is a
 * pre-namespace denial: it lands in the bounded server-level file, so
 * "every denial is audited" holds for it too.
 */
export function createDenialAuditor(
  namespacesPath: string,
  log: (message: string) => void = (message) => console.error(message),
): (input: DenialAuditInput) => Promise<void> {
  const root = path.resolve(namespacesPath);
  return (input) => {
    denialAuditTail = denialAuditTail
      .then(async () => {
        if (input.ns && namespaceStorageExists(root, input.ns)) {
          const { getNamespaceWriter } = await import("./namespaceWriter.js");
          await appendAuditRow(
            input.ns,
            AuditEntrySchema.parse(input),
            getNamespaceWriter(input.ns, { namespacesPath: root }),
          );
        } else {
          await appendServerDenial(root, input);
        }
      })
      .catch((error) => {
        log(
          `[duckbrain] denial audit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return denialAuditTail;
  };
}

export async function flushDenialAuditsForTests(): Promise<void> {
  await denialAuditTail;
}

export function readServerDenials(namespacesPath: string): AuditEntry[] {
  const file = path.join(
    path.resolve(namespacesPath),
    ".duckbrain-audit",
    "denials.jsonl",
  );
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => AuditEntrySchema.parse(JSON.parse(line)));
}

/**
 * Read every audit row of a namespace in canonical ledger order:
 * `_audit/current.jsonl` first, then numeric segments in ascending numeric
 * order (DB-SUPA-5 append-only segmented ledger).
 */
export function readAuditRows(
  namespacesPath: string,
  ns: string,
): AuditEntry[] {
  const namespacePath = path.join(namespacesPath, ns);
  const auditDir = path.join(namespacePath, AUDIT_DIR);
  const rows: AuditEntry[] = [];
  for (const segment of auditSegmentOrderOnDisk(namespacePath)) {
    const file = path.join(auditDir, segment);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (line.trim() === "") continue;
      rows.push(AuditEntrySchema.parse(JSON.parse(line)));
    }
  }
  return rows;
}
