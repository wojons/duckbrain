/**
 * SURFACE-MCP-DATA-001 live proof driver.
 *
 * Drives the MCP data plane from a REAL client over BOTH transports (stdio and
 * streamable HTTP /mcp) against a scratch daemon, and prints a transcript.
 * Nothing here touches :3000 or the repo's namespaces tree.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const PORT = process.env.PROOF_PORT;
const ROOT = process.env.PROOF_ROOT;
const KEY = process.env.PROOF_ADMIN_KEY;
const READ_KEY = process.env.PROOF_READER_KEY;
const NS = "mcp-proof";
const BIN = path.resolve("bin", "duckbrain.js");

function say(label, value) {
  console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}
function body(result) {
  const text = result?.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------- stdio ----
{
  console.log("=== [1] stdio transport (duckbrain stdio) ===");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, "stdio"],
    env: { ...process.env, DUCKBRAIN_NAMESPACES_PATH: ROOT, DUCKBRAIN_NAMESPACE: NS },
  });
  const client = new Client({ name: "surface-proof-stdio", version: "0.0.0" });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  say("tools/list data-plane", tools.filter((n) =>
    ["tables_declare","table_list","table_insert","table_select","table_update","table_delete","search","query"].includes(n)));
  say("tables_declare", body(await client.callTool({ name: "tables_declare", arguments: {
    namespace: NS, table: "widgets", primary: "id",
    columns: [{ name: "id", type: "integer" }, { name: "name", type: "varchar" }, { name: "qty", type: "integer" }],
  }})));
  say("table_insert (2 rows)", body(await client.callTool({ name: "table_insert", arguments: {
    namespace: NS, table: "widgets", rows: [{ id: 1, name: "alpha", qty: 5 }, { id: 2, name: "beta", qty: 9 }],
  }})));
  say("table_select qty=gte.6 order=id.asc count=exact", body(await client.callTool({ name: "table_select", arguments: {
    namespace: NS, table: "widgets", filters: { qty: "gte.6" }, order: "id.asc", count: "exact",
  }})));
  say("table_update pk=2", body(await client.callTool({ name: "table_update", arguments: {
    namespace: NS, table: "widgets", pk: 2, values: { name: "beta-2" },
  }})));
  say("table_delete pk=1", body(await client.callTool({ name: "table_delete", arguments: {
    namespace: NS, table: "widgets", pk: 1,
  }})));
  say("table_select (after delete)", body(await client.callTool({ name: "table_select", arguments: {
    namespace: NS, table: "widgets",
  }})));
  say("table_select undeclared table", body(await client.callTool({ name: "table_select", arguments: {
    namespace: NS, table: "no_such_table",
  }})));
  await client.close();
}

// ----------------------------------------------------------------- /mcp ----
{
  console.log("=== [2] streamable HTTP transport (POST /mcp) ===");
  const mk = async (key, label) => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      requestInit: { headers: { "X-API-Key": key } },
    });
    const client = new Client({ name: `surface-proof-${label}`, version: "0.0.0" });
    await client.connect(transport);
    return client;
  };
  const admin = { client: await mk(KEY, "admin") };
  say("tools/list over /mcp", (await admin.client.listTools()).tools.map((t) => t.name).filter((n) =>
    ["tables_declare","table_insert","table_select","table_update","table_delete","search","query"].includes(n)));
  say("remember (memory for search)", body(await admin.client.callTool({ name: "remember", arguments: {
    key: "/surface/mcp/live-proof", domain: "raw_note", attributes: {},
    embedding_text: "live proof zebra mcp data plane", namespace: NS,
  }})));
  // keyword search needs the rebuilt sidecar (documented for `duckbrain search`)
  execFileSync(process.execPath, [BIN, "search-index", "rebuild", `--namespace=${NS}`], {
    env: { ...process.env, DUCKBRAIN_NAMESPACES_PATH: ROOT, DUCKBRAIN_NAMESPACE: NS },
    stdio: "ignore",
  });
  say("search over /mcp", body(await admin.client.callTool({ name: "search", arguments: {
    namespace: NS, query: "zebra",
  }})));
  say("table_select over /mcp", body(await admin.client.callTool({ name: "table_select", arguments: {
    namespace: NS, table: "widgets", filters: { name: "eq.beta-2" },
  }})));
  say("tables_declare over /mcp", body(await admin.client.callTool({ name: "tables_declare", arguments: {
    namespace: NS, table: "http_items", primary: "sku",
    columns: [{ name: "sku", type: "varchar" }, { name: "title", type: "varchar" }],
  }})));
  say("table_insert over /mcp", body(await admin.client.callTool({ name: "table_insert", arguments: {
    namespace: NS, table: "http_items", rows: [{ sku: "a-1", title: "first" }, { sku: "b-2", title: "second" }],
  }})));
  say("table_update over /mcp", body(await admin.client.callTool({ name: "table_update", arguments: {
    namespace: NS, table: "http_items", pk: "b-2", values: { title: "second-edited" },
  }})));
  say("table_select http_items order=sku.asc", body(await admin.client.callTool({ name: "table_select", arguments: {
    namespace: NS, table: "http_items", order: "sku.asc",
  }})));
  say("table_delete over /mcp", body(await admin.client.callTool({ name: "table_delete", arguments: {
    namespace: NS, table: "http_items", pk: "a-1",
  }})));
  say("table_select http_items after delete", body(await admin.client.callTool({ name: "table_select", arguments: {
    namespace: NS, table: "http_items",
  }})));
  say("query SELECT over /mcp", body(await admin.client.callTool({ name: "query", arguments: {
    namespace: NS, sql: "SELECT count(*) AS n FROM memories",
  }})));
  await admin.client.close();

  const reader = { client: await mk(READ_KEY, "reader") };
  say("table_insert with read-only table grant", body(await reader.client.callTool({ name: "table_insert", arguments: {
    namespace: NS, table: "widgets", rows: [{ id: 3, name: "gamma", qty: 1 }],
  }})));
  say("table_select with read-only table grant", body(await reader.client.callTool({ name: "table_select", arguments: {
    namespace: NS, table: "widgets",
  }})));
  await reader.client.close();
}

// ------------------------------------------------------------- audit ------
{
  console.log("=== [3] namespace audit ledger (denials) ===");
  const auditFile = path.join(ROOT, NS, "_audit", "current.jsonl");
  const rows = fs.existsSync(auditFile)
    ? fs.readFileSync(auditFile, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const denials = rows.filter((r) => r.outcome === "denied");
  say("denial rows", denials.map((r) => ({ op: r.op, table: r.table, principal: r.principal, reason: r.reason })));
  say("accepted change records", rows.filter((r) => r.outcome === "accepted").map((r) => ({ op: r.op, table: r.table, tombstone: r.tombstone ?? false })));
}
