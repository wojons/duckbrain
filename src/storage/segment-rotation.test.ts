import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryType } from "../schema/memory";
import { appendToJsonl, compareChunkNames, readPartition } from "./jsonl";

let tempDir: string;

function record(i: number): MemoryType {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    key: `/segment-rotation/${i}`,
    domain: "event",
    timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    author: "rotation-test@example.com",
    action: "add",
    embedding_text: `rotation test record ${i}`,
    attributes: {},
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-segment-rotation-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("JSONL segment rotation", () => {
  it("packs 2,505 appends into ceil(N/1000) ordered bounded segments", () => {
    const current = path.join(tempDir, "current.jsonl");
    const count = 2505;

    for (let i = 0; i < count; i++) {
      expect(appendToJsonl(current, record(i))).toBe(1);
    }

    const segments = fs
      .readdirSync(tempDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort(compareChunkNames);
    expect(segments).toEqual(["0001.jsonl", "0002.jsonl", "current.jsonl"]);
    expect(segments).toHaveLength(Math.ceil(count / 1000));
    expect(segments.map((name) =>
      fs.readFileSync(path.join(tempDir, name), "utf8").trim().split("\n").length,
    )).toEqual([1000, 505, 1000]);

    const records = readPartition(tempDir);
    expect(records).toHaveLength(count);
    expect(records.map((item) => item.key).sort()).toEqual(
      Array.from({ length: count }, (_, i) => `/segment-rotation/${i}`).sort(),
    );
  });

  it("uses UTF-8 byte size and does not append to an over-bound active segment", () => {
    const current = path.join(tempDir, "current.jsonl");
    const oversized = record(0);
    oversized.embedding_text = "é".repeat(530_000);
    expect(Buffer.byteLength(JSON.stringify(oversized) + "\n", "utf8"))
      .toBeGreaterThan(1024 * 1024);

    // One record cannot be split, but it remains intact; the next record starts
    // a new segment instead of continuing to grow the over-bound one.
    appendToJsonl(current, oversized);
    appendToJsonl(current, record(1));
    expect(fs.readFileSync(current, "utf8").trim().split("\n")).toHaveLength(1);
    expect(fs.readFileSync(path.join(tempDir, "0001.jsonl"), "utf8"))
      .toContain("/segment-rotation/1");
  });

  it("continues numerically beyond 9999 and never reuses an existing segment name", () => {
    fs.writeFileSync(path.join(tempDir, "9999.jsonl"), "x\n".repeat(1000));
    fs.writeFileSync(path.join(tempDir, "10000.jsonl"), "occupied\n".repeat(1000));
    const current = path.join(tempDir, "current.jsonl");
    fs.writeFileSync(current, "legacy\n");

    appendToJsonl(current, record(1));

    expect(fs.readFileSync(path.join(tempDir, "10000.jsonl"), "utf8"))
      .toBe("occupied\n".repeat(1000));
    expect(fs.readFileSync(path.join(tempDir, "10001.jsonl"), "utf8"))
      .toContain("/segment-rotation/1");
    expect(["9999.jsonl", "10000.jsonl", "10001.jsonl"].sort(compareChunkNames))
      .toEqual(["9999.jsonl", "10000.jsonl", "10001.jsonl"]);
  });
});
