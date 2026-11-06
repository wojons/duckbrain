/**
 * REST-ATOMICITY-001 — upsert, transaction envelope, one-level embedding.
 *
 * Operations layer (the implementation the REST routes and the MCP tools
 * share). Every case runs against a real temp namespace with a real
 * `schema.json`, so the SUPA-6 declaration, the namespace write lock, the
 * durability barrier and the audit ledger are the production ones.
 *
 * The falsifiers the row's acceptance criteria name live here:
 *   - a THROW injected between two actions must leave every file byte-identical
 *     to its pre-envelope image (the "kill between actions" control);
 *   - an upsert applied twice must leave exactly ONE row for its key, and two
 *     concurrent upserts of one key must not duplicate it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  runTableTransaction,
  selectTableRows,
  upsertTableRow,
} from "./operations";
import { readAuditRows } from "../serialization/audit";
import {
  invalidateNamespaceSchema,
  loadNamespaceSchema,
} from "../serialization/schemaRegistry";
import { invalidateTableRegistry } from "../schema/table-registry";
import { resolveNamespacesPath } from "../config";

const NS = "rest-atomicity";

let tmpRoot = "";
let nsDir = "";
const originalNsPath = process.env.DUCKBRAIN_NAMESPACES_PATH;
const originalDurability = process.env.DUCKBRAIN_DURABILITY_MODE;

/** schema.json: two declared tables joined by a DECLARED reference. */
function schemaDocument(): unknown {
  return {
    schemaVersion: 1,
    tables: {
      customers: {
        schemaVersion: 1,
        storage: { path: "tables/customers/current.jsonl" },
        rowShape: "object",
        keyColumns: ["id"],
        columns: [
          { name: "id", type: "string", nullable: false },
          { name: "name", type: "string", nullable: false },
          { name: "tier", type: "string", nullable: true },
        ],
      },
      orders: {
        schemaVersion: 1,
        storage: { path: "tables/orders/current.jsonl" },
        rowShape: "object",
        keyColumns: ["id"],
        columns: [
          { name: "id", type: "string", nullable: false },
          {
            name: "customer_id",
            type: "string",
            nullable: true,
            references: { table: "customers", column: "id" },
          },
          { name: "total", type: "float64", nullable: false },
        ],
      },
    },
    views: {},
  };
}

const CUSTOMERS = ["c1", "c2"].map((id, index) =>
  JSON.stringify({ id, name: index === 0 ? "Ada" : "Grace", tier: "gold" }),
);
const ORDERS = [
  JSON.stringify({ id: "o1", customer_id: "c1", total: 10 }),
  JSON.stringify({ id: "o2", customer_id: "c2", total: 20 }),
  JSON.stringify({ id: "o3", customer_id: null, total: 30 }),
];

