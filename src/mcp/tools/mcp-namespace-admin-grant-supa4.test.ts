/**
 * Card t_369581ef: the MCP NAMESPACE-MANAGEMENT tools must grade the token's
 * namespace grant, and every MCP namespace refusal must land in the SUPA-4
 * denial audit sink.
 *
 * Found while closing t_c772251b (DB-GAP-031, MCP parity for the six
 * namespace-scoped DATA tools). The four management tools registered in
 * src/mcp/server.ts from src/mcp/tools/namespace.ts ran through the auth
 * middleware (so the principal existed) but never evaluated the grant:
 *
 *   create_namespace  -> POST   /api/namespaces          (REST: requireNamespaceGrant)
 *   delete_namespace  -> DELETE /api/namespaces/:name    (REST: requireNamespaceGrant)
 *   switch_namespace  -> POST   /api/namespaces/switch   (persists config defaultNamespace)
 *   list_namespaces   -> GET    /api/namespaces          (enumerates every namespace)
 *
 * The transports disagreed in the destructive direction: REST answered 403 for
 * the same token + namespace while /mcp created or deleted it. Second gap:
 * the DB-GAP-031 refusals returned the right payload but wrote NO denial audit
 * row, violating SUPA-4 ("audit-every-denial"): the REST path audits through
 * `createDenialAuditor` attached to the Express request; the MCP tool handlers
 * had no way to reach that sink.
 *
 * Regressions guarded here:
 *  (a) create_namespace outside the grant is refused and creates NOTHING
 *      (no directory, no config mapping)
 *  (b) delete_namespace outside the grant is refused and deletes NOTHING
 *      (the refusal wins over the shared core's "not found" answer)
 *  (c) switch_namespace outside the grant is refused and does NOT persist a
 *      new config defaultNamespace
 *  (d) every refusal is recorded through the request-scoped denial auditor
 *      (reason 'namespace_scope', the same reason REST audits)
 *  (e) list_namespaces does not ENUMERATE namespaces outside the grant
 *  (f) inside the grant, and for unrestricted tokens / auth=none (no
 *      principal), today's behavior is unchanged
 *
 * Namespace storage and the config file are redirected to per-worker temp
 * dirs by src/test-setup.ts (DUCKBRAIN_NAMESPACES_PATH / DUCKBRAIN_CONFIG_PATH),
 * so the live store is never touched.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  createNamespaceTool,
  deleteNamespaceTool,
  listNamespacesTool,
  switchNamespaceTool,
} from "./namespace";
import { getConfig, resolveDuckbrainRoot, resolveNamespacesPath, updateConfig } from "../../config/index";
import { lifecycleLogPath } from "../../namespaces/lifecycle";
import { drainAsyncCommits } from "../../git/autocommit";
import type { AuthPrincipal, DenialAuditEvent } from "../../auth/middleware";

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const CFG_ROOT = resolveDuckbrainRoot();

/** The card's `--namespace=<agent>,default` shape, plus two mutable names. */
const SCOPED: AuthPrincipal = {
  name: "scopeprobe",
  authenticated: true,
  tokenType: "apikey",
  roles: ["writer"],
  namespaces: ["default", "writable", "deletable"],
};

/** A pre-DB-GAP-031 token: no `namespaces` field = unrestricted. */
const UNRESTRICTED: AuthPrincipal = {
  name: "adminprobe",
  authenticated: true,
  tokenType: "apikey",
  roles: ["admin"],
};

const created: string[] = [];

/** In-memory stand-in for the request-scoped `createDenialAuditor` sink. */
function recorder() {
  const events: DenialAuditEvent[] = [];
  return {
    events,
    auditDenial: (event: DenialAuditEvent) => {
      events.push(event);
    },
  };
}

function mkdir(name: string): string {
  const target = path.join(NS_ROOT, name);
  fs.mkdirSync(target, { recursive: true });
  created.push(name);
  return target;
}

beforeEach(() => {
  // Deterministic active namespace for every case in this file.
  updateConfig(CFG_ROOT, { defaultNamespace: "default" });
});

afterEach(async () => {
  await drainAsyncCommits();
  for (const name of created) {
    fs.rmSync(path.join(NS_ROOT, name), { recursive: true, force: true });
  }
  created.length = 0;
  updateConfig(CFG_ROOT, { defaultNamespace: "default" });
});

