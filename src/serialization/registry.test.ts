import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MemorySchema } from "../schema/memory";
import { TableSchemaRegistry } from "./registry";

describe("SUPA-2 table schema registry", () => {
  it("resolves the built-in memories schema for every namespace", () => {
    const registry = new TableSchemaRegistry();
    expect(registry.get("alpha", "memories")).toBe(MemorySchema);
    expect(registry.get("beta", "memories")).toBe(MemorySchema);
  });

  it("round-trips an explicitly registered arbitrary table schema", () => {
    const registry = new TableSchemaRegistry();
    const schema = z.object({ id: z.string(), score: z.number() });
    registry.register("alpha", "scores", schema);
    expect(registry.get("alpha", "scores")).toBe(schema);
  });

  it("returns undefined for an unregistered arbitrary table", () => {
    expect(new TableSchemaRegistry().get("alpha", "missing")).toBeUndefined();
  });
});
