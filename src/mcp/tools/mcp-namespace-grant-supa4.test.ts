/**
 * DB-GAP-031 (MCP parity) regression tests: the MCP tool path must enforce the
 * token's per-namespace grant exactly like the REST routers do.
 *
 * The bug (observed 2026-10-02, card t_c772251b): a token minted with
 * `--namespace=<agent>,default` could write to an UNGRANTED namespace through
 * `POST /mcp` while the REST route refused the very same namespace with 403.
 * Cause: `requireNamespaceGrant` is mounted only on the REST routers
 * (src/http/routes/memories.ts, tables.ts, namespaces.ts). The /mcp transport
 * runs the auth middleware (so the principal exists and stamps the author) but
 * never evaluated the `namespaces` grant — the namespace lives only inside the
 * tool arguments on that path.
 *
 * Fix under test: `namespaceScopeViolation` (src/mcp/tools/shared.ts), called
 * by every namespace-scoped tool handler, returns the machine-readable refusal
 * (`success:false`, `reason:'namespace_scope'` — the SAME reason the REST path
 * audits, `code:'NAMESPACE_SCOPE'`) when the token has no grant for the
 * namespace the call would actually touch.
 *
 * Regressions guarded:
 *  (a) MCP `remember` outside the grant is refused and writes NOTHING (no
 *      namespace directory is even auto-created)
 *  (b) MCP `remember` inside the grant still succeeds and stamps the author
 *      from the token (author-stamping regression must stay intact)
 *  (c) MCP `recall` outside the grant is refused; inside the grant reads back
 *  (d) the refusal wins over the namespace-does-not-exist probe (a scoped
 *      token must not be able to probe foreign namespaces)
 *  (e) a scoped token may not use `allNamespaces` (REST refuses that too)
 *  (f) an UNRESTRICTED token (`namespaces` absent) and auth=none / stdio
 *      (no principal) are unchanged — no grant, no check
 *  (g) `forget`, `list_keys`, `squash` and `get_compaction_stats` — the other
 *      namespace-scoped MCP tools — refuse an ungranted namespace too, so the
 *      bypass class is closed rather than one hole patched
 *
 * Namespace storage and the config file are redirected to per-worker temp
 * dirs by src/test-setup.ts (DUCKBRAIN_NAMESPACES_PATH / DUCKBRAIN_CONFIG_PATH),
 * so the live store is never touched.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { rememberTool } from "./remember";
import { recallTool } from "./recall";
import { forgetTool } from "./forget";
import { listKeysTool } from "./list_keys";
import { squashTool, getCompactionStatsTool } from "./squash";
import { namespaceScopeViolation } from "./shared";
import { drainAsyncCommits } from "../../git/autocommit";
import type { AuthPrincipal } from "../../auth/middleware";

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;

/** A token scoped to `default` only — the card's `--namespace=<agent>,default` shape. */
const SCOPED: AuthPrincipal = {
  name: "scopeprobe",
  authenticated: true,
  tokenType: "apikey",
  roles: ["writer"],
  namespaces: ["default"],
};

/** A pre-DB-GAP-031 token: no `namespaces` field = unrestricted. */
const UNRESTRICTED: AuthPrincipal = {
  name: "adminprobe",
  authenticated: true,
  tokenType: "apikey",
  roles: ["admin"],
};

const created: string[] = [];

afterEach(async () => {
  // OPS-006: commits run off the event loop; let them settle before the tree
  // is removed (removing a namespace mid-commit leaves .git/ non-empty).
  await drainAsyncCommits();
  for (const name of created) {
    fs.rmSync(path.join(NS_ROOT, name), { recursive: true, force: true });
  }
  created.length = 0;
});

function memory(key: string, namespace: string) {
  return {
    key,
    domain: "concept" as const,
    attributes: { probe: "t_c772251b" },
    embedding_text: `mcp namespace grant probe ${key}`,
    namespace,
  };
}

