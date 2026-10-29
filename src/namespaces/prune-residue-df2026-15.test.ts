/** DF-2026-15: prune reports the same registered set as REST. */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import { planNamespacePrune } from "./prune";
import { listNamespacesTool } from "../mcp/tools/namespace";

describe("DF-2026-15 registry/prune parity", () => {
  it("counts only registered mappings and excludes directory-only phantoms", async () => {
    const plan = planNamespacePrune();
    const mappings = plan.live.length + plan.dead.length + plan.refused.length;
    const listed = await listNamespacesTool({});
    expect(listed.success).toBe(true);
    const registered = listed.namespaces.filter((ns) => !ns.onDiskOnly);
    expect(registered.length).toBe(mappings);
    expect(registered.some((ns) => ns.name === "df-asof")).toBe(false);
    expect(fs.existsSync(path.join(process.env.DUCKBRAIN_NAMESPACES_PATH!, "df-asof"))).toBe(false);
  });
});
