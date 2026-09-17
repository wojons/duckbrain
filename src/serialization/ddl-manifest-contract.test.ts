/**
 * DB-SUPA-6 AC-2 — `schema.json` and `manifest.json` keep separate ownership.
 *
 * `schema.json` carries only logical declarations; `manifest.json` stays the
 * physical partition index (`partitions` + `lastUpdated`) with its own atomic
 * writer. A declared storage path is NOT automatically a manifest partition:
 * the DDL adds the parent partition only when the path conforms to the storage
 * partition layout AND its first data file exists, and it never deletes or
 * rebuilds manifest entries because a schema was re-declared.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { addColumn, createTable, type DdlCallOptions } from "./ddl";
import type { AuthPrincipal } from "../auth/middleware";
import { getNamespaceWriter } from "./namespaceWriter";
import {
  getTable,
  invalidateTableRegistry,
  namespaceDir,
} from "../schema/table-registry";
import { buildSelectPlan, executeSelectPlan } from "../duckdb/table-store";

const NS = "supa6-manifest";
const ADMIN: AuthPrincipal = {
  name: "admin-token",
  authenticated: true,
  roles: ["admin"],
};

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supa6-manifest-"));
  roots.push(root);
  process.env.DUCKBRAIN_NAMESPACES_PATH = root;
  return root;
}

function options(root: string): DdlCallOptions {
  return {
    namespacesPath: root,
    principal: ADMIN,
    scheduleCommit: () => undefined,
  };
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

afterEach(() => {
  invalidateTableRegistry(NS);
  while (roots.length > 0)
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  delete process.env.DUCKBRAIN_NAMESPACES_PATH;
});

describe("SUPA-6 schema/manifest separation", () => {
  it("schema and manifest retain separate ownership", async () => {
    const root = makeRoot();
    const nsDir = path.join(root, NS);
    fs.mkdirSync(path.join(nsDir, "events", "2026-09"), { recursive: true });
    // A pre-existing physical partition (owned by storage, not by DDL).
    fs.writeFileSync(
      path.join(nsDir, "manifest.json"),
      `${JSON.stringify({ partitions: ["concept/2026-08/"], lastUpdated: "2026-08-01T00:00:00.000Z" }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(nsDir, "events", "2026-09", "current.jsonl"),
      `${JSON.stringify({ id: "e1", kind: "click" })}\n`,
    );

    // Table A: conforming partition layout WITH an existing first data file →
    // the coordinator adds the parent partition after the switch (bookkeeping).
    const conforming = await createTable(
      NS,
      {
        table: "events",
        rowShape: "object",
        keyColumns: ["id"],
        storagePath: "events/2026-09/current.jsonl",
        columns: [
          { name: "id", type: "string", nullable: false },
          { name: "kind", type: "string", nullable: false },
        ],
      },
      options(root),
    );
    expect(conforming.ok).toBe(true);

    const manifestAfterConforming = readJson(
      path.join(nsDir, "manifest.json"),
    ) as { partitions: string[]; lastUpdated: string };
    expect(Object.keys(manifestAfterConforming).sort()).toEqual([
      "lastUpdated",
      "partitions",
    ]);
    expect(manifestAfterConforming.partitions).toContain("concept/2026-08/");
    expect(manifestAfterConforming.partitions).toContain("events/2026-09/");

    // Table B: non-conforming path, no data file → NO manifest entry, even
    // though the table is declared.
    const nonConforming = await createTable(
      NS,
      {
        table: "scores",
        rowShape: "object",
        keyColumns: ["id"],
        storagePath: "tables/scores/current.jsonl",
        columns: [
          { name: "id", type: "string", nullable: false },
          { name: "score", type: "float64", nullable: false },
        ],
      },
      options(root),
    );
    expect(nonConforming.ok).toBe(true);
    const manifestAfterBoth = readJson(path.join(nsDir, "manifest.json")) as {
      partitions: string[];
    };
    expect(manifestAfterBoth.partitions).toEqual([
      "concept/2026-08/",
      "events/2026-09/",
    ]);

    // schema.json: ONLY logical declarations. No partition index, no
    // lastUpdated, no manifest fields anywhere in the document.
    const schemaFile = path.join(nsDir, "schema.json");
    const schemaText = fs.readFileSync(schemaFile, "utf-8");
    const schema = JSON.parse(schemaText) as Record<string, unknown>;
    expect(Object.keys(schema).sort()).toEqual([
      "schemaVersion",
      "tables",
      "views",
    ]);
    expect(schemaText).not.toMatch(/partitions|lastUpdated/);
    expect(
      Object.keys(
        (schema.tables as Record<string, unknown>).events as object,
      ).sort(),
    ).toEqual([
      "columns",
      "keyColumns",
      "rowShape",
      "schemaVersion",
      "storage",
    ]);

    // A row written through the serializer keeps the manifest an index of
    // ACTIVE physical partitions and adds nothing schema-shaped to it.
    const writer = getNamespaceWriter(NS, {
      namespacesPath: root,
      scheduleCommit: () => undefined,
    });
    const writeResult = await writer.enqueue({
      ns: NS,
      table: "events",
      op: "insert",
      record: { id: "e2", kind: "view" },
      principal: ADMIN,
      targetPath: "events/2026-09/current.jsonl",
      partitionPath: "events/2026-09/",
    });
    expect(writeResult.ok).toBe(true);
    const manifestAfterWrite = readJson(
      path.join(nsDir, "manifest.json"),
    ) as Record<string, unknown>;
    expect(Object.keys(manifestAfterWrite).sort()).toEqual([
      "lastUpdated",
      "partitions",
    ]);
    expect(manifestAfterWrite.partitions).toEqual([
      "concept/2026-08/",
      "events/2026-09/",
    ]);

    // A declared table whose path is NOT in the manifest still reads through
    // the DECLARED storage path — the manifest is never the table selector.
    invalidateTableRegistry(NS);
    const declaration = getTable(NS, "scores");
    const plan = buildSelectPlan(declaration, { limit: 10 });
    const read = await executeSelectPlan(namespaceDir(NS), declaration, plan);
    expect(read.rows).toEqual([]);
    expect(manifestAfterBoth.partitions).not.toContain("tables/scores/");

    // Re-declaring a table (an evolution op) never deletes or rebuilds
    // manifest entries.
    const evolved = await addColumn(
      NS,
      {
        table: "scores",
        column: { name: "note", type: "string", nullable: true },
      },
      options(root),
    );
    expect(evolved.ok).toBe(true);
    const manifestAfterEvolution = readJson(
      path.join(nsDir, "manifest.json"),
    ) as { partitions: string[] };
    expect(manifestAfterEvolution.partitions).toEqual([
      "concept/2026-08/",
      "events/2026-09/",
    ]);
    const schemaAfterEvolution = JSON.parse(
      fs.readFileSync(schemaFile, "utf-8"),
    ) as Record<string, unknown>;
    expect(Object.keys(schemaAfterEvolution).sort()).toEqual([
      "schemaVersion",
      "tables",
      "views",
    ]);
  });
});
