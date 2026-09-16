import fs from "fs";
import path from "path";
import { z } from "zod";
import { AUDIT_DIR, auditSegmentOrderOnDisk } from "./auditLedger";

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
  tombstone: z.boolean().optional(),
  schemaVersion: z.number().int().positive().optional(),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

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
 * Build the non-blocking denial sink installed by the HTTP server. Namespace
 * denials reuse the SUPA-2 writer; pre-namespace denials use the bounded
 * server JSONL file. Errors are logged and swallowed so denial responses can
 * never recurse into auth or wait on audit I/O.
 */
export function createDenialAuditor(
  namespacesPath: string,
  log: (message: string) => void = (message) => console.error(message),
): (input: DenialAuditInput) => Promise<void> {
  const root = path.resolve(namespacesPath);
  return (input) => {
    denialAuditTail = denialAuditTail
      .then(async () => {
        if (input.ns) {
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
