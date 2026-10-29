/**
 * Move one complete L1 file entry into the hermes-memory L2 namespace.
 *
 * This command is intentionally dry-run by default. The parser works on the
 * source file, rather than a summary or a copied representation, so the
 * pointer can only replace an entry that was actually present in L1.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { recallTool } from "../mcp/tools/recall.js";
import { rememberTool } from "../mcp/tools/remember.js";

export const DEMOTION_NAMESPACE = "hermes-memory";
export const DEMOTION_DOMAIN = "raw_note" as const;
export const DEMOTION_SUMMARY_BOUND = 500;
type ParsedEntry = {
  index: number;
  start: number;
  end: number;
  text: string;
};

export type DemotionOptions = {
  file: string;
  entry: string;
  apply?: boolean;
  reason?: string;
  journal?: string;
};

export type RecallBaseline = {
  phrase: string;
  keys: string[];
};

export type DemotionResult = {
  applied: boolean;
  file: string;
  entryIndex: number;
  hash: string;
  key: string;
  gloss: string;
  reason: string;
  baseline: RecallBaseline[];
  journal?: string;
};

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Parse separator-delimited entries while retaining their byte ranges. */
export function parseMemoryEntries(text: string): ParsedEntry[] {
  if (text.length === 0) throw new Error("L1 file is empty");
  if (!text.endsWith("\n")) {
    throw new Error("refusing partial entry: L1 file does not end with a newline");
  }

  // A separator is a complete line, not merely the character § appearing in
  // prose. Keep the source offsets so apply can replace exactly that segment.
  const separators = [...text.matchAll(/^§$/gmu)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  if (separators.length === 0) {
    throw new Error("refusing partial entry: L1 file has no § entry separators");
  }

  const entries: ParsedEntry[] = [];
  let start = 0;
  for (const separator of separators) {
    const textPart = text.slice(start, separator.start).trim();
    if (textPart === "") {
      throw new Error("refusing partial entry: empty content around § separator");
    }
    entries.push({ index: entries.length + 1, start, end: separator.start, text: textPart });
    start = separator.end;
    if (text[start] === "\n") start += 1;
  }
  const finalText = text.slice(start).trim();
  if (finalText === "") throw new Error("refusing partial entry: final entry has missing content");
  entries.push({ index: entries.length + 1, start, end: text.length, text: finalText });
  return entries;
}

function selectEntry(entries: ParsedEntry[], selector: string): ParsedEntry {
  const numeric = /^\d+$/.test(selector) ? Number(selector) : undefined;
  const matches = numeric !== undefined
    ? entries.filter((entry) => entry.index === numeric)
    : entries.filter((entry) => {
        if (selector.startsWith("/") && selector.endsWith("/") && selector.length > 2) {
          return new RegExp(selector.slice(1, -1), "u").test(entry.text);
        }
        return entry.text.includes(selector);
      });
  if (matches.length === 0) throw new Error(`entry selector matched no complete entry: ${selector}`);
  if (matches.length > 1) {
    throw new Error(`entry selector matched ${matches.length} complete entries; use an id or narrower pattern`);
  }
  return matches[0];
}

function oneLineGloss(entry: string): string {
  const firstLine = entry.split("\n").map((line) => line.trim()).find(Boolean);
  if (!firstLine) throw new Error("refusing entry with missing content");
  return firstLine.replace(/^#+\s*/, "").replace(/\s+/g, " ").slice(0, 160);
}

function keyPhrases(entry: string): string[] {
  const phrases = entry
    .replace(/[`*_#\[\](){}:;,.!?/\\]+/g, " ")
    .split(/\s+/u)
    .map((word) => word.trim())
    .filter((word) => word.length >= 5 && !/^\d+$/u.test(word));
  return [...new Set(phrases)].slice(0, 3);
}

async function recallBaseline(namespace: string, entry: string): Promise<RecallBaseline[]> {
  const phrases = keyPhrases(entry);
  const baseline: RecallBaseline[] = [];
  for (const phrase of phrases) {
    const result = await recallTool({ namespace, contains: phrase, limit: 20 });
    baseline.push({ phrase, keys: (result.memories ?? []).map((memory) => memory.key) });
  }
  return baseline;
}

function pointerFor(hash: string, gloss: string): string {
  return `[db#${hash.slice(0, 12)}] ${gloss}`;
}

function replaceEntry(text: string, entry: ParsedEntry, pointer: string): string {
  return text.slice(0, entry.start) + `${pointer}\n` + text.slice(entry.end);
}

function defaultJournal(file: string): string {
  return path.join(path.dirname(path.resolve(file)), ".memory-demotion-journal.jsonl");
}

function atomicWrite(file: string, content: string): void {
  const temporary = `${file}.demotion-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve original error */ }
    throw error;
  }
}

/** Demote one complete entry; dry-run is the safe default. */
export async function demoteMemoryEntry(options: DemotionOptions): Promise<DemotionResult> {
  const file = path.resolve(options.file);
  const source = fs.readFileSync(file, "utf8");
  const entries = parseMemoryEntries(source);
  const selected = selectEntry(entries, options.entry);
  if (selected.text.length > DEMOTION_SUMMARY_BOUND) {
    throw new Error(
      `refusing oversized entry: ${selected.text.length} chars exceeds summary bound ${DEMOTION_SUMMARY_BOUND}`,
    );
  }
  if (/\[redacted\]|<redacted>|\*\*\*+/iu.test(selected.text)) {
    throw new Error("refusing redacted entry: content contains a redaction marker");
  }
  const hash = sha256(selected.text);
  const gloss = oneLineGloss(selected.text);
  const key = `/memory/demoted/${path.basename(file)}/${hash.slice(0, 12)}`;
  const reason = options.reason?.trim() || "manual L1 to L2 demotion";
  const baseline = await recallBaseline(DEMOTION_NAMESPACE, selected.text);
  const result: DemotionResult = {
    applied: options.apply === true,
    file,
    entryIndex: selected.index,
    hash,
    key,
    gloss,
    reason,
    baseline,
    ...(options.apply === true ? { journal: path.resolve(options.journal ?? defaultJournal(file)) } : {}),
  };

  if (options.apply !== true) return result;

  const write = await rememberTool({
    key,
    domain: DEMOTION_DOMAIN,
    attributes: {
      source_file: path.basename(file),
      source_entry: selected.index,
      content_sha256: hash,
      demotion_reason: reason,
    },
    embedding_text: selected.text,
    namespace: DEMOTION_NAMESPACE,
  });
  if (!write.success) throw new Error(`hermes-memory write failed: ${write.error ?? "unknown error"}`);

  const pointer = pointerFor(hash, gloss);
  atomicWrite(file, replaceEntry(source, selected, pointer));
  const journalPath = path.resolve(options.journal ?? defaultJournal(file));
  fs.appendFileSync(
    journalPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      file,
      entry_id: selected.index,
      hash,
      reason,
      gloss,
      key,
      baseline,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return result;
}

export function printDemotionHelp(): void {
  console.log("Usage: duckbrain memory demote --file=<MEMORY.md> --entry=<id-or-pattern> [options]");
  console.log("  --apply              Write the record, pointer, and journal (default: dry-run)");
  console.log("  --reason=<text>      Why this L1 entry is being demoted");
  console.log("  --journal=<path>     Journal path (default: alongside the L1 file)");
  console.log(`  Refuses entries over ${DEMOTION_SUMMARY_BOUND} chars or containing redaction markers.`);
}
