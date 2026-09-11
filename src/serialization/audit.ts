import fs from "fs";
import path from "path";
import { z } from "zod";

export const AuditEntrySchema = z.object({
  ts: z.string().datetime(),
  ns: z.string().min(1),
  table: z.string().optional(),
  op: z.string(),
  principal: z.string().nullable().optional(),
  outcome: z.enum(["accepted", "denied"]),
  reason: z.string().optional(),
  seq: z.number().int().positive().optional(),
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

export function readAuditRows(
  namespacesPath: string,
  ns: string,
): AuditEntry[] {
  const file = path.join(namespacesPath, ns, "_audit", "current.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => AuditEntrySchema.parse(JSON.parse(line)));
}
