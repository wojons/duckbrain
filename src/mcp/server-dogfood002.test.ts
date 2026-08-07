/**
 * DOGFOOD-002 Regression Tests: MCP wrapHandler isError surfacing.
 *
 * Regressions guarded:
 *  - a handler result object with a truthy `error` field (e.g. recall's
 *    {memories:[], count:0, error:"Embedding generation failed: ..."}) is
 *    returned with isError:true so MCP clients can distinguish "no results"
 *    from "failed" — the text payload is kept so the message stays visible
 *  - a thrown handler exception is returned with isError:true
 *  - success results keep isError unset (falsey) — no behavior change
 */

import { describe, it, expect } from "vitest";
import { wrapHandler } from "./server";

describe("DOGFOOD-002: wrapHandler isError surfacing", () => {
  it("sets isError:true when the result object has a truthy error field", async () => {
    const wrapped = wrapHandler(async () => ({
      memories: [],
      count: 0,
      error: "Embedding generation failed: lmstudio/broken: embed HTTP 400",
    }));

    const result = await wrapped({ query: "alpha" });

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("Embedding generation failed");
    // The text payload is kept — agents still see the message
    expect(result.content[0].text).toContain("lmstudio/broken");
  });

  it("keeps isError unset for success results (no error field)", async () => {
    const wrapped = wrapHandler(async () => ({
      memories: [{ id: "m1" }],
      count: 1,
    }));

    const result = await wrapped({ query: "alpha" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("m1");
  });

  it("keeps isError unset when the error field is falsy (empty string)", async () => {
    const wrapped = wrapHandler(async () => ({
      memories: [],
      count: 0,
      error: "",
    }));

    const result = await wrapped({ query: "alpha" });

    expect(result.isError).toBeUndefined();
  });

  it("sets isError:true when the handler throws", async () => {
    const wrapped = wrapHandler(async () => {
      throw new Error("boom");
    });

    const result = await wrapped({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: boom");
  });

  it("applies uniformly to non-recall tools (remember-style success/error shapes)", async () => {
    const ok = wrapHandler(async () => ({ success: true, id: "x" }));
    expect((await ok({})).isError).toBeUndefined();

    const err = wrapHandler(async () => ({
      success: false,
      error: "Memory validation failed: bad domain",
    }));
    const errResult = await err({});
    expect(errResult.isError).toBe(true);
    expect(errResult.content[0].text).toContain("Memory validation failed");
  });
});
