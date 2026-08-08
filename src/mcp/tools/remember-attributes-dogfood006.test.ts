/**
 * DOGFOOD-006 Regression Tests: MCP `remember` friendly `attributes` error.
 *
 * The MCP remember schema requires an `attributes` object
 * (`z.record(z.string(), z.any())`, no `.optional()`). Before this fix,
 * omitting it produced zod's cryptic default message
 * ("expected record, received undefined" at path attributes), which surfaced
 * to MCP clients as a bare `-32602` with no hint about what to pass. The
 * field stays REQUIRED — only the error message became friendly. These tests
 * guard both the schema-level message and the tool-level error string:
 *
 *  (a) schema safeParse without attributes fails with a message naming
 *      'attributes' and 'required' (not the raw zod default)
 *  (b) rememberTool without attributes returns success:false with the same
 *      friendly message (CLI/socket callers see it too)
 *  (c) a valid attributes object still passes the schema (contract unchanged)
 *  (d) a non-object attributes value still fails (contract unchanged)
 */

import { describe, it, expect } from "vitest";
import { rememberTool, rememberToolDef } from "./remember";

describe("DOGFOOD-006: remember attributes friendly error", () => {
  const baseInput = {
    key: "/scratch/dogfood006",
    domain: "concept",
    embedding_text: "test body",
  };

  it("(a) schema without attributes fails with a friendly message naming 'attributes' + 'required'", () => {
    const result = rememberToolDef.inputSchema.safeParse(baseInput);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join("; ");
      expect(messages).toMatch(/attributes/);
      expect(messages).toMatch(/required/);
      // The raw cryptic default must not be what the user sees.
      expect(messages).not.toBe("expected record, received undefined");
    }
  });

  it("(b) rememberTool without attributes returns success:false with the friendly message", async () => {
    const result = await rememberTool(baseInput as any);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/attributes/);
    expect(result.error).toMatch(/required/);
  });

  it("(c) valid attributes object still passes the schema", () => {
    const result = rememberToolDef.inputSchema.safeParse({
      ...baseInput,
      attributes: { author: "alice", confidence: "high" },
    });
    expect(result.success).toBe(true);
  });

  it("(d) non-object attributes still fails (field stays required + typed)", () => {
    const result = rememberToolDef.inputSchema.safeParse({
      ...baseInput,
      attributes: "not-an-object",
    });
    expect(result.success).toBe(false);
  });
});
