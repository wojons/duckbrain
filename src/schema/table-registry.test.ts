/**
 * REG-GONE-002 — declared-table registry invalidation.
 *
 * The in-process registry cache used to live until process exit: an
 * out-of-band rewrite of `tables/<table>.table.json` stayed invisible to
 * GET /api/ns/:ns/tables until the daemon restarted, a failed scan could
 * poison the cache, and an empty namespace never picked up new declarations.
 * These tests pin the healed behavior: the registry re-stats the tables dir
 * per read (out-of-band writers), the in-process DDL path invalidates
 * explicitly, an empty scan heals when declarations appear, and a failed
 * listing is never cached.
 *
 * Follows the temp-dir namespace isolation pattern of
 * src/serialization/ddl-evolution.test.ts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { invalidateTableRegistry, listTables } from "./table-registry";
import {
  addColumn,
  createTable,
  type DdlCallOptions,
} from "../serialization/ddl";
import type { AuthPrincipal } from "../auth/middleware";

const EMPTY_NS = "rg2-empty";
const REWRITE_NS = "rg2-rewrite";
const DECLARE_NS = "rg2-declare";
const FLAKY_NS = "rg2-flaky";

const ADMIN: AuthPrincipal = {
  name: "admin-token",
  authenticated: true,
  roles: ["admin"],
};

let root = "";

function options(): DdlCallOptions {
  return {
    namespacesPath: root,
    principal: ADMIN,
    scheduleCommit: () => undefined,
  };
}

/** Write one legacy declaration file into a namespace's tables dir. */
function writeLegacyDeclaration(
  ns: string,
  file: string,
  declaration: Record<string, unknown>,
): void {
  const tablesDir = path.join(root, ns, "tables");
  fs.mkdirSync(tablesDir, { recursive: true });
  fs.writeFileSync(
    path.join(tablesDir, file),
    `${JSON.stringify(declaration, null, 2)}\n`,
  );
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rg2-registry-"));
  process.env.DUCKBRAIN_NAMESPACES_PATH = root;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DUCKBRAIN_NAMESPACES_PATH;
});

afterEach(() => {
  for (const ns of [EMPTY_NS, REWRITE_NS, DECLARE_NS, FLAKY_NS]) {
    invalidateTableRegistry(ns);
  }
});

describe("REG-GONE-002 declared-table registry invalidation", () => {
  it("t1: an out-of-band rewrite of the tables dir is visible without any manual invalidation", () => {
    writeLegacyDeclaration(REWRITE_NS, "widgets.table.json", {
      name: "widgets",
      format: "jsonl-objects",
      columns: [{ name: "id", type: "integer" }],
      primary: "id",
      glob: "widgets/current.jsonl",
    });

    // Warm the cache.
    expect(listTables(REWRITE_NS).map((t) => t.name)).toEqual(["widgets"]);

    // Out-of-band rewrite: a second table appears and the first gains a
    // column. No invalidation function is called.
    writeLegacyDeclaration(REWRITE_NS, "widgets.table.json", {
      name: "widgets",
      format: "jsonl-objects",
      columns: [
        { name: "id", type: "integer" },
        { name: "label", type: "varchar" },
      ],
      primary: "id",
      glob: "widgets/current.jsonl",
    });
    writeLegacyDeclaration(REWRITE_NS, "gadgets.table.json", {
      name: "gadgets",
      format: "jsonl-objects",
      columns: [{ name: "id", type: "bigint" }],
      primary: "id",
      glob: "gadgets/current.jsonl",
    });

    const tables = listTables(REWRITE_NS);
    expect(tables.map((t) => t.name).sort()).toEqual(["gadgets", "widgets"]);
    expect(
      tables.find((t) => t.name === "widgets")!.columns.map((c) => c.name),
    ).toEqual(["id", "label"]);
  });

  it("t2: an in-process declare is immediately visible through listTables", async () => {
    // A legacy declaration for the same name warms the cache AND, if the
    // cache were stale, its old columns would shadow the new schema.json
    // contract (legacy wins on a name conflict).
    writeLegacyDeclaration(DECLARE_NS, "widgets.table.json", {
      name: "widgets",
      format: "jsonl-objects",
      columns: [{ name: "id", type: "integer" }],
      primary: "id",
      glob: "widgets/current.jsonl",
    });
    expect(listTables(DECLARE_NS).map((t) => t.name)).toEqual(["widgets"]);

    // The legacy file goes away, then the SAME table is declared through the
    // real in-process DDL path.
    fs.rmSync(path.join(root, DECLARE_NS, "tables", "widgets.table.json"));
    const created = await createTable(
      DECLARE_NS,
      {
        table: "widgets",
        rowShape: "object",
        keyColumns: ["id"],
        storagePath: "widgets/current.jsonl",
        columns: [
          { name: "id", type: "string", nullable: false },
          { name: "score", type: "float64", nullable: false },
        ],
      },
      options(),
    );
    expect(created.ok).toBe(true);

    let columns = listTables(DECLARE_NS).find(
      (t) => t.name === "widgets",
    )!.columns;
    expect(columns.map((c) => c.name)).toEqual(["id", "score"]);

    // The evolve path must invalidate too.
    const added = await addColumn(
      DECLARE_NS,
      {
        table: "widgets",
        column: { name: "note", type: "string", nullable: true },
      },
      options(),
    );
    expect(added.ok).toBe(true);
    columns = listTables(DECLARE_NS).find((t) => t.name === "widgets")!.columns;
    expect(columns.map((c) => c.name)).toEqual(["id", "score", "note"]);
  });

  it("t3: a namespace cached with no declarations heals when a declaration appears", () => {
    // An existing-but-empty tables dir: the scan succeeds and caches the
    // empty set (the old null sentinel).
    fs.mkdirSync(path.join(root, EMPTY_NS, "tables"), { recursive: true });
    expect(listTables(EMPTY_NS)).toEqual([]);

    writeLegacyDeclaration(EMPTY_NS, "belated.table.json", {
      name: "belated",
      format: "jsonl-positional",
      columns: [{ name: "id", type: "bigint" }],
      primary: "id",
      glob: "belated/current.jsonl",
    });

    expect(listTables(EMPTY_NS).map((t) => t.name)).toEqual(["belated"]);
  });

  it("t4: a failed scan is not cached — the next read retries and heals", () => {
    writeLegacyDeclaration(FLAKY_NS, "late.table.json", {
      name: "late",
      format: "jsonl-objects",
      columns: [{ name: "id", type: "integer" }],
      primary: "id",
      glob: "late/current.jsonl",
    });
    const tablesDir = path.join(root, FLAKY_NS, "tables");

    fs.chmodSync(tablesDir, 0o000);
    try {
      // The listing itself fails: nothing may be cached from it.
      expect(listTables(FLAKY_NS)).toEqual([]);
    } finally {
      fs.chmodSync(tablesDir, 0o755);
    }

    // The retry succeeds — proof the failure was never cached.
    expect(listTables(FLAKY_NS).map((t) => t.name)).toEqual(["late"]);
  });
});
