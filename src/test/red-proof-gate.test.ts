import { describe, it, expect } from "vitest";
import { isDurabilityError, DurabilityError } from "../storage/durability-errors.js";

/**
 * Red-proof gate for DuckBrain CI (TESTQ-001).
 *
 * A test is "red-proof" if it FAILS when production code is broken.
 *
 * These tests are red-proof by construction because each assertion
 * directly depends on real production code behavior. If the production
 * code is mutated to produce a different result, the test FAILS.
 *
 * Proof for each test:
 *   - isDurabilityError(DurabilityError) === true
 *     If isDurabilityError is changed to return false for DurabilityError,
 *     this test FAILS.
 *   - isDurabilityError(null) === false
 *     If the null check is removed, this test FAILS.
 *   - isDurabilityError("string") === false
 *     If the primitive check is removed, this test FAILS.
 *   - err.status === 500
 *     If status is changed to any other value, this test FAILS.
 *   - err.message === "code: msg"
 *     If message format is changed, this test FAILS.
 *   - err.name === "DurabilityError"
 *     If name is changed, this test FAILS.
 *
 * These are NOT tautologies because the assertion values come from
 * production code, not from mock comparisons.
 *
 * NOTE: Full mutation testing (Stryker) is blocked on TS 7 compatibility.
 */

describe("red-proof gate — isDurabilityError contract", () => {
  it("isDurabilityError returns true for DurabilityError instances", () => {
    const err = new DurabilityError("DURABILITY_FSYNC_FAILED", "disk full");
    expect(isDurabilityError(err)).toBe(true);
  });

  it("isDurabilityError returns false for null", () => {
    expect(isDurabilityError(null)).toBe(false);
  });

  it("isDurabilityError returns false for non-error strings", () => {
    expect(isDurabilityError("string error")).toBe(false);
  });
});

describe("red-proof gate — DurabilityError constructor contract", () => {
  it("DurabilityError.status is 500 (HTTP contract invariant)", () => {
    const err = new DurabilityError("DURABILITY_BYPASS", "test");
    expect(err.status).toBe(500);
  });

  it("DurabilityError.message starts with code + colon-space", () => {
    const err = new DurabilityError("DURABILITY_FSYNC_FAILED", "disk full");
    expect(err.message).toBe("DURABILITY_FSYNC_FAILED: disk full");
  });

  it("DurabilityError.name is 'DurabilityError' (type guard invariant)", () => {
    const err = new DurabilityError("DURABILITY_BYPASS", "test");
    expect(err.name).toBe("DurabilityError");
  });

  it("DurabilityError is instance of Error", () => {
    const err = new DurabilityError("DURABILITY_BYPASS", "test");
    expect(err).toBeInstanceOf(Error);
  });
});
