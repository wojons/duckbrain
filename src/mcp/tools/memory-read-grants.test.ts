import { beforeAll, describe, expect, it } from "vitest";
import { rememberTool } from "./remember";
import { recallTool } from "./recall";
import { listKeysTool } from "./list_keys";
import type { AuthPrincipal } from "../../auth/middleware";

const ns = "read-grant-fixture";
const actor = (tableGrants?: AuthPrincipal["tableGrants"], roles: AuthPrincipal["roles"] = ["writer"]): AuthPrincipal => ({
  name: "reader", authenticated: true, tokenType: "apikey", roles, ...(tableGrants === undefined ? {} : { tableGrants }),
});

beforeAll(async () => {
  const result = await rememberTool({ namespace: ns, key: "/secret/key", domain: "concept", attributes: {}, embedding_text: "secret fixture" });
  expect(result.success).toBe(true);
});

describe("memory read grant enforcement", () => {
  it.each([{}, { memories: "write" as const }])("denies recall and keys with non-read grants %o", async (grants) => {
    const audit: unknown[] = [];
    const context = { principal: actor(grants), auditDenial: (event: unknown) => { audit.push(event); } };
    for (const input of [{ namespace: ns }, { namespace: ns, key: "/secret/key" }, { namespace: ns, contains: "secret" }, { contains: "secret", allNamespaces: true }]) {
      const result = await recallTool(input, context);
      expect(result).toMatchObject({ success: false, code: "FORBIDDEN", reason: "table_grant", memories: [] });
    }
    expect(await listKeysTool({ namespace: ns }, context)).toMatchObject({ success: false, code: "FORBIDDEN", reason: "table_grant", keys: [] });
    expect(audit).toHaveLength(5);
    expect(audit[0]).toMatchObject({ op: "tables.read", table: "memories", reason: "table_grant", principal: "reader" });
  });

  it.each(["read", "rw"] as const)("permits explicit %s grants", async (grant) => {
    const context = { principal: actor({ memories: grant }) };
    expect((await recallTool({ namespace: ns, key: "/secret/key" }, context)).count).toBe(1);
    expect((await listKeysTool({ namespace: ns }, context)).keys).toContain("/secret/key");
  });

  it("preserves legacy, admin and local behavior while denying empty roles", async () => {
    for (const context of [{}, { principal: actor(undefined) }, { principal: actor({}, ["admin"]) }]) {
      expect((await recallTool({ namespace: ns, key: "/secret/key" }, context)).count).toBe(1);
    }
    expect(await listKeysTool({ namespace: ns }, { principal: actor(undefined, []) })).toMatchObject({ success: false, reason: "role", keys: [] });
  });

  it("checks namespace scope first, including allNamespaces", async () => {
    const principal = { ...actor({}), namespaces: [ns] };
    expect(await recallTool({ namespace: "other" }, { principal })).toMatchObject({ reason: "namespace_scope", memories: [] });
    expect(await listKeysTool({ namespace: "other" }, { principal })).toMatchObject({ reason: "namespace_scope", keys: [] });
    expect(await recallTool({ allNamespaces: true, contains: "secret" }, { principal })).toMatchObject({ reason: "namespace_scope", memories: [] });
  });
});
