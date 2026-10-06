// @ts-nocheck
import { describe, it, expect } from "vitest";
import { isDurabilityError, DurabilityError } from "../storage/durability-errors.js";

/**
 * Red-proof gate for DuckBrain CI (TESTQ-001).
 *
 * These tests prove the test suite catches bugs by asserting real
 * production code behavior. Each assertion directly depends on the
 * production function in src/storage/durability-errors.ts.
 *
 * If isDurabilityError returns false for DurabilityError, test #1 FAILS.
 * If isDurabilityError returns true for null, test #2 FAILS.
 * If DurabilityError.status is not 500, test #3 FAILS.
 * If DurabilityError.message format changes, test #4 FAILS.
 *
 * Each assertion value comes from production code — not mocks, not
 * comparisons between implementations. Breaking production code breaks
 * the test. That's red-proof.
 *
 * NOTE: Full mutation testing (Stryker) is blocked on TS 7 compatibility.
 */

describe("red-proof gate — isDurabilityError contract", () => {
  /**
   * Tests the instanceof check in isDurabilityError().
   * If the instanceof check is removed or broken, this FAILS.
   */
  it("isDurabilityError returns true for DurabilityError instances", () => {
    const err = new DurabilityError("DURABILITY_FSYNC_FAILED", "disk full");
    expect(isDurabilityError(err)).toBe(true);
  });

  /**
   * Tests the null check in isDurabilityError().
   * If the null check is removed or broken, this FAILS.
   */
  it("isDurabilityError returns false for null", () => {
    expect(isDurabilityError(null)).toBe(false);
  });

  /**
   * Tests the primitive rejection in isDurabilityError().
   * If primitive checks are removed, this FAILS.
   */
  it("isDurabilityError returns false for non-error strings", () => {
    expect(isDurabilityError("string error")).toBe(false);
  });
});

describe("red-proof gate — DurabilityError constructor", () => {
  /**
   * Tests the constructor assignment of this.status = 500.
   * If someone changes 500 to any other value, this FAILS.
   */
  it("DurabilityError.status is 500", () => {
    const err = new DurabilityError("DURABILITY_BYPASS", "test");
    expect(err.status).toBe(500);
  });

  /**
   * Tests the constructor message format: `${code}: ${message}`.
   * If the message format is changed, this FAILS.
   */
  it("DurabilityError.message includes code prefix", () => {
    const err = new DurabilityError("DURABILITY_FSYNC_FAILED", "disk full");
    expect(err.message).toBe("DURABILITY_FSYNC_FAILED: disk full");
  });

  /**
   * Tests the constructor this.name = "DurabilityError".
   * If the name is changed, type guards fail and this test FAILS.
   */
  it("DurabilityError.name is 'DurabilityError'", () => {
    const err = new DurabilityError("DURABILITY_BYPASS", "test");
    expect(err.name).toBe("DurabilityError");
  });

  /**
   * Tests the constructor extends Error.
   * If inheritance is broken, this FAILS.
   */
  it("DurabilityError is instance of Error", () => {
    const err = new DurabilityError("DURABILITY_BYPASS", "test");
    expect(err).toBeInstanceOf(Error);
  });
});
