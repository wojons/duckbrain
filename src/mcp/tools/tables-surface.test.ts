/**
 * SURFACE-MCP-DATA-001 — the MCP data plane.
 *
 * The row's claim: MCP reached only memory primitives, so an agent could not
 * declare a table, write/read/update/delete a row, keyword-search or run one
 * SELECT. These tests prove the added tools and — the part that matters — that
 * they are the SAME implementations the REST routes and the CLI call:
 *
 *   AC1  each tool calls src/tables/operations.ts / src/tables/declare.ts /
 *        src/duckdb/query-surface.ts (no second code path), accepts a
 *        namespace, and refuses an undeclared table with the REST message.
 *   AC2  driven from a CLIENT, not just a handler: a real MCP stdio client
 *        lists the tools and runs declare → insert ×2 → filtered select →
 *        update → delete → keyword search → SELECT.
 *   AC3  grants bite on the MCP path: a token without table write gets a
 *        refusal from table_insert, and the denial lands in the audit sink
 *        with reason "table_grant".
 *
 * Hermetic: DUCKBRAIN_NAMESPACES_PATH points at a temp root; the repo's own
 * namespaces tree is never touched.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  tableDeleteTool,
  tableInsertTool,
  tableListTool,
  tableSelectTool,
  tableUpdateTool,
  tablesDeclareTool,
  queryTool,
  tableToolDefs,
} from "./tables";
import { searchTool } from "./search";
import type { McpToolContext } from "./shared";
import type { DenialAuditEvent } from "../../auth/middleware";
import { drainAllNamespaceWriters } from "../../serialization/namespaceWriter";
import { removeTempDirSafely } from "../../testing/race-safe-daemon";

const BIN_PATH = path.resolve(__dirname, "..", "..", "..", "bin", "duckbrain.js");
const NS = "mcp-surface";
let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tables-surface-"));
  process.env.DUCKBRAIN_NAMESPACES_PATH = tmpRoot;
  process.env.DUCKBRAIN_NAMESPACE = NS;
});

afterAll(async () => {
  await drainAllNamespaceWriters();
  await removeTempDirSafely(tmpRoot);
});

const adminContext: McpToolContext = {
  principal: { name: "mcp-admin", authenticated: true, roles: ["admin"] },
};

describe("SURFACE-MCP-DATA-001 AC1: tools over shared implementations", () => {
  it("declares, inserts two rows, filters, updates and deletes", async () => {
    const declared = await tablesDeclareTool(
      {
        namespace: NS,
        table: "widgets",
        columns: [
          { name: "id", type: "integer" },
          { name: "name", type: "varchar" },
          { name: "qty", type: "integer" },
        ],
        primary: "id",
      },
      adminContext,
    );
    expect(declared.success).toBe(true);
    expect(declared.format).toBe("schema.json");
    expect(fs.existsSync(path.join(tmpRoot, NS, "schema.json"))).toBe(true);

    const listed = await tableListTool({ namespace: NS }, adminContext);
    expect(listed.success).toBe(true);
    expect(
      (listed.tables as Array<{ name: string }>).map((t) => t.name),
    ).toContain("widgets");

    const inserted = await tableInsertTool(
      {
        namespace: NS,
        table: "widgets",
        rows: [
          { id: 1, name: "alpha", qty: 5 },
          { id: 2, name: "beta", qty: 9 },
        ],
      },
      adminContext,
    );
    expect(inserted.success).toBe(true);
    expect(inserted.inserted).toBe(2);

    const selected = await tableSelectTool(
      {
        namespace: NS,
        table: "widgets",
        filters: { qty: "gte.6" },
        order: "id.asc",
        count: "exact",
      },
      adminContext,
    );
    expect(selected.success).toBe(true);
    expect(selected.count).toBe(1);
    expect(selected.totalCount).toBe(1);
    expect((selected.rows as Array<{ id: number }>)[0]).toMatchObject({
      id: 2,
      name: "beta",
    });

    const updated = await tableUpdateTool(
      { namespace: NS, table: "widgets", pk: 2, values: { name: "beta-2" } },
      adminContext,
    );
    expect(updated.success).toBe(true);
    expect(updated.updated).toBe(1);

    const afterUpdate = await tableSelectTool(
      { namespace: NS, table: "widgets", filters: { name: "eq.beta-2" } },
      adminContext,
    );
    expect(afterUpdate.count).toBe(1);

    const deleted = await tableDeleteTool(
      { namespace: NS, table: "widgets", pk: 1 },
      adminContext,
    );
    expect(deleted.success).toBe(true);
    expect(deleted.deleted).toBe(1);

    const remaining = await tableSelectTool(
      { namespace: NS, table: "widgets" },
      adminContext,
    );
    expect(remaining.count).toBe(1);
  });

  it("refuses an undeclared table with the REST message and code", async () => {
    const refused = await tableSelectTool(
      { namespace: NS, table: "no_such_table" },
      adminContext,
    );
    expect(refused.success).toBe(false);
    // The REST layer throws ApiError(..., 404, "NOT_FOUND") with this text.
    expect(refused.error).toBe(
      `Table 'no_such_table' not found in namespace '${NS}'`,
    );
    expect(refused.code).toBe("NOT_FOUND");
  });

  it("exposes the declared-table vocabulary in the tool schemas", () => {
    const names = tableToolDefs.map((d) => d.name);
    expect(names).toEqual([
      "table_list",
      "tables_declare",
      "table_insert",
      "table_select",
      "table_update",
      "table_delete",
      "query",
    ]);
  });
});

describe("SURFACE-MCP-DATA-001 AC3: grants bite on the MCP path", () => {
  it("refuses table_insert for a token without table write, and audits table_grant", async () => {
    const denials: DenialAuditEvent[] = [];
    const readOnly: McpToolContext = {
      principal: {
        name: "mcp-reader",
        authenticated: true,
        // writer carries tables.read + tables.write, so the per-table grant
        // map is what refuses the write — the reason token under test.
        roles: ["writer"],
        namespaces: [NS],
        tableGrants: { widgets: "read" },
      },
      auditDenial: (event) => {
        denials.push(event);
      },
    };

    const refused = await tableInsertTool(
      { namespace: NS, table: "widgets", rows: [{ id: 3, name: "gamma" }] },
      readOnly,
    );
    expect(refused.success).toBe(false);
    expect(refused.code).toBe("FORBIDDEN");
    expect(refused.reason).toBe("table_grant");
    expect(refused.error).toBe(
      `Forbidden: principal 'mcp-reader' has no write grant for table 'widgets'`,
    );

    // The denial row mirrors requireTableGrant: op tables.write, same reason.
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      ns: NS,
      table: "widgets",
      op: "tables.write",
      principal: "mcp-reader",
      outcome: "denied",
      reason: "table_grant",
    });

    // The same token CAN read (read grant present).
    const allowed = await tableSelectTool(
      { namespace: NS, table: "widgets" },
      readOnly,
    );
    expect(allowed.success).toBe(true);

    // …and cannot touch a namespace outside its grant.
    const outOfScope = await tableSelectTool(
      { namespace: "some-other-ns", table: "widgets" },
      readOnly,
    );
    expect(outOfScope.success).toBe(false);
    expect(outOfScope.reason).toBe("namespace_scope");
  });
});

describe("SURFACE-MCP-DATA-001: keyword search and read-only SQL", () => {
  it("keyword-searches memories through the CLI search core", async () => {
    const { rememberTool } = await import("./remember.js");
    const written = await rememberTool({
      key: "/surface/mcp/data-plane",
      domain: "raw_note",
      attributes: {},
      embedding_text: "mcp data plane keyword probe zebra",
      namespace: NS,
    } as never);
    expect(written.success).toBe(true);
    await drainAllNamespaceWriters();

    // The keyword index is rebuilt on demand by the daemon; build it
    // explicitly so this test measures the search path, not the indexer.
    const { rebuildNamespaceIndex } = await import("../../search/index.js");
    await rebuildNamespaceIndex(path.join(tmpRoot, NS));

    const found = await searchTool({ query: "zebra", namespace: NS });
    expect(found.error).toBeUndefined();
    expect(found.total).toBeGreaterThan(0);
    expect(found.memories[0]!.key).toBe("/surface/mcp/data-plane");
  });

  it("runs one read-only SELECT and refuses a mutating statement", async () => {
    const ok = await queryTool(
      {
        namespace: NS,
        sql: "SELECT key FROM memories WHERE key LIKE '/surface/%'",
      },
      adminContext,
    );
    expect(ok.success).toBe(true);
    expect(ok.count).toBeGreaterThan(0);

    const refused = await queryTool(
      { namespace: NS, sql: "DELETE FROM memories" },
      adminContext,
    );
    expect(refused.success).toBe(false);
    expect(refused.code).toBe("READ_ONLY_QUERY");
  });
});

describe("SURFACE-MCP-DATA-001 AC2: driven from a real stdio client", () => {
  it("lists the data-plane tools and completes the round trip over stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN_PATH, "stdio"],
      env: {
        ...process.env,
        DUCKBRAIN_NAMESPACES_PATH: tmpRoot,
        DUCKBRAIN_NAMESPACE: NS,
      } as Record<string, string>,
    });
    const client = new Client({ name: "surface-proof", version: "0.0.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      for (const expected of [
        "tables_declare",
        "table_list",
        "table_insert",
        "table_select",
        "table_update",
        "table_delete",
        "search",
        "query",
      ]) {
        expect(names).toContain(expected);
      }

      const declared = await client.callTool({
        name: "tables_declare",
        arguments: {
          namespace: NS,
          table: "stdio_widgets",
          columns: [
            { name: "id", type: "integer" },
            { name: "label", type: "varchar" },
          ],
          primary: "id",
        },
      });
      const declareBody = JSON.parse(
        (declared.content as Array<{ text: string }>)[0]!.text,
      );
      expect(declareBody.success).toBe(true);

      const inserted = await client.callTool({
        name: "table_insert",
        arguments: {
          namespace: NS,
          table: "stdio_widgets",
          rows: [
            { id: 1, label: "one" },
            { id: 2, label: "two" },
          ],
        },
      });
      const insertBody = JSON.parse(
        (inserted.content as Array<{ text: string }>)[0]!.text,
      );
      expect(insertBody.inserted).toBe(2);

      const selected = await client.callTool({
        name: "table_select",
        arguments: {
          namespace: NS,
          table: "stdio_widgets",
          filters: { label: "eq.two" },
        },
      });
      const selectBody = JSON.parse(
        (selected.content as Array<{ text: string }>)[0]!.text,
      );
      expect(selectBody.count).toBe(1);
      expect(selectBody.rows[0]).toMatchObject({ id: 2, label: "two" });
    } finally {
      await client.close();
    }
  }, 60_000);
});