describe("DB-GAP-031 MCP parity: remember", () => {
  it("refuses an ungranted namespace and writes nothing", async () => {
    created.push("infra");
    const result = await rememberTool(memory("/scope/probe/denied", "infra"), {
      principal: SCOPED,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe("namespace_scope");
    expect(result.code).toBe("NAMESPACE_SCOPE");
    expect(result.error).toContain("no grant for namespace 'infra'");
    // The refusal happens BEFORE the write path: the namespace is not even
    // auto-created (NAMESPACE-AUTOCREATE-001 would otherwise mkdir it).
    expect(fs.existsSync(path.join(NS_ROOT, "infra"))).toBe(false);
  });

  it("still writes inside the grant and stamps the token author", async () => {
    const result = await rememberTool(
      memory("/scope/probe/allowed", "default"),
      { principal: SCOPED },
    );

    expect(result.success).toBe(true);
    expect(result.namespace).toBe("default");
    // DOGFOOD-025 regression: the authenticated principal must keep stamping
    // the author; enforcement must not displace it.
    expect(result.author).toBe("scopeprobe@duckbrain.local");
  });

  it("does not restrict an unrestricted token or the auth=none path", async () => {
    const asAdmin = await rememberTool(
      memory("/scope/probe/admin", "test-ns"),
      { principal: UNRESTRICTED },
    );
    expect(asAdmin.success).toBe(true);

    // No principal at all = stdio / auth=none local mode: the legacy behavior
    // (git-config author fallback, no grant check) must be untouched.
    const local = await rememberTool(memory("/scope/probe/local", "default"));
    expect(local.success).toBe(true);
    expect(local.author).not.toBe("scopeprobe@duckbrain.local");
  });
});

describe("DB-GAP-031 MCP parity: recall", () => {
  it("refuses an ungranted namespace before the exists probe", async () => {
    // 'infra' does not exist on disk: the grant refusal must win, so a scoped
    // token cannot use the difference between 404 and 200 to probe namespaces.
    const result = await recallTool(
      { key: "/scope/probe/denied", namespace: "infra", limit: 5 },
      { principal: SCOPED },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe("namespace_scope");
    expect(result.code).toBe("NAMESPACE_SCOPE");
    expect(result.memories).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.error).not.toContain("does not exist");
  });

  it("reads back inside the grant", async () => {
    const written = await rememberTool(
      memory("/scope/probe/readback", "default"),
      { principal: SCOPED },
    );
    expect(written.success).toBe(true);

    const result = await recallTool(
      { key: "/scope/probe/readback", namespace: "default", limit: 5 },
      { principal: SCOPED },
    );
    expect(result.error).toBeUndefined();
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.memories.some((m) => m.key === "/scope/probe/readback")).toBe(
      true,
    );
  });

  it("refuses allNamespaces for a scoped token", async () => {
    const result = await recallTool(
      { key: "/scope/probe", allNamespaces: true, contains: "probe" },
      { principal: SCOPED },
    );
    expect(result.success).toBe(false);
    expect(result.reason).toBe("namespace_scope");
  });
});

describe("DB-GAP-031 MCP parity: the other namespace-scoped tools", () => {
  it("forget refuses an ungranted namespace", async () => {
    const result = await forgetTool(
      {
        id: "00000000-0000-4000-8000-000000000000",
        namespace: "infra",
      },
      { principal: SCOPED },
    );
    expect(result.success).toBe(false);
    expect(result.reason).toBe("namespace_scope");
    expect(result.error).toContain("no grant for namespace 'infra'");
  });

  it("list_keys refuses an ungranted namespace", async () => {
    const result = await listKeysTool(
      { prefix: "/", namespace: "infra" },
      { principal: SCOPED },
    );
    expect(result.success).toBe(false);
    expect(result.reason).toBe("namespace_scope");
    expect(result.keys).toEqual([]);
  });

  it("list_keys still answers inside the grant", async () => {
    const result = await listKeysTool(
      { prefix: "/", namespace: "default" },
      { principal: SCOPED },
    );
    expect(result.success).toBeUndefined(); // legacy success shape unchanged
    expect(result.reason).toBeUndefined();
    expect(Array.isArray(result.keys)).toBe(true);
  });

  it("squash and get_compaction_stats refuse an ungranted namespace", async () => {
    const squashed = await squashTool(
      { namespace: "infra", dryRun: false, aggressive: false },
      { principal: SCOPED },
    );
    expect(squashed.success).toBe(false);
    expect(squashed.reason).toBe("namespace_scope");

    const stats = await getCompactionStatsTool(
      { namespace: "infra" },
      { principal: SCOPED },
    );
    expect(stats.success).toBe(false);
    expect(stats.reason).toBe("namespace_scope");
  });
});

describe("namespaceScopeViolation helper contract", () => {
  it("is a no-op without a principal or without a namespaces field", () => {
    expect(namespaceScopeViolation(undefined, "infra")).toBeUndefined();
    expect(namespaceScopeViolation(UNRESTRICTED, "infra")).toBeUndefined();
  });

  it("names the token, the namespace, and the REST denial reason", () => {
    const violation = namespaceScopeViolation(SCOPED, "infra");
    expect(violation).toEqual({
      success: false,
      reason: "namespace_scope",
      code: "NAMESPACE_SCOPE",
      error: expect.stringContaining("scopeprobe"),
    });
  });

  it("allows every namespace listed in the grant", () => {
    const multi: AuthPrincipal = {
      ...SCOPED,
      name: "multi",
      namespaces: ["default", "infra"],
    };
    expect(namespaceScopeViolation(multi, "default")).toBeUndefined();
    expect(namespaceScopeViolation(multi, "infra")).toBeUndefined();
    expect(namespaceScopeViolation(multi, "other")).toBeDefined();
  });
});
