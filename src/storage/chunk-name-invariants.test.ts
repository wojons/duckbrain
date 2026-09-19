/**
 * Chunk-name invariant tests — the bug CLASS behind DB-GAP-049.
 *
 * DB-GAP-049 froze rotation at segment 9999: `padStart(4, "0")` stops padding
 * past four digits, so a lexicographic sort ranked "9999.jsonl" above
 * "10000.jsonl" and getNextChunkName() returned a name that already existed.
 * One segment then absorbed every write (87,530 lines / 84MB against a
 * 1000-line / 1MB bound), which put an 84MB blob in every commit.
 *
 * These tests lock the invariants for the whole class rather than the single
 * symptom, so the same hole cannot reopen at another magnitude or in another
 * caller:
 *   1. numeric segments order numerically at every magnitude,
 *   2. non-numeric names are deterministic and never rotation targets,
 *   3. rotation never returns an existing name (randomised, spanning 9999),
 *   4. rotation stays strictly monotonic across the boundary,
 *   5. appends and reads stay in append order across the boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  appendToJsonl,
  compareChunkNames,
  getNextChunkName,
  readPartition,
} from "./jsonl";
import type { MemoryType } from "../schema/memory";

function makeRecord(i: number): MemoryType {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    key: `/test/chunk-invariants/${i}`,
    domain: "event",
    timestamp: new Date(1700000000000 + i * 1000).toISOString(),
    author: "test@example.com",
    action: "add",
    embedding_text: `chunk invariant record ${i}`,
    attributes: {},
  };
}

let tmpDir: string;
let caseDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-chunk-inv-"));
  caseDir = fs.mkdtempSync(path.join(tmpDir, "partition-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seed(dir: string, names: string[]): void {
  for (const n of names) fs.writeFileSync(path.join(dir, n), "", "utf8");
}

describe("chunk name ordering invariants", () => {
  it("orders numeric segments numerically at every magnitude", () => {
    const ascending = [
      "0001.jsonl",
      "0009.jsonl",
      "0010.jsonl",
      "0099.jsonl",
      "0100.jsonl",
      "0999.jsonl",
      "1000.jsonl",
      "9998.jsonl",
      "9999.jsonl",
      "10000.jsonl",
      "10001.jsonl",
      "100000.jsonl",
    ];
    // Reverse order: every adjacent pair here is a pair a lexicographic sort
    // gets wrong (9 then 1, 9 then 0).
    expect([...ascending].reverse().sort(compareChunkNames)).toEqual(ascending);
    // Documents the hazard this module guards against.
    expect([...ascending].sort()).not.toEqual(ascending);
  });

  it("orders non-numeric names after numeric ones, deterministically", () => {
    const sorted = [
      "10000.jsonl",
      "current.jsonl",
      "0002.jsonl",
      "zz-legacy.jsonl",
    ].sort(compareChunkNames);
    expect(sorted.slice(0, 2)).toEqual(["0002.jsonl", "10000.jsonl"]);
    expect(sorted.slice(2)).toEqual(["current.jsonl", "zz-legacy.jsonl"]);
  });

  it("never returns an existing name, for randomised sets spanning 9999", () => {
    for (let trial = 0; trial < 50; trial++) {
      const dir = fs.mkdtempSync(path.join(tmpDir, `t${trial}-`));
      const nums = new Set<number>();
      while (nums.size < 10) nums.add(9990 + Math.floor(Math.random() * 25));
      const names = [...nums]
        .sort((a, b) => a - b)
        .map((n) => `${String(n).padStart(4, "0")}.jsonl`);
      seed(dir, names);

      const next = getNextChunkName(dir);

      expect(names).not.toContain(next);
      expect(/^\d+\.jsonl$/.test(next)).toBe(true);
      expect(Number(next.replace(".jsonl", ""))).toBe(Math.max(...nums) + 1);
    }
  });

  it("keeps rotation strictly monotonic across the 4->5 digit boundary", () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "mono-"));
    seed(dir, [
      "9995.jsonl",
      "9996.jsonl",
      "9997.jsonl",
      "9998.jsonl",
      "9999.jsonl",
    ]);

    let previous = 9999;
    for (let i = 0; i < 40; i++) {
      const next = getNextChunkName(dir);
      const num = Number(next.replace(".jsonl", ""));
      expect(num).toBe(previous + 1);
      expect(fs.existsSync(path.join(dir, next))).toBe(false);
      fs.writeFileSync(path.join(dir, next), "", "utf8");
      previous = num;
    }
    expect(previous).toBe(10039);
  });

  it("never treats a derived/legacy name as a rotation target", () => {
    seed(caseDir, [
      "0005.jsonl",
      "0005-cleaned.jsonl",
      "current.jsonl",
      "0005.jsonl.bak",
    ]);
    expect(getNextChunkName(caseDir)).toBe("0006.jsonl");
  });

  it("appends into a fresh segment past the boundary and reads back in append order", () => {
    const first = makeRecord(1);
    const second = makeRecord(2);
    const third = makeRecord(3);
    // 9999.jsonl is at MAX_LINES_PER_CHUNK (1000), so a write must rotate.
    // Filler lines are valid records so the partition stays readable.
    const filler = Array.from({ length: 999 }, (_, i) =>
      JSON.stringify(makeRecord(1000 + i)),
    ).join("\n");
    fs.writeFileSync(
      path.join(caseDir, "9999.jsonl"),
      `${JSON.stringify(first)}\n${filler}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(caseDir, "10000.jsonl"),
      `${JSON.stringify(second)}\n`,
      "utf8",
    );

    expect(appendToJsonl(path.join(caseDir, "9999.jsonl"), third)).toBe(1);

    // The new record lands in a NEW segment, never inside 10000.jsonl.
    expect(
      fs.readFileSync(path.join(caseDir, "10001.jsonl"), "utf8"),
    ).toContain("/test/chunk-invariants/3");
    expect(fs.readFileSync(path.join(caseDir, "10000.jsonl"), "utf8")).toBe(
      `${JSON.stringify(second)}\n`,
    );

    // And reads follow numeric order: 9999 before 10000 before 10001.
    const keys = readPartition(caseDir)
      .filter((r) => r.key.startsWith("/test/chunk-invariants/"))
      .map((r) => r.key);
    expect(keys[0]).toBe("/test/chunk-invariants/1");
    expect(keys).toContain("/test/chunk-invariants/2");
    expect(keys[keys.length - 1]).toBe("/test/chunk-invariants/3");
  });
});
