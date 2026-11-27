import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { createNamespaceTool, deleteNamespaceTool } from "./namespace";
import { squashTool } from "./squash";
import { rememberTool } from "./remember";
import { forgetTool } from "./forget";
import type { AuthPrincipal, DenialAuditEvent } from "../../auth/middleware";
import { resolveNamespacesPath } from "../../config/index";

const analyst: AuthPrincipal = { name: "analyst", authenticated: true, tokenType: "apikey", roles: ["analyst"], namespaces: ["role-test-existing", "role-test-new"] };

describe("MCP write role enforcement", () => {
  it("refuses namespace creation and deletion before filesystem mutation", async () => {
    const root = resolveNamespacesPath();
    const existing = path.join(root, "role-test-existing");
    const fresh = path.join(root, "role-test-new");
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, "sentinel"), "keep");
    const events: DenialAuditEvent[] = [];
    const context = { principal: analyst, auditDenial: (event: DenialAuditEvent) => { events.push(event); } };
    try {
      const create = await createNamespaceTool({ name: "role-test-new", setDefault: false }, context);
      const remove = await deleteNamespaceTool({ name: "role-test-existing", confirm: true }, context);
      expect(create.reason).toBe("role");
      expect(remove.reason).toBe("role");
      expect(fs.existsSync(fresh)).toBe(false);
      expect(fs.readFileSync(path.join(existing, "sentinel"), "utf8")).toBe("keep");
      expect(events.map(e => e.reason)).toEqual(["role", "role"]);
    } finally {
      fs.rmSync(existing, { recursive: true, force: true });
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("refuses remember and forget before namespace creation or data access", async () => {
    const target = path.join(resolveNamespacesPath(), "role-test-new");
    const context = { principal: analyst };
    const remembered = await rememberTool({ key: "/test", domain: "concept", attributes: {}, embedding_text: "valid content", namespace: "role-test-new" }, context);
    const forgotten = await forgetTool({ id: "00000000-0000-4000-8000-000000000000", namespace: "role-test-new" }, context);
    expect(remembered.reason).toBe("role");
    expect(forgotten.reason).toBe("role");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("refuses analyst compaction even in dry-run mode", async () => {
    const result = await squashTool({ namespace: "role-test-existing", dryRun: true, aggressive: false }, { principal: analyst });
    expect(result.reason).toBe("role");
    expect(result.error).toMatch(/Forbidden/);
  });
});
