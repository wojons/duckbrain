import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { appendToJsonl, getNextChunkName, readPartition } from "./jsonl";
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

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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

/**
 * Regression: rotation froze at segment 9999 (2026-09-19).
 *
 * `padStart(4, "0")` stops padding once a number exceeds 4 digits, so the
 * segment names past 9999 are not fixed-width ("10000.jsonl"). A plain
 * lexicographic `.sort()` then ranks "9999.jsonl" as the newest segment, and
 * getNextChunkName() returned "10000.jsonl" — a name that already existed —
 * on every call. Rotation stopped advancing, one segment absorbed every write
 * forever, and the partition bounded at 1000 lines / 1MB was found holding
 * 87,530 lines / 84MB. Each auto-commit then stored a full 84MB blob, which
 * bloated the namespace git repo to 3.2GB and made every S3 bundle push
 * re-compress that history (measured 470 CPU-seconds per push).
 */
describe("chunk rotation past segment 9999", () => {
  const seed = (names: string[]): void => {
    for (const n of names) fs.writeFileSync(path.join(tmpDir, n), "", "utf8");
  };

  it("continues to 10001.jsonl when 9999.jsonl and 10000.jsonl exist", () => {
    seed(["9999.jsonl", "10000.jsonl"]);
    expect(getNextChunkName(tmpDir)).toBe("10001.jsonl");
  });

  it("skips existing names instead of re-returning one (collision guard)", () => {
    seed(["9999.jsonl", "10000.jsonl", "10001.jsonl", "10002.jsonl"]);
    expect(getNextChunkName(tmpDir)).toBe("10003.jsonl");
  });

  it("keeps the legacy numeric sequence below 10000", () => {
    seed(["0001.jsonl", "0002.jsonl"]);
    expect(getNextChunkName(tmpDir)).toBe("0003.jsonl");
  });

  it("ignores non-numeric segments when choosing the next chunk", () => {
    seed(["0007.jsonl", "current.jsonl"]);
    expect(getNextChunkName(tmpDir)).toBe("0008.jsonl");
  });

  it("appends to a NEW segment when a five-digit-named segment is at capacity", () => {
    // 1000 lines is MAX_LINES_PER_CHUNK, so 9999.jsonl is full.
    const full = path.join(tmpDir, "9999.jsonl");
    fs.writeFileSync(full, "x\n".repeat(1000), "utf8");
    seed(["10000.jsonl"]);

    const written = appendToJsonl(full, makeRecord(1));

    expect(written).toBe(1);
    // The record must land in a fresh segment — not in 10000.jsonl.
    expect(fs.readFileSync(path.join(tmpDir, "10001.jsonl"), "utf8")).toContain(
      "/test/rotation/1",
    );
    expect(fs.readFileSync(path.join(tmpDir, "10000.jsonl"), "utf8")).toBe("");
  });

  it("reads segments in numeric order, not lexicographic order", () => {
    const a = makeRecord(1);
    const b = makeRecord(2);
    fs.writeFileSync(
      path.join(tmpDir, "9999.jsonl"),
      `${JSON.stringify(a)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(tmpDir, "10000.jsonl"),
      `${JSON.stringify(b)}\n`,
      "utf8",
    );

    const records = readPartition(tmpDir);

    // Before the fix this returned 10000.jsonl's record first ("10000.jsonl"
    // sorts below "9999.jsonl" lexicographically), i.e. out of append order.
    expect(records.map((r) => r.key)).toEqual([
      "/test/rotation/1",
      "/test/rotation/2",
    ]);
  });
});
