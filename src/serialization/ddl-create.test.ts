/**
 * DB-SUPA-6 AC-3 — atomic authorized create.
 *
 * Admin create is idempotent (same Idempotency-Key + same canonical request
 * returns the original declaration), conflicts are explicit (`409
 * TABLE_ALREADY_DECLARED` / `409 IDEMPOTENCY_CONFLICT`), and a rejected create
 * modifies neither `schema.json` nor `manifest.json`. Creating a table creates
 * no data row.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createTable, type DdlCallOptions } from "./ddl";
import { loadNamespaceSchema } from "./schemaRegistry";
import type { AuthPrincipal } from "../auth/middleware";
import { ApiError } from "../http/middleware/errorHandler";

const NS = "supa6-create";
const ADMIN: AuthPrincipal = {
  name: "admin-token",
  authenticated: true,
  roles: ["admin"],
};

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supa6-create-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, NS), { recursive: true });
  return root;
}

function options(
  root: string,
  extra: Partial<DdlCallOptions> = {},
): DdlCallOptions {
  return {
    namespacesPath: root,
    principal: ADMIN,
    scheduleCommit: () => undefined,
    ...extra,
  };
}

function request() {
  return {
    table: "scores",
    rowShape: "object" as const,
    keyColumns: ["id"],
    storagePath: "tables/scores/current.jsonl",
    columns: [
      { name: "id", type: "string" as const, nullable: false },
      { name: "score", type: "float64" as const, nullable: false, default: 0 },
    ],
  };
}

function read(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
}

afterEach(() => {
  while (roots.length > 0)
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("SUPA-6 atomic authorized create", () => {
  it("admin create is idempotent and conflicts are explicit", async () => {
    const root = makeRoot();
    const nsDir = path.join(root, NS);
    const schemaFile = path.join(nsDir, "schema.json");

    const createOutcome = await createTable(NS, request(), options(root));
    if (!createOutcome.ok)
      throw new Error("createTable returned a confirmation");
    const created = createOutcome;
    expect(created.ok).toBe(true);
    expect(created.schemaVersion).toBe(1);
    expect(created.operation).toBe("createTable");
    expect(fs.existsSync(created.journalPath)).toBe(true);
    // "It creates no data row."
    expect(
      fs.existsSync(path.join(nsDir, "tables", "scores", "current.jsonl")),
    ).toBe(false);
    const declared = loadNamespaceSchema(NS, { namespacesPath: root }).document;
    expect(declared.tables.scores?.schemaVersion).toBe(1);
    expect(declared.tables.scores?.keyColumns).toEqual(["id"]);
    const afterCreate = read(schemaFile);
    const journalsAfterCreate = fs
      .readdirSync(path.join(nsDir, ".duckbrain-ddl"))
      .filter((entry) => entry.endsWith(".json")).length;
    expect(journalsAfterCreate).toBe(1);

    // Same Idempotency-Key + same canonical request → the ORIGINAL result.
    const replay = await createTable(
      NS,
      request(),
      options(root, { idempotencyKey: "create-scores-1" }),
    );
    const replayAgain = await createTable(
      NS,
      request(),
      options(root, { idempotencyKey: "create-scores-1" }),
    );
    expect(replay.ok && replayAgain.ok).toBe(true);
    if (!replayAgain.ok) throw new Error("expected an idempotent replay");
    expect(replayAgain.idempotentReplay).toBe(true);
    expect(replayAgain.schemaVersion).toBe(1);
    expect(read(schemaFile)).toBe(afterCreate);
    expect(
      fs
        .readdirSync(path.join(nsDir, ".duckbrain-ddl"))
        .filter((entry) => entry.endsWith(".json")).length,
    ).toBe(2); // exactly one more operation, no duplicate declaration

    // Same key + a different request → explicit conflict, no metadata change.
    const conflictSchema = read(schemaFile);
    await expect(
      createTable(
        NS,
        { ...request(), storagePath: "tables/scores/other.jsonl" },
        options(root, { idempotencyKey: "create-scores-1" }),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(read(schemaFile)).toBe(conflictSchema);

    // Same name, different contract, no key → explicit conflict; neither
    // metadata file is modified.
    const manifestBefore = read(path.join(nsDir, "manifest.json"));
    try {
      await createTable(
        NS,
        {
          ...request(),
          columns: [
            { name: "id", type: "string", nullable: false },
            { name: "score", type: "string", nullable: true },
          ],
        },
        options(root, { idempotencyKey: "create-scores-2" }),
      );
      throw new Error("expected TABLE_ALREADY_DECLARED");
    } catch (error) {
      const api = error as ApiError;
      expect(api.code).toBe("TABLE_ALREADY_DECLARED");
      expect(api.status).toBe(409);
    }
    expect(read(schemaFile)).toBe(conflictSchema);
    expect(read(path.join(nsDir, "manifest.json"))).toBe(manifestBefore);

    // A byte-equivalent retry (no key) is idempotent as well, and the declared
    // contract is returned rather than re-declared.
    const equivalent = await createTable(NS, request(), options(root));
    expect(equivalent.ok).toBe(true);
    if (!equivalent.ok) throw new Error("expected an equivalent declaration");
    expect(equivalent.idempotentReplay).toBe(true);
    expect(read(schemaFile)).toBe(conflictSchema);

    // Reserved names and malformed names are refused before any write.
    for (const [table, code] of [
      ["memories", "RESERVED_RESOURCE"],
      ["schema", "RESERVED_RESOURCE"],
      ["manifest", "RESERVED_RESOURCE"],
      ["_audit", "RESERVED_RESOURCE"],
      ["NotLower", "VALIDATION_ERROR"],
    ] as const) {
      await expect(
        createTable(NS, { ...request(), table }, options(root)),
      ).rejects.toMatchObject({ code });
    }
    expect(read(schemaFile)).toBe(conflictSchema);
  });

  it("declares a table with a composite key and every declared type", async () => {
    const root = makeRoot();
    const createdOutcome = await createTable(
      NS,
      {
        table: "snapshots",
        rowShape: "positional",
        keyColumns: ["model", "workload"],
        storagePath: "snapshots/bench.jsonl",
        columns: [
          { name: "model", type: "string", nullable: false },
          { name: "workload", type: "string", nullable: false },
          { name: "big", type: "int64", nullable: false },
          { name: "at", type: "timestamp", nullable: true },
          { name: "blob", type: "bytes", nullable: true },
          { name: "meta", type: "json", nullable: true },
        ],
      },
      options(root),
    );
    expect(createdOutcome.ok).toBe(true);
    if (!createdOutcome.ok)
      throw new Error("createTable returned a confirmation");
    expect(createdOutcome.table_?.rowShape).toBe("positional");
    expect(createdOutcome.table_?.keyColumns).toEqual(["model", "workload"]);

    // A table without a stable key is outside this v1 surface.
    await expect(
      createTable(
        NS,
        { ...request(), table: "nokeys", keyColumns: [] },
        options(root),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