describe("card t_369581ef: create_namespace enforces the grant", () => {
  it("refuses an ungranted namespace and creates nothing", async () => {
    const result = await createNamespaceTool(
      { name: "infra", setDefault: false },
      { principal: SCOPED },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe("namespace_scope");
    expect(result.code).toBe("NAMESPACE_SCOPE");
    expect(result.error).toContain("no grant for namespace 'infra'");
    // Nothing was created — not even the directory.
    expect(fs.existsSync(path.join(NS_ROOT, "infra"))).toBe(false);
  });

  it("still creates inside the grant", async () => {
    created.push("writable");
    const result = await createNamespaceTool(
      { name: "writable", setDefault: false },
      { principal: SCOPED },
    );

    expect(result.success).toBe(true);
    expect(result.path).toBe(path.join(NS_ROOT, "writable"));
    expect(fs.existsSync(path.join(NS_ROOT, "writable"))).toBe(true);
  });

  it("does not restrict an unrestricted token or the auth=none path", async () => {
    created.push("admin-ns");
    const asAdmin = await createNamespaceTool(
      { name: "admin-ns", setDefault: false },
      { principal: UNRESTRICTED },
    );
    expect(asAdmin.success).toBe(true);

    // No principal at all = stdio / auth=none local mode: unchanged.
    created.push("local-ns");
    const local = await createNamespaceTool({
      name: "local-ns",
      setDefault: false,
    });
    expect(local.success).toBe(true);
  });
});

describe("card t_369581ef: delete_namespace enforces the grant", () => {
  it("refuses an ungranted namespace and deletes nothing", async () => {
    const target = mkdir("infra");

    const result = await deleteNamespaceTool(
      { name: "infra", confirm: true },
      { principal: SCOPED },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe("namespace_scope");
    expect(result.code).toBe("NAMESPACE_SCOPE");
    // The refusal wins over the shared core's own answer, and the directory
    // (with its git history) is untouched.
    expect(result.error).not.toContain("not found");
    expect(fs.existsSync(target)).toBe(true);

    // DF-0923-02 keeps holding: a refused MCP delete still appends its
    // lifecycle line (success:false) alongside the SUPA-4 denial row.
    const lifecycle = fs.readFileSync(
      lifecycleLogPath(resolveNamespacesPath()),
      "utf-8",
    );
    expect(lifecycle).toContain("delete-from-disk");
    expect(lifecycle).toContain("no grant for namespace 'infra'");
  });

  it("still deletes inside the grant", async () => {
    // Registered + on disk, like a real namespace (the shared deletion core
    // resolves the mapping, not a path joined from the name).
    const setup = await createNamespaceTool(
      { name: "deletable", setDefault: false },
      { principal: SCOPED },
    );
    expect(setup.success).toBe(true);
    const target = path.join(NS_ROOT, "deletable");

    const result = await deleteNamespaceTool(
      { name: "deletable", confirm: true },
      { principal: SCOPED },
    );

    expect(result.success).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe("card t_369581ef: switch_namespace enforces the grant", () => {
  it("refuses an ungranted namespace and leaves the active default unchanged", async () => {
    mkdir("infra");

    const result = await switchNamespaceTool(
      { name: "infra" },
      { principal: SCOPED },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe("namespace_scope");
    expect(result.error).toContain("no grant for namespace 'infra'");
    // The tool persists config defaultNamespace — a refused switch must not.
    expect(getConfig(CFG_ROOT).defaultNamespace).toBe("default");
  });

  it("still switches inside the grant", async () => {
    mkdir("writable");

    const result = await switchNamespaceTool(
      { name: "writable" },
      { principal: SCOPED },
    );

    expect(result.success).toBe(true);
    expect(result.current).toBe("writable");
    expect(getConfig(CFG_ROOT).defaultNamespace).toBe("writable");
  });
});

describe("card t_369581ef: list_namespaces does not leak the grant", () => {
  it("enumerates only the granted namespaces for a scoped token", async () => {
    mkdir("infra");

    const scoped = await listNamespacesTool({}, { principal: SCOPED });
    expect(scoped.success).toBe(true);
    const names = scoped.namespaces.map((ns) => ns.name);
    expect(names).toContain("default");
    expect(names).not.toContain("infra");

    // Every listed row is inside the grant.
    expect(names.every((name) => SCOPED.namespaces!.includes(name))).toBe(true);
  });

  it("omits a currentNamespace outside the grant", async () => {
    mkdir("infra");
    updateConfig(CFG_ROOT, { defaultNamespace: "infra" });

    const scoped = await listNamespacesTool({}, { principal: SCOPED });
    expect(scoped.namespaces.map((ns) => ns.name)).not.toContain("infra");
    expect(scoped.currentNamespace).toBeUndefined();

    // Unrestricted tokens keep the full listing unchanged.
    const unrestricted = await listNamespacesTool({}, {
      principal: UNRESTRICTED,
    });
    expect(unrestricted.namespaces.map((ns) => ns.name)).toContain("infra");
    expect(unrestricted.currentNamespace).toBe("infra");
  });
});

describe("card t_369581ef: SUPA-4 denial audit on the MCP path", () => {
  it("records a namespace_scope denial for each refused management tool", async () => {
    const sink = recorder();
    mkdir("infra");

    const create = await createNamespaceTool(
      { name: "infra", setDefault: false },
      { principal: SCOPED, auditDenial: sink.auditDenial },
    );
    const remove = await deleteNamespaceTool(
      { name: "infra", confirm: true },
      { principal: SCOPED, auditDenial: sink.auditDenial },
    );
    const move = await switchNamespaceTool(
      { name: "infra" },
      { principal: SCOPED, auditDenial: sink.auditDenial },
    );

    expect(create.reason).toBe("namespace_scope");
    expect(remove.reason).toBe("namespace_scope");
    expect(move.reason).toBe("namespace_scope");

    expect(sink.events).toHaveLength(3);
    for (const event of sink.events) {
      expect(event).toMatchObject({
        ns: "infra",
        op: "namespace.access",
        principal: "scopeprobe",
        outcome: "denied",
        reason: "namespace_scope",
      });
      expect(typeof event.ts).toBe("string");
    }
  });

  it("audits nothing when the call is allowed or unrestricted", async () => {
    const sink = recorder();
    created.push("writable");

    await createNamespaceTool(
      { name: "writable", setDefault: false },
      { principal: SCOPED, auditDenial: sink.auditDenial },
    );
    await listNamespacesTool({}, {
      principal: SCOPED,
      auditDenial: sink.auditDenial,
    });
    created.push("admin-ns");
    await createNamespaceTool(
      { name: "admin-ns", setDefault: false },
      { principal: UNRESTRICTED, auditDenial: sink.auditDenial },
    );

    expect(sink.events).toEqual([]);
  });

  it("survives a throwing audit sink (auditing never changes the refusal)", async () => {
    const result = await createNamespaceTool(
      { name: "infra", setDefault: false },
      {
        principal: SCOPED,
        auditDenial: () => {
          throw new Error("audit sink down");
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe("namespace_scope");
  });
});
