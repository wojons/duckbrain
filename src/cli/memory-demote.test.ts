import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEMOTION_NAMESPACE,
  DEMOTION_SUMMARY_BOUND,
  demoteMemoryEntry,
  parseMemoryEntries,
} from "./memory-demote";
import { recallTool } from "../mcp/tools/recall";

const scratch: string[] = [];

afterEach(() => {
  for (const file of scratch.splice(0)) fs.rmSync(file, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeL1(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-demotion-"));
  scratch.push(directory);
  const file = path.join(directory, "MEMORY.md");
  fs.writeFileSync(
    file,
    "First durable demotion probe: a complete source entry.\n§\nA second untouched entry remains in L1.\n",
    "utf8",
  );
  return file;
}

describe("DF-2026-16 L1 to L2 demotion", () => {
  it("parses complete separator-delimited entries from the source file", () => {
    const entries = parseMemoryEntries("alpha\n§\nbeta\n");
    expect(entries.map((entry) => entry.text)).toEqual(["alpha", "beta"]);
    expect(() => parseMemoryEntries("alpha\n§\nbeta")).toThrow(/partial entry/);
  });

  it("refuses redacted and oversized source entries", async () => {
    const file = makeL1();
    fs.writeFileSync(file, "[REDACTED]\n§\nuntouched\n", "utf8");
    await expect(demoteMemoryEntry({ file, entry: "1" })).rejects.toThrow(/redacted/);

    fs.writeFileSync(file, `${"x".repeat(DEMOTION_SUMMARY_BOUND + 1)}\n§\nuntouched\n`, "utf8");
    await expect(demoteMemoryEntry({ file, entry: "1" })).rejects.toThrow(/oversized/);
  });

  it("dry-runs without changing the file or journal", async () => {
    const file = makeL1();
    const before = fs.readFileSync(file, "utf8");
    const result = await demoteMemoryEntry({ file, entry: "demotion probe" });
    expect(result.applied).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(path.dirname(file), ".memory-demotion-journal.jsonl"))).toBe(false);
  });

  it("writes the exact source entry, pointer, and journal on apply", async () => {
    const file = makeL1();
    const entry = "First durable demotion probe: a complete source entry.";
    const hash = crypto.createHash("sha256").update(entry).digest("hex");
    const journal = path.join(path.dirname(file), "journal.jsonl");

    const result = await demoteMemoryEntry({ file, entry: "1", apply: true, reason: "free L1 space", journal });
    expect(result.applied).toBe(true);
    expect(result.hash).toBe(hash);
    expect(fs.readFileSync(file, "utf8")).toContain(`[db#${hash.slice(0, 12)}] First durable demotion probe: a complete source entry.`);
    expect(fs.readFileSync(file, "utf8")).toContain("A second untouched entry remains in L1.");

    const journalRecord = JSON.parse(fs.readFileSync(journal, "utf8"));
    expect(journalRecord).toMatchObject({
      file,
      entry_id: 1,
      hash,
      reason: "free L1 space",
      gloss: "First durable demotion probe: a complete source entry.",
      key: result.key,
    });

    const recalled = await recallTool({ key: result.key, namespace: DEMOTION_NAMESPACE, limit: 5 });
    expect(recalled.memories.some((memory) => memory.embedding_text === entry)).toBe(true);
    expect(result.baseline.length).toBeGreaterThan(0);
  });
});
