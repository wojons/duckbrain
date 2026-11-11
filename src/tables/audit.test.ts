/** TABLES-AUDIT-KEYS-001 — read-only duplicate primary-key audit. */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runTablesCli } from "../cli/tables";
import { appendRowsToTable } from "../duckdb/table-store";
import { invalidateTableRegistry } from "../schema/table-registry";
import { auditNamespaceTableKeys } from "./audit";
import { removeTempDirSafely } from "../testing/race-safe-daemon";

const NS = "audit-keys-fixture";
let tmpRoot = "";

function writeDeclaration(
  table: string,
  primary: string | null,
  format: "jsonl-objects" | "jsonl-positional" = "jsonl-objects",
): void {
  const nsDir = path.join(tmpRoot, NS);
  fs.mkdirSync(path.join(nsDir, "tables"), { recursive: true });
  fs.writeFileSync(
    path.join(nsDir, "tables", `${table}.table.json`),
    JSON.stringify({
      name: table,
      format,
      columns:
        format === "jsonl-positional"
          ? [
              { name: "tenant", type: "varchar" },
              { name: "id", type: "integer" },
            ]
          : [
              { name: "id", type: "integer" },
              { name: "label", type: "varchar" },
            ],
      primary,
      glob: `tables/${table}.jsonl`,
    }),
  );
}

beforeEach(() => {
  if (!tmpRoot) {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tables-audit-keys-"));
    process.env.DUCKBRAIN_NAMESPACES_PATH = tmpRoot;
  }
  fs.rmSync(path.join(tmpRoot, NS), { recursive: true, force: true });
  writeDeclaration("widgets", "id");
  writeDeclaration("logs", null);
  writeDeclaration("positional", "id", "jsonl-positional");
  invalidateTableRegistry(NS);
});

afterAll(async () => {
  await removeTempDirSafely(tmpRoot);
});

describe("table primary-key audit", () => {
  it("reports duplicate keys from store rows and leaves the row count unchanged", () => {
    const nsDir = path.join(tmpRoot, NS);
    const widgets = {
      name: "widgets",
      format: "jsonl-objects" as const,
      columns: [
        { name: "id", type: "integer" as const },
        { name: "label", type: "varchar" as const },
      ],
      primary: "id",
      glob: "tables/widgets.jsonl",
    };
    appendRowsToTable(nsDir, widgets, [
      { id: 7, label: "first" },
      { id: 7, label: "second" },
      { id: 8, label: "unique" },
    ]);
    const dataFile = path.join(nsDir, "tables/widgets.jsonl");
    const before = fs.readFileSync(dataFile, "utf-8");

    const audit = auditNamespaceTableKeys(NS);

    expect(audit.duplicateTables).toBe(1);
    expect(audit.duplicateKeys).toBe(1);
    expect(audit.tables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "widgets",
          primary: ["id"],
          status: "duplicates",
          duplicates: [{ key: { id: 7 }, count: 2 }],
        }),
        expect.objectContaining({
          table: "logs",
          primary: [],
          status: "no-primary-key",
          duplicates: [],
        }),
      ]),
    );
    expect(fs.readFileSync(dataFile, "utf-8")).toBe(before);
  });

  it("reads positional rows and the CLI exits non-zero when duplicates exist", async () => {
    const nsDir = path.join(tmpRoot, NS);
    const positional = {
      name: "positional",
      format: "jsonl-positional" as const,
      columns: [
        { name: "tenant", type: "varchar" as const },
        { name: "id", type: "integer" as const },
      ],
      primary: "id",
      glob: "tables/positional.jsonl",
    };
    appendRowsToTable(nsDir, positional, [
      { tenant: "acme", id: 3 },
      { tenant: "other", id: 3 },
    ]);
    const before = fs.readFileSync(
      path.join(nsDir, "tables/positional.jsonl"),
      "utf-8",
    );

    const exitCode = await runTablesCli(["audit-keys", "--namespace", NS]);

    expect(exitCode).toBe(1);
    expect(
      fs.readFileSync(path.join(nsDir, "tables/positional.jsonl"), "utf-8"),
    ).toBe(before);
  });

  it("returns zero for a clean namespace", async () => {
    const code = await runTablesCli(["audit-keys", "--namespace", NS]);
    expect(code).toBe(0);
  });
});