function writeFile(relative: string, lines: string[]): void {
  const file = path.join(nsDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

function resetFixture(): void {
  fs.rmSync(path.join(nsDir, "tables"), { recursive: true, force: true });
  fs.rmSync(path.join(nsDir, "_audit"), { recursive: true, force: true });
  fs.writeFileSync(
    path.join(nsDir, "schema.json"),
    JSON.stringify(schemaDocument(), null, 2) + "\n",
  );
  writeFile("tables/customers/current.jsonl", CUSTOMERS);
  writeFile("tables/orders/current.jsonl", ORDERS);
  invalidateNamespaceSchema(NS);
  invalidateTableRegistry(NS);
}

function readLines(relative: string): string[] {
  const file = path.join(nsDir, relative);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

function readRows(relative: string): Array<Record<string, unknown>> {
  return readLines(relative).map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rest-atomicity-"));
  nsDir = path.join(tmpRoot, NS);
  fs.mkdirSync(nsDir, { recursive: true });
  process.env.DUCKBRAIN_NAMESPACES_PATH = tmpRoot;
  // fsync so the envelope's single-barrier path is the one under test.
  process.env.DUCKBRAIN_DURABILITY_MODE = "fsync";
  expect(resolveNamespacesPath()).toBe(path.resolve(tmpRoot));
  resetFixture();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (originalNsPath === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  else process.env.DUCKBRAIN_NAMESPACES_PATH = originalNsPath;
  if (originalDurability === undefined)
    delete process.env.DUCKBRAIN_DURABILITY_MODE;
  else process.env.DUCKBRAIN_DURABILITY_MODE = originalDurability;
});

beforeEach(() => {
  resetFixture();
});

describe("REST-ATOMICITY-001 AC-1: upsert by primary key", () => {
  it("inserts when the key is absent and reports the branch plus the row", async () => {
    const result = await upsertTableRow(NS, "customers", "eq.c3", {
      name: "Linus",
      tier: "silver",
    });
    expect(result.outcome).toBe("inserted");
    expect(result.row).toEqual({ id: "c3", name: "Linus", tier: "silver" });
    const rows = readRows("tables/customers/current.jsonl");
    expect(rows.filter((row) => row.id === "c3")).toHaveLength(1);
  });

  it("replaces (does not append) when the key exists", async () => {
    const result = await upsertTableRow(NS, "customers", "eq.c2", {
      name: "Hopper",
      tier: "platinum",
    });
    expect(result.outcome).toBe("updated");
    expect(result.row).toEqual({ id: "c2", name: "Hopper", tier: "platinum" });
    const rows = readRows("tables/customers/current.jsonl");
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === "c2")).toEqual({
      id: "c2",
      name: "Hopper",
      tier: "platinum",
    });
  });

  it("never leaves two rows for one key: repeated upserts are idempotent", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await upsertTableRow(NS, "orders", "eq.o9", {
        customer_id: "c1",
        total: attempt,
      });
    }
    const rows = readRows("tables/orders/current.jsonl").filter(
      (row) => row.id === "o9",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.total).toBe(4);
  });

  it("serializes two concurrent upserts of the same key into ONE row", async () => {
    const [first, second] = await Promise.all([
      upsertTableRow(NS, "customers", "eq.c9", { name: "one" }),
      upsertTableRow(NS, "customers", "eq.c9", { name: "two" }),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual([
      "inserted",
      "updated",
    ]);
    const rows = readRows("tables/customers/current.jsonl").filter(
      (row) => row.id === "c9",
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses a body key that contradicts the resource key", async () => {
    await expect(
      upsertTableRow(NS, "customers", "eq.c1", { id: "c2", name: "Mismatch" }),
    ).rejects.toMatchObject({ status: 409, code: "PRIMARY_KEY_CONFLICT" });
    expect(readLines("tables/customers/current.jsonl")).toEqual(CUSTOMERS);
  });

  it("writes one change record for the accepted upsert", async () => {
    const before = readAuditRows(tmpRoot, NS).length;
    await upsertTableRow(NS, "orders", "eq.o9", { total: 1 });
    const after = readAuditRows(tmpRoot, NS);
    expect(after.length).toBe(before + 1);
    const record = after[after.length - 1]!;
    expect(record.op).toBe("insert");
    expect(record.table).toBe("orders");
    expect(record.outcome).toBe("accepted");
  });
});

describe("REST-ATOMICITY-001 AC-2: transaction envelope", () => {
  it("applies insert + update + delete as a unit", async () => {
    const outcome = await runTableTransaction(NS, [
      { op: "insert", table: "orders", row: { id: "o9", customer_id: "c2", total: 99 } },
      { op: "update", table: "customers", pk: "eq.c1", patch: { tier: "bronze" } },
      { op: "delete", table: "orders", pk: "eq.o3" },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.applied).toBe(3);
    expect(outcome.results.map((result) => result.outcome)).toEqual([
      "inserted",
      "updated",
      "deleted",
    ]);
    const orders = readRows("tables/orders/current.jsonl");
    expect(orders.map((row) => row.id)).toEqual(["o1", "o2", "o9"]);
    expect(readRows("tables/customers/current.jsonl").find((r) => r.id === "c1")).toEqual(
      { id: "c1", name: "Ada", tier: "bronze" },
    );
  });

  it("writes ONE change record per action", async () => {
    const before = readAuditRows(tmpRoot, NS).length;
    await runTableTransaction(NS, [
      { op: "insert", table: "orders", row: { id: "o9", total: 1 } },
      { op: "update", table: "orders", pk: "eq.o1", patch: { total: 11 } },
      { op: "delete", table: "orders", pk: "eq.o2" },
    ]);
    const records = readAuditRows(tmpRoot, NS).slice(before);
    expect(records.map((record) => record.op)).toEqual([
      "insert",
      "update",
      "delete",
    ]);
    expect(new Set(records.map((record) => record.targetPath))).toEqual(
      new Set(["tables/orders/current.jsonl"]),
    );
  });

  it("bars the envelope ONCE, not once per action", async () => {
    let barriers = 0;
    const outcome = await runTableTransaction(
      NS,
      [
        { op: "insert", table: "orders", row: { id: "o8", total: 1 } },
        { op: "insert", table: "orders", row: { id: "o9", total: 2 } },
        { op: "update", table: "customers", pk: "eq.c2", patch: { tier: "x" } },
      ],
      undefined,
      { hooks: { afterBarrier: () => { barriers += 1; } } },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(barriers).toBe(1);
    expect(outcome.durability.achieved).toBe("fsync");
  });

  it("FALSIFIER: a throw injected between actions rolls back every file", async () => {
    const ordersBefore = fs.readFileSync(
      path.join(nsDir, "tables/orders/current.jsonl"),
    );
    const customersBefore = fs.readFileSync(
      path.join(nsDir, "tables/customers/current.jsonl"),
    );
    const auditBefore = readAuditRows(tmpRoot, NS).length;

    const outcome = await runTableTransaction(
      NS,
      [
        { op: "insert", table: "orders", row: { id: "o9", total: 1 } },
        { op: "update", table: "customers", pk: "eq.c1", patch: { tier: "z" } },
        { op: "delete", table: "orders", pk: "eq.o1" },
      ],
      undefined,
      {
        hooks: {
          afterAction: (index) => {
            if (index === 0) throw new Error("injected failure between actions");
          },
        },
      },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failedAction).toBe(1);
    expect(outcome.applied).toBe(0);
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.message).toContain("injected failure between actions");
    // Byte-identical, not merely "row-count identical".
    expect(
      fs.readFileSync(path.join(nsDir, "tables/orders/current.jsonl")).equals(ordersBefore),
    ).toBe(true);
    expect(
      fs.readFileSync(path.join(nsDir, "tables/customers/current.jsonl")).equals(
        customersBefore,
      ),
    ).toBe(true);
    // No change record for an action that never became true.
    expect(readAuditRows(tmpRoot, NS).length).toBe(auditBefore);
  });

  it("FALSIFIER: a no-match update aborts the envelope and leaves no insert behind", async () => {
    const before = fs.readFileSync(path.join(nsDir, "tables/orders/current.jsonl"));
    const outcome = await runTableTransaction(NS, [
      { op: "insert", table: "orders", row: { id: "o9", total: 1 } },
      { op: "update", table: "orders", pk: "eq.nope", patch: { total: 2 } },
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failedAction).toBe(1);
    expect(outcome.status).toBe(404);
    expect(
      fs.readFileSync(path.join(nsDir, "tables/orders/current.jsonl")).equals(before),
    ).toBe(true);
    expect(readRows("tables/orders/current.jsonl").some((row) => row.id === "o9")).toBe(
      false,
    );
  });

  it("rejects a malformed envelope before writing anything", async () => {
    const before = readLines("tables/orders/current.jsonl");
    await expect(
      runTableTransaction(NS, [
        { op: "insert", table: "orders", row: { id: "o9", total: 1 } },
        { op: "teleport", table: "orders" },
      ]),
    ).rejects.toMatchObject({ status: 400 });
    expect(readLines("tables/orders/current.jsonl")).toEqual(before);
  });

  it("refuses a duplicate primary key inside one envelope", async () => {
    const outcome = await runTableTransaction(NS, [
      { op: "insert", table: "orders", row: { id: "o9", total: 1 } },
      { op: "insert", table: "orders", row: { id: "o9", total: 2 } },
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("PRIMARY_KEY_CONFLICT");
    expect(readRows("tables/orders/current.jsonl").some((row) => row.id === "o9")).toBe(
      false,
    );
  });

  it("upsert inside an envelope both inserts and replaces", async () => {
    const outcome = await runTableTransaction(NS, [
      { op: "upsert", table: "customers", pk: "eq.c1", row: { name: "Ada L." } },
      { op: "upsert", table: "customers", pk: "eq.c7", row: { name: "Ida" } },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.results.map((result) => result.outcome)).toEqual([
      "updated",
      "inserted",
    ]);
    const rows = readRows("tables/customers/current.jsonl");
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.id === "c1")!.name).toBe("Ada L.");
  });
});

describe("REST-ATOMICITY-001 AC-3: embedding over a DECLARED relation", () => {
  it("embeds the referenced row one level deep", async () => {
    const { rows } = await selectTableRows(NS, "orders", {
      embed: "customers",
      order: "id.asc",
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]!.customers).toEqual({ id: "c1", name: "Ada", tier: "gold" });
    // A null key embeds null, never an omission.
    expect(rows[2]).toHaveProperty("customers", null);
  });

  it("refuses an embed the table does not declare", async () => {
    await expect(
      selectTableRows(NS, "orders", { embed: "invoices" }),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
  });

  it("refuses a nested embed", async () => {
    await expect(
      selectTableRows(NS, "orders", { embed: ["customers.tier"] }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("REST-ATOMICITY-001 AC-3: the relation is a SUPA-6 DECLARATION", () => {
  /** Problems the loader reports for the schema.json currently on disk. */
  function schemaProblems(): string[] {
    invalidateNamespaceSchema(NS);
    invalidateTableRegistry(NS);
    const loaded = loadNamespaceSchema(NS);
    const error = loaded.error as { problems?: string[] } | null;
    return error?.problems ?? [];
  }

  it("rejects a reference to an undeclared table", async () => {
    const document = schemaDocument() as {
      tables: Record<string, { columns: Array<Record<string, unknown>> }>;
    };
    document.tables.orders!.columns[1]!.references = {
      table: "invoices",
      column: "id",
    };
    fs.writeFileSync(
      path.join(nsDir, "schema.json"),
      JSON.stringify(document, null, 2) + "\n",
    );
    const problems = schemaProblems();
    expect(problems.join(" ")).toContain(
      "table 'invoices' is not declared in this schema",
    );
  });

  it("rejects a relation to a non-key column", async () => {
    const document = schemaDocument() as {
      tables: Record<string, { columns: Array<Record<string, unknown>> }>;
    };
    document.tables.orders!.columns[1]!.references = {
      table: "customers",
      column: "name",
    };
    fs.writeFileSync(
      path.join(nsDir, "schema.json"),
      JSON.stringify(document, null, 2) + "\n",
    );
    const problems = schemaProblems();
    expect(problems.join(" ")).toContain(
      "'customers.name' must be the target's single key column",
    );
  });

  it("rejects a relation whose types disagree", async () => {
    const document = schemaDocument() as {
      tables: Record<string, { columns: Array<Record<string, unknown>> }>;
    };
    document.tables.orders!.columns[1]!.type = "int64";
    fs.writeFileSync(
      path.join(nsDir, "schema.json"),
      JSON.stringify(document, null, 2) + "\n",
    );
    const problems = schemaProblems();
    expect(problems.join(" ")).toContain("type mismatch");
  });

  it("keeps the declaration through a canonical re-render", async () => {
    const document = schemaDocument();
    const { formatSchemaDocument } = await import(
      "../serialization/schemaJson.js"
    );
    const rendered = formatSchemaDocument(
      document as Parameters<typeof formatSchemaDocument>[0],
    );
    expect(rendered).toContain('"references"');
    expect(JSON.parse(rendered)).toEqual(document);
  });
});
