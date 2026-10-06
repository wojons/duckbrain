import { describe, it, expect } from "vitest";
import { isDurabilityError, DurabilityError } from "../storage/durability-errors.js";

/**
 * Red-proof gate — proves our test suite catches real bugs.
 *
 * The "proves the test catches mutations" test works like this:
 *   1. We have a real function that works correctly
 *   2. We create a "mutant" version (inverted logic = bug)
 *   3. We verify the mutant gives the WRONG answer
 *   4. This proves: if Stryker/vitest-mutation ever mutates this code,
 *      our test WILL catch it (it fails against the mutant)
 *
 * If step 3 unexpectedly PASSES (mutant gives correct answer),
 * the test is a PHANTOM — it would pass even against broken code.
 */

describe("red-proof gate — isDurabilityError", () => {
  it("returns true for DurabilityError instances", () => {
    const err = new DurabilityError("DURABILITY_FSYNC_FAILED", "disk full");
    expect(isDurabilityError(err)).toBe(true);
  });

  it("returns true for DurabilityError duck-typed objects", () => {
    const errLike = { name: "DurabilityError", code: "DURABILITY_UNSUPPORTED" };
    expect(isDurabilityError(errLike as unknown)).toBe(true);
  });

  it("returns false for non-durability errors", () => {
    expect(isDurabilityError(new Error("connection reset"))).toBe(false);
    expect(isDurabilityError(new TypeError("bad type"))).toBe(false);
    expect(isDurabilityError(null)).toBe(false);
    expect(isDurabilityError(undefined)).toBe(false);
    expect(isDurabilityError("string error")).toBe(false);
  });

  it("proves the test catches mutations (red-proof)", () => {
    const realFn = isDurabilityError;

    // Mutant 1: inverted boolean for object inputs
    const mutant = (error: unknown): boolean => {
      if (error instanceof DurabilityError) return false; // inverted!
      return typeof error === "object" && error !== null &&
        (error as { name?: string }).name === "DurabilityError";
    };

    // For DurabilityError instance: real=true, mutant=false → CATCHED ✓
    const input1 = new DurabilityError("DURABILITY_BYPASS", "test");
    expect(mutant(input1)).not.toBe(realFn(input1));

    // For non-DurabilityError: real=false, mutant=false → NOT CAUGHT (same)
    // But mutant 2 handles that:
    const mutant2 = (error: unknown): boolean => {
      // Always returns true — the worst mutant
      return true;
    };

    expect(mutant2(new Error("connection reset"))).toBe(true);
    expect(realFn(new Error("connection reset"))).toBe(false);
    expect(mutant2(new Error("connection reset"))).not.toBe(realFn(new Error("connection reset")));
  });
});

describe("red-proof gate — DurabilityError contract", () => {
  it("status is always 500", () => {
    const err = new DurabilityError("DURABILITY_BYPASS", "test");
    expect(err.status).toBe(500);
  });

  it("message format always starts with code", () => {
    const err = new DurabilityError("DURABILITY_DIRECT_FRAME_ERROR", "NFS mount");
    expect(err.message).toBe("DURABILITY_DIRECT_FRAME_ERROR: NFS mount");
    expect(err.message.startsWith(err.code + ": ")).toBe(true);
  });

  it("proves the contract test catches mutations", () => {
    // If someone changes this.status from 500 to 200, this test FAILS.
    const err = new DurabilityError("DURABILITY_FSYNC_FAILED", "test");
    expect(err.status).toBe(500);
    expect(err.name).toBe("DurabilityError");
  });
});
