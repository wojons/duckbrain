/**
 * DF-2026-15 — namespace isolation, lifecycle symmetry, and registry truth.
 *
 * ch:trace:row=DF-2026-15 spec=.coding-hermes/board/tasks.jsonl#DF-2026-15 test=src/namespaces/df2026-15.test.ts,src/test-setup.test.ts,src/http/routes/namespaces.test.ts
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import { createNamespaceTool, deleteNamespaceTool } from "../mcp/tools/namespace";
import { getConfig } from "../config/index";

const configPath = (): string => process.env.DUCKBRAIN_CONFIG_PATH!;
const namespaceRoot = (): string => process.env.DUCKBRAIN_NAMESPACES_PATH!;

function liveMappings(): Record<string, string> {
  return JSON.parse(fs.readFileSync(configPath(), "utf8")).namespaceMappings ?? {};
}

describe("DF-2026-15 namespace lifecycle", () => {
  it("create/delete is symmetric in config and directory listing", async () => {
    const name = `df202615-${process.pid}-${Date.now()}`;
    const created = await createNamespaceTool({ name, setDefault: false });

    expect(created.success).toBe(true);
    expect(created.path).toBe(path.join(namespaceRoot(), name));
    expect(liveMappings()[name]).toBe(created.path);
    expect(fs.existsSync(created.path!)).toBe(true);

    const deleted = await deleteNamespaceTool({ name, confirm: true });

    expect(deleted.success).toBe(true);
    expect(liveMappings()[name]).toBeUndefined();
    expect(fs.existsSync(path.join(namespaceRoot(), name))).toBe(false);
    expect(
      fs
        .readdirSync(namespaceRoot(), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    ).not.toContain(name);
    expect(getConfig(".").namespaceMappings?.[name]).toBeUndefined();
  });
});
