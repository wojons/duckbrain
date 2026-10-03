/**
 * QA-DUCKBRAIN-003 — DURABILITY_* codes must be visible in the HTTP error
 * envelope. `DurabilityError` is NOT an `ApiError`, so without the dedicated
 * branch in `errorHandler` it fell through to the generic
 * `{"error":"Internal server error","code":"INTERNAL_ERROR"}` and the
 * machine-readable code was lost from every response.
 *
 * Status stays 500 by design (SUPA-1 spec: a durability mechanism that cannot
 * honor its contract fails the request LOUDLY — never downgraded to 4xx).
 *
 * These tests call the middleware directly (Express signature) so the
 * branch logic is pinned independently of any route's own code mapping.
 */

import { describe, it, expect } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { errorHandler, ApiError } from "./errorHandler";
import { DurabilityError } from "../../storage/durability-errors";

function runMiddleware(err: Error): { status: number; body: any } {
  const captured: { status: number; body: any } = { status: 0, body: null };
  const res: any = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  errorHandler(err, {} as Request, res as Response, (() => {}) as NextFunction);
  return captured;
}

describe("QA-DUCKBRAIN-003: errorHandler surfaces DURABILITY_* codes", () => {
  it("maps a DurabilityError to status 500 with its machine-readable code", () => {
    const captured = runMiddleware(
      new DurabilityError(
        "DURABILITY_UNSUPPORTED",
        "O_DIRECT is not supported on this filesystem for /x/current.jsonl",
      ),
    );

    expect(captured.status).toBe(500);
    expect(captured.body.code).toBe("DURABILITY_UNSUPPORTED");
    expect(captured.body.error).toContain("DURABILITY_UNSUPPORTED");
  });

  it("keeps every DURABILITY_* code loud at 500 (never 4xx)", () => {
    for (const code of [
      "DURABILITY_UNSUPPORTED",
      "DURABILITY_DIRECT_FRAME_ERROR",
      "DURABILITY_FSYNC_FAILED",
      "DURABILITY_DIR_FSYNC_UNSUPPORTED",
      "DURABILITY_BYPASS",
    ] as const) {
      const captured = runMiddleware(
        new DurabilityError(code, `probe for ${code}`),
      );
      expect(captured.status).toBe(500);
      expect(captured.body.code).toBe(code);
    }
  });

  it("does not swallow duck-typed DurabilityErrors from a twin module instance", () => {
    // isDurabilityError() also recognizes name+code shape (two import
    // spellings of one module must not split the envelope surface).
    const twin = Object.assign(new Error("DURABILITY_BYPASS: twin"), {
      name: "DurabilityError",
      code: "DURABILITY_BYPASS",
      status: 500,
    });
    const captured = runMiddleware(twin);

    expect(captured.status).toBe(500);
    expect(captured.body.code).toBe("DURABILITY_BYPASS");
  });

  it("leaves generic errors on the INTERNAL_ERROR path (no broadening)", () => {
    const captured = runMiddleware(new Error("something else broke"));

    expect(captured.status).toBe(500);
    expect(captured.body.code).toBe("INTERNAL_ERROR");
  });

  it("leaves ApiError handling unchanged (branch must not preempt it)", () => {
    const captured = runMiddleware(
      new ApiError("Missing required fields", 400, "VALIDATION_ERROR"),
    );

    expect(captured.status).toBe(400);
    expect(captured.body.code).toBe("VALIDATION_ERROR");
  });
});
