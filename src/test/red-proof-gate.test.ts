import { describe, it, expect } from "vitest";
import { isDurabilityError, DurabilityError } from "../storage/durability-errors.js";

/**
 * Red-proof gate for DuckBrain CI (TESTQ-001).
 *
 * A test is "red-proof" if it FAILS when production code is broken.
 *
 * Each baseline test makes a SPECIFIC assertion about production code values.
 * If the production code is mutated in a way that violates that behavior,
 * the test FAILS. These are NOT tautologies — the assertion values come
 * from real production code, not from mock comparisons.
 *
 * Proof for each test:
 *   - isDurabilityError(new DurabilityError(...)) === true
 *     If isDurabilityError returns false for DurabilityError → FAILS
 *   - isDurabilityError(null) === false
 *     If null check removed → FAILS
 *   - isDurabilityError("string") === false
 *     If primitive check removed → FAILS
 *   - err.status === 500
 *     If status changed → FAILS
 *   - err.message === "code: msg"
 *     If message format changed → FAILS
 *   - err.name === "DurabilityError"
 *     If name changed → FAILS
 *   - err instanceof Error
 *     If inheritance broken → FAILS
 *
 * These tests directly exercise production code from
 * src/storage/durability-errors.ts. Breaking that code breaks these tests.
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
  it("DurabilityError.status is 500", () => {
    const err = new DurabilityError("DURABILITY_BYPASS", "test");
    expect(err.status).toBe(500);
  });

  it("DurabilityError.message includes code prefix", () => {
    const err = new DurabilityError("DURABILITY_FSYNC_FAILED", "disk full");
    expect(err.message).toBe("DURABILITY_FSYNC_FAILED: disk full");
  });

  it("DurabilityError.name is 'DurabilityError'", () => {
    const err = new DurabilityError("DURABILITY_BYPASS", "test");
    expect(err.name).toBe("DurabilityError");
  });

  it("DurabilityError is instance of Error", () => {
    const err = new DurabilityError("DURABILITY_BYPASS", "test");
    expect(err).toBeInstanceOf(Error);
  });
});
