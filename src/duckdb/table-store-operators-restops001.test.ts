/**
 * REST-OPERATORS-001 — the table filter grammar, exercised through the
 * operations layer (the same functions the REST routes and the MCP
 * table_select tool call).
 *
 * What these cases are for:
 *   - fts / plfts: term-AND matching on a text column, with WORD BOUNDARIES.
 *     The falsifier is row r4 ("helloworld"): a `like.%hello%` shortcut would
 *     return it, an fts.hello filter must not.
 *   - isdistinct: NULL-SAFE comparison. qty=isdistinct.5 must return the row
 *     whose qty is NULL; eq/ne never can.
 *   - not.*: negation of any operator, applied to the whole predicate.
 *   - unknown operator: 400 naming the operator, the closest supported one
 *     and the full supported list — never a silently ignored filter.
 *   - injection: a search term carrying an apostrophe is a BOUND parameter,
 *     not SQL text.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { selectTableRows } from "../tables/operations";
import { invalidateNamespaceSchema } from "../serialization/schemaRegistry";
import { invalidateTableRegistry } from "../schema/table-registry";
import { resolveNamespacesPath } from "../config";

const NS = "rest-operators";

let tmpRoot = "";
let nsDir = "";
const originalNsPath = process.env.DUCKBRAIN_NAMESPACES_PATH;
const originalDurability = process.env.DUCKBRAIN_DURABILITY_MODE;

function schemaDocument(): unknown {
  return {
    schemaVersion: 1,
    tables: {
      notes: {
        schemaVersion: 1,
        storage: { path: "tables/notes/current.jsonl" },
        rowShape: "object",
        keyColumns: ["id"],
        columns: [
          { name: "id", type: "string", nullable: false },
          { name: "title", type: "string", nullable: true },
          { name: "qty", type: "int64", nullable: true },
          { name: "flag", type: "boolean", nullable: true },
        ],
      },
    },
    views: {},
  };
}

const NOTES = [
  JSON.stringify({ id: "r1", title: "hello world", qty: 5, flag: true }),
  JSON.stringify({ id: "r2", title: "world peace", qty: null, flag: false }),
  JSON.stringify({ id: "r3", title: "goodbye moon", qty: 5, flag: null }),
  // Substring control: contains "hello" inside a longer token.
  JSON.stringify({ id: "r4", title: "helloworld", qty: 9, flag: true }),
  JSON.stringify({ id: "r5", title: "o'brien report", qty: 1, flag: false }),
];

function writeNotes(): void {
  const file = path.join(nsDir, "tables", "notes", "current.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, NOTES.join("\n") + "\n");
}

function resetFixture(): void {
  fs.rmSync(path.join(nsDir, "tables"), { recursive: true, force: true });
  fs.writeFileSync(
    path.join(nsDir, "schema.json"),
    JSON.stringify(schemaDocument(), null, 2) + "\n",
  );
  writeNotes();
  invalidateNamespaceSchema(NS);
  invalidateTableRegistry(NS);
}

async function ids(filters: Record<string, string | string[]>): Promise<string[]> {
  const { rows } = await selectTableRows(NS, "notes", { filters, order: "id.asc" });
  return rows.map((row) => String((row as Record<string, unknown>).id));
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rest-operators-"));
  nsDir = path.join(tmpRoot, NS);
  fs.mkdirSync(nsDir, { recursive: true });
  process.env.DUCKBRAIN_NAMESPACES_PATH = tmpRoot;
  process.env.DUCKBRAIN_DURABILITY_MODE = "fsync";
  expect(resolveNamespacesPath()).toBe(path.resolve(tmpRoot));
  resetFixture();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (originalNsPath === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  else process.env.DUCKBRAIN_NAMESPACES_PATH = originalNsPath;
  if (originalDurability === undefined) delete process.env.DUCKBRAIN_DURABILITY_MODE;
  else process.env.DUCKBRAIN_DURABILITY_MODE = originalDurability;
});

beforeEach(() => {
  resetFixture();
});

describe("REST-OPERATORS-001 AC-2: fts / plfts", () => {
  it("fts matches whole tokens only — the substring row is NOT returned", async () => {
    expect(await ids({ title: "fts.hello" })).toEqual(["r1"]);
    // Same query as a LIKE would answer: proves the falsifier is live.
    expect(await ids({ title: "like.%hello%" })).toEqual(["r1", "r4"]);
  });

  it("fts ANDs a comma-separated term list", async () => {
    expect(await ids({ title: "fts.hello,world" })).toEqual(["r1"]);
    expect(await ids({ title: "fts.world" })).toEqual(["r1", "r2"]);
    expect(await ids({ title: "fts.hello,moon" })).toEqual([]);
  });

  it("plfts ANDs whitespace-separated words", async () => {
    expect(await ids({ title: "plfts.hello world" })).toEqual(["r1"]);
    expect(await ids({ title: "plfts.moon" })).toEqual(["r3"]);
    expect(await ids({ title: "plfts.moon world" })).toEqual([]);
  });

  it("is case-insensitive and treats a bound apostrophe as data", async () => {
    expect(await ids({ title: "fts.HELLO" })).toEqual(["r1"]);
    expect(await ids({ title: "fts.o'brien" })).toEqual(["r5"]);
  });

  it("rejects an empty term list and tsquery punctuation by name", async () => {
    await expect(ids({ title: "fts." })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("at least one search term"),
    });
    await expect(ids({ title: "fts.hello&world" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("boolean tsquery syntax"),
    });
  });
});

describe("REST-OPERATORS-001 AC-2: ordered comparisons on a DECLARED numeric column", () => {
  // Pre-fix control: these four used to fail the whole SELECT with a DuckDB
  // Binder Error ("Cannot compare values of type VARCHAR and type BIGINT"),
  // because a declared int64 column READS as canonical text while the
  // placeholder is typed BIGINT.
  it("gt / gte / lt / lte compare numerically, not lexicographically", async () => {
    expect(await ids({ qty: "gte.5" })).toEqual(["r1", "r3", "r4"]);
    expect(await ids({ qty: "gt.5" })).toEqual(["r4"]);
    expect(await ids({ qty: "lt.5" })).toEqual(["r5"]);
    expect(await ids({ qty: "lte.5" })).toEqual(["r1", "r3", "r5"]);
    // 9 > 10 is FALSE numerically and TRUE lexicographically — the control
    // that separates a numeric fix from a string one.
    expect(await ids({ qty: "gte.10" })).toEqual([]);
  });

  it("like / ilike keep working on a text column", async () => {
    expect(await ids({ title: "like.%moon" })).toEqual(["r3"]);
    expect(await ids({ title: "ilike.HELLO W%" })).toEqual(["r1"]);
    // ilike is case-insensitive LIKE, so the substring row still matches a
    // bare prefix — the control that separates ilike from fts.
    expect(await ids({ title: "ilike.HELLO%" })).toEqual(["r1", "r4"]);
  });
});

describe("REST-OPERATORS-001 AC-2: isdistinct / is", () => {
  it("isdistinct is NULL-safe: a NULL column is distinct from 5", async () => {
    expect(await ids({ qty: "isdistinct.5" })).toEqual(["r2", "r4", "r5"]);
    // eq.5 proves the opposite: NULLs never satisfy it.
    expect(await ids({ qty: "eq.5" })).toEqual(["r1", "r3"]);
    expect(await ids({ qty: "isdistinct.null" })).toEqual(["r1", "r3", "r4", "r5"]);
  });

  it("is.null / is.true / is.false select booleans and nulls", async () => {
    expect(await ids({ qty: "is.null" })).toEqual(["r2"]);
    expect(await ids({ flag: "is.true" })).toEqual(["r1", "r4"]);
    expect(await ids({ flag: "is.false" })).toEqual(["r2", "r5"]);
    expect(await ids({ flag: "not.is.null" })).toEqual(["r1", "r2", "r4", "r5"]);
    await expect(ids({ qty: "is.maybe" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("null|true|false"),
    });
  });
});

describe("REST-OPERATORS-001 AC-2/AC-3: not. negation and unknown operators", () => {
  it("not. negates any operator and keeps SQL NULL semantics", async () => {
    expect(await ids({ qty: "not.eq.5" })).toEqual(["r4", "r5"]);
    expect(await ids({ qty: "not.in.(5,9)" })).toEqual(["r5"]);
    expect(await ids({ qty: "not.gte.5" })).toEqual(["r5"]);
  });

  it("neq is an accepted synonym of ne", async () => {
    expect(await ids({ qty: "neq.5" })).toEqual(["r4", "r5"]);
  });

  it("an unknown operator 400s with the operator, the closest one and the list", async () => {
    const error = await ids({ qty: "gtq.5" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    const message = (error as Error).message;
    expect(message).toContain("Unknown filter operator 'gtq'");
    expect(message).toContain("closest supported: 'gt'");
    expect(message).toContain("supported: eq, ne, neq, gt");

    const between = await ids({ qty: "between.1" }).catch((e: unknown) => e);
    expect((between as Error).message).toContain("Unknown filter operator 'between'");
    // Never the silent-ignore failure mode: no rows came back, an error did.
    expect((between as Error).message).toContain("closest supported:");
  });
});
