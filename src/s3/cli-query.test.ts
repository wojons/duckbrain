/**
 * Regression tests for `duckbrain s3 query` row printing (S3Q-FIX-001):
 * - node-duckdb returns BigInt for aggregate values (e.g. count(*)) and
 *   native JSON.stringify throws "Do not know how to serialize a BigInt".
 * - formatS3Row routes rows through the codebase's safeJsonStringify helper
 *   (src/utils/serialize.ts): BigInt → Number when safe-integer, String
 *   otherwise, and normal rows serialize exactly as JSON.stringify would.
 *
 * These are pure unit tests — no CLI spawn, no S3, no network.
 */

import { describe, it, expect } from "vitest";
import { formatS3Row } from "./cli";

describe("formatS3Row (S3Q-FIX-001)", () => {
  it("serializes a row containing a safe-integer BigInt (count(*)) without throwing", () => {
    const out = formatS3Row({ count: 3n });
    expect(out).toContain("3");
  });

  it("serializes a huge BigInt beyond MAX_SAFE_INTEGER as a string", () => {
    const out = formatS3Row({ count: BigInt("9007199254740993") });
    expect(out).toContain("9007199254740993");
  });

  it("keeps the exact JSON shape for normal (non-BigInt) rows", () => {
    const row = { ns: "default", kind: "memory", value: 42, ok: true };
    expect(formatS3Row(row)).toBe(JSON.stringify(row));
  });
});
