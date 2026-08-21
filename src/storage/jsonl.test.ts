import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { appendToJsonl } from "./jsonl";
import type { MemoryType } from "../schema/memory";

/**
 * Regression test for the 0NaN.jsonl chunk-rotation bug (2026-08-06):
 * getNextChunkName() used parseInt() on every *.jsonl filename, so when a
 * partition contained "current.jsonl" (non-numeric), rotation produced
 * "0NaN.jsonl". Because appendToJsonl's capacity check only inspects the
 * original file path, that file then absorbed every write forever —
 * unbounded single-file growth that ballooned namespace git repos to
 * hundreds of GB of loose objects (each auto-commit stored a full copy).
 */
function makeRecord(i: number): MemoryType {
  return {
    id: "00000000-0000-4000-8000-000000000000".replace(/0/g, () =>
      Math.floor(Math.random() * 10).toString(),
    ),
    key: `/test/rotation/${i}`,
    domain: "event",
    timestamp: new Date().toISOString(),
    author: "test@example.com",
    action: "add",
    embedding_text: `rotation test record ${i}`,
    attributes: {},
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-jsonl-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("appendToJsonl chunk rotation", () => {
  it("rotates to a numeric chunk (0001.jsonl) when current.jsonl is at capacity, never 0NaN.jsonl", () => {
    const filePath = path.join(tmpDir, "current.jsonl");

    // MAX_LINES_PER_CHUNK = 1000; the 1001st append must rotate.
    for (let i = 0; i < 1001; i++) {
      appendToJsonl(filePath, makeRecord(i));
    }

    const files = fs.readdirSync(tmpDir).sort();
    expect(files).toContain("current.jsonl");
    expect(files).toContain("0001.jsonl");
    expect(files).not.toContain("0NaN.jsonl");

    // The rotated chunk holds exactly the overflow record(s).
    const rotated = fs.readFileSync(path.join(tmpDir, "0001.jsonl"), "utf-8");
    expect(rotated.trim().split("\n").length).toBe(1);
  });

  it("continues the numeric sequence (0002.jsonl) on subsequent rotations", () => {
    const filePath = path.join(tmpDir, "current.jsonl");

    for (let i = 0; i < 2001; i++) {
      appendToJsonl(filePath, makeRecord(i));
    }

    const files = fs.readdirSync(tmpDir).sort();
    expect(files).toContain("0001.jsonl");
    expect(files).toContain("0002.jsonl");
    expect(files).not.toContain("0NaN.jsonl");
  });

  it("ignores a legacy 0NaN.jsonl and still produces numeric chunks", () => {
    // Simulate a partition already polluted by the old bug.
    fs.writeFileSync(path.join(tmpDir, "current.jsonl"), "legacy\n");
    fs.writeFileSync(path.join(tmpDir, "0NaN.jsonl"), "legacy\n");

    const filePath = path.join(tmpDir, "current.jsonl");
    for (let i = 0; i < 1001; i++) {
      appendToJsonl(filePath, makeRecord(i));
    }

    const files = fs.readdirSync(tmpDir).sort();
    expect(files).toContain("0001.jsonl");
    expect(files).toContain("0NaN.jsonl"); // legacy file left untouched
    expect(files).not.toContain("0000.jsonl");
  });
});

describe("DB-GAP-035: write-path validation", () => {
  it("skips an unserializable record (circular attributes) instead of corrupting the file", () => {
    const filePath = path.join(tmpDir, "current.jsonl");

    // A circular attributes object passes MemorySchema.parse (z.any() value
    // schema never recurses into the value) but FAILS JSON.stringify — the
    // exact class of payload that would land a garbage line in the store.
    const record = makeRecord(0);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    record.attributes = circular as never;

    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const written = appendToJsonl(filePath, record);

    // The append must be skipped (0 lines written), logged, and the store
    // left untouched — not even created. (Assert before mockRestore — a
    // restored spy loses its call history.)
    expect(written).toBe(0);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("refusing to append unserializable record"),
    );
    errSpy.mockRestore();
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
