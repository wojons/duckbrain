/**
 * DB-SUPA-6 AC-8 — bounded inference removal.
 *
 * Generic declared reads use the declared types and headers only: no
 * `read_json_auto`, no `auto_detect=true`, and the compatibility counter stays
 * at zero. Inference survives ONLY as a create-table migration helper, gated by
 * the compatibility window, and it persists exactly one declaration after
 * explicit confirmation. Once the window has closed, inference is refused with
 * `409 SCHEMA_DECLARATION_REQUIRED` and a migration warning.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createTable,
  type CreateTableRequest,
  type DdlCallOptions,
} from "./ddl";
import {
  SCHEMA_INFERENCE_COMPAT_COUNTER,
  assertGenericInferenceAllowed,
  resolveInferenceWindow,
  resetInferenceCompatState,
  schemaInferenceCompatCount,
} from "./inferenceCompat";
import { loadNamespaceSchema } from "./schemaRegistry";
import {
  buildReadSqlForFiles,
  buildSelectPlan,
  executeSelectPlan,
  resolveTableFiles,
} from "../duckdb/table-store";
import {
  getTable,
  invalidateTableRegistry,
  namespaceDir,
} from "../schema/table-registry";
import type { AuthPrincipal } from "../auth/middleware";
import { ApiError } from "../http/middleware/errorHandler";

const NS = "supa6-inference";
const ADMIN: AuthPrincipal = {
  name: "admin-token",
  authenticated: true,
  roles: ["admin"],
};

const CLOSED_WINDOW = {
  shippedAt: "2026-01-01T00:00:00.000Z",
  graceDays: 1,
  minMinorReleases: 2,
  minorReleasesShipped: 2,
};

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supa6-inference-"));
  roots.push(root);
  process.env.DUCKBRAIN_NAMESPACES_PATH = root;
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

beforeEach(() => {
  resetInferenceCompatState();
});

afterEach(() => {
  invalidateTableRegistry(NS);
  while (roots.length > 0)
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  delete process.env.DUCKBRAIN_NAMESPACES_PATH;
});

describe("SUPA-6 bounded inference removal", () => {
  it("create-only inference requires confirmation", async () => {
    const root = makeRoot();
    const nsDir = path.join(root, NS);
    fs.writeFileSync(
      path.join(nsDir, "infer.jsonl"),
      [
        JSON.stringify({
          id: "a",
          score: 1.5,
          ok: true,
          note: null,
          blank: null,
        }),
        JSON.stringify({
          id: "b",
          score: 2.5,
          ok: false,
          note: "x",
          blank: null,
        }),
      ].join("\n") + "\n",
    );

    // First call: the generated declaration is SHOWN for confirmation and
    // nothing is persisted.
    const pending = await createTable(
      NS,
      {
        table: "inferred",
        inferFrom: "infer.jsonl",
        keyColumns: ["id"],
        rowShape: "object",
        columns: [],
        storagePath: "",
      } as unknown as CreateTableRequest,
      options(root),
    );
    expect(pending.ok).toBe(false);
    if (pending.ok) return;
    expect(pending.status).toBe("confirmation_required");
    expect(pending.sourceFile).toBe("infer.jsonl");
    expect(pending.sampleLines).toBe(2);
    // Faithful mapping: strings → string, numbers → float64, booleans →
    // boolean, a partially-null column → nullable, an all-null column → json.
    // Never a coercion and never a guessed type.
    expect(pending.declaration.columns).toEqual([
      { name: "id", type: "string", nullable: false },
      { name: "score", type: "float64", nullable: false },
      { name: "ok", type: "boolean", nullable: false },
      { name: "note", type: "string", nullable: true },
      { name: "blank", type: "json", nullable: true },
    ]);
    expect(pending.declaration.storage.path).toBe("infer.jsonl");
    expect(fs.existsSync(path.join(nsDir, "schema.json"))).toBe(false);
    expect(fs.existsSync(path.join(nsDir, ".duckbrain-ddl"))).toBe(false);
    // The compatibility access was counted and warned about once.
    expect(schemaInferenceCompatCount()).toBe(1);

    // Confirm → persisted ONCE.
    const confirmed = await createTable(
      NS,
      {
        table: "inferred",
        inferFrom: "infer.jsonl",
        keyColumns: ["id"],
        confirm: true,
      } as CreateTableRequest,
      options(root),
    );
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.schemaVersion).toBe(1);
    const journals = fs
      .readdirSync(path.join(nsDir, ".duckbrain-ddl"))
      .filter((entry) => entry.endsWith(".json"));
    expect(journals).toHaveLength(1);
    const document = loadNamespaceSchema(NS, { namespacesPath: root }).document;
    expect(document.tables.inferred?.storage.path).toBe("infer.jsonl");

    // A later inference attempt cannot re-declare the same table.
    await expect(
      createTable(
        NS,
        {
          table: "inferred",
          inferFrom: "infer.jsonl",
          keyColumns: ["id"],
          confirm: true,
        } as CreateTableRequest,
        options(root, { idempotencyKey: "infer-once" }),
      ),
    ).resolves.toBeDefined();

    // Inference without key columns where none can be inferred is refused.
    fs.writeFileSync(
      path.join(nsDir, "nokey.jsonl"),
      `${JSON.stringify({ a: 1, b: "x" })}\n`,
    );
    await expect(
      createTable(
        NS,
        {
          table: "noluck",
          inferFrom: "nokey.jsonl",
          confirm: true,
        } as unknown as CreateTableRequest,
        options(root),
      ),
    ).rejects.toMatchObject({ code: "KEY_COLUMNS_REQUIRED" });

    // Declaring a second table over an already-declared storage path is refused.
    await expect(
      createTable(
        NS,
        {
          table: "duplicate_path",
          inferFrom: "infer.jsonl",
          keyColumns: ["id"],
          confirm: true,
        } as CreateTableRequest,
        options(root),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // Mixed JSON kinds in one column cannot be declared faithfully.
    fs.writeFileSync(
      path.join(nsDir, "mixed.jsonl"),
      `${JSON.stringify({ id: "a", v: 1 })}\n${JSON.stringify({ id: "b", v: "one" })}\n`,
    );
    await expect(
      createTable(
        NS,
        {
          table: "mixed",
          inferFrom: "mixed.jsonl",
          keyColumns: ["id"],
          confirm: true,
        } as unknown as CreateTableRequest,
        options(root),
      ),
    ).rejects.toMatchObject({ code: "INFERENCE_AMBIGUOUS" });

    // Inference over an unrepresentable value is refused rather than guessed.
    fs.writeFileSync(
      path.join(nsDir, "unsafe.jsonl"),
      `${JSON.stringify({ id: "huge", n: 9007199254740993 })}\n`,
    );
    await expect(
      createTable(
        NS,
        {
          table: "unsafe",
          inferFrom: "unsafe.jsonl",
          keyColumns: ["id"],
          confirm: true,
        } as unknown as CreateTableRequest,
        options(root),
      ),
    ).rejects.toMatchObject({ code: "INFERENCE_AMBIGUOUS" });
  });

  it("declared read never calls auto inference", async () => {
    const root = makeRoot();
    const nsDir = path.join(root, NS);
    fs.mkdirSync(path.join(nsDir, "tables", "scores"), { recursive: true });
    fs.writeFileSync(
      path.join(nsDir, "tables", "scores", "current.jsonl"),
      `${JSON.stringify({ id: "a", big: "9223372036854775807" })}\n`,
    );
    fs.mkdirSync(path.join(nsDir, "snapshots"), { recursive: true });
    fs.writeFileSync(
      path.join(nsDir, "snapshots", "bench.jsonl"),
      `${JSON.stringify(["m1", 0.5])}\n`,
    );
    const createdObject = await createTable(
      NS,
      {
        table: "scores",
        rowShape: "object",
        keyColumns: ["id"],
        storagePath: "tables/scores/current.jsonl",
        columns: [
          { name: "id", type: "string", nullable: false },
          { name: "big", type: "int64", nullable: false },
        ],
      },
      options(root),
    );
    expect(createdObject.ok).toBe(true);
    const createdPositional = await createTable(
      NS,
      {
        table: "bench",
        rowShape: "positional",
        keyColumns: ["model"],
        storagePath: "snapshots/bench.jsonl",
        columns: [
          { name: "model", type: "string", nullable: false },
          { name: "score", type: "float64", nullable: false },
        ],
      },
      options(root),
    );
    expect(createdPositional.ok).toBe(true);

    resetInferenceCompatState();
    invalidateTableRegistry(NS);
    for (const table of ["scores", "bench"]) {
      const declaration = getTable(NS, table);
      const files = resolveTableFiles(namespaceDir(NS), declaration);
      const sql = buildReadSqlForFiles(files, declaration);
      // Declared types/headers only — never per-query auto inference.
      expect(sql).not.toMatch(/read_json_auto/);
      expect(sql).not.toMatch(/auto_detect\s*=\s*true/);
      expect(sql).toContain("auto_detect=false");
      expect(sql).toMatch(
        table === "scores"
          ? /"big":'VARCHAR'/
          : /json_extract_string\(json\[1\]/,
      );
      const plan = buildSelectPlan(declaration, { limit: 10 });
      const result = await executeSelectPlan(
        namespaceDir(NS),
        declaration,
        plan,
      );
      expect(result.rows).toHaveLength(1);
    }
    // No compatibility access was recorded by any declared read.
    expect(schemaInferenceCompatCount()).toBe(0);
    expect(SCHEMA_INFERENCE_COMPAT_COUNTER).toBe(
      "duckbrain_schema_inference_compat_total",
    );

    // Positive control: an inference attempt inside the open window DOES warn
    // and count, so the counter assertion above is meaningful.
    const window = resolveInferenceWindow(undefined, new Date());
    expect(window.active).toBe(true);
    assertGenericInferenceAllowed(NS, "legacy.jsonl", {});
    expect(schemaInferenceCompatCount()).toBe(1);
  });

  it("expired compatibility window rejects inference", async () => {
    const root = makeRoot();
    const nsDir = path.join(root, NS);
    fs.writeFileSync(
      path.join(nsDir, "infer.jsonl"),
      `${JSON.stringify({ id: "a", score: 1.5 })}\n`,
    );

    // The window is a conjunction: both the release rule and the grace period
    // must be satisfied before it closes.
    expect(
      resolveInferenceWindow({ ...CLOSED_WINDOW }, new Date()).active,
    ).toBe(false);
    expect(
      resolveInferenceWindow(
        { ...CLOSED_WINDOW, minorReleasesShipped: 0 },
        new Date(),
      ).active,
    ).toBe(true);
    expect(
      resolveInferenceWindow(
        {
          shippedAt: new Date().toISOString(),
          graceDays: 90,
          minMinorReleases: 2,
          minorReleasesShipped: 5,
        },
        new Date(),
      ).active,
    ).toBe(true);

    // Expired window: create-only inference fails with the migration error …
    try {
      await createTable(
        NS,
        {
          table: "inferred",
          inferFrom: "infer.jsonl",
          keyColumns: ["id"],
          confirm: true,
        } as CreateTableRequest,
        options(root, { inferenceWindow: CLOSED_WINDOW }),
      );
      throw new Error("expected SCHEMA_DECLARATION_REQUIRED");
    } catch (error) {
      const api = error as ApiError;
      expect(api.code).toBe("SCHEMA_DECLARATION_REQUIRED");
      expect(api.status).toBe(409);
      expect(api.message).toMatch(/inference is no longer permitted/);
    }
    expect(fs.existsSync(path.join(nsDir, "schema.json"))).toBe(false);

    // … including the raw generic gate that any per-query path consults.
    expect(() =>
      assertGenericInferenceAllowed(NS, "infer.jsonl", {
        window: CLOSED_WINDOW,
      }),
    ).toThrow(/SCHEMA_DECLARATION_REQUIRED|no longer permitted/);

    // An EXPLICIT declaration still works: the window only bounds inference.
    const explicit = await createTable(
      NS,
      {
        table: "manual",
        rowShape: "object",
        keyColumns: ["id"],
        storagePath: "infer.jsonl",
        columns: [
          { name: "id", type: "string", nullable: false },
          { name: "score", type: "float64", nullable: false },
        ],
      },
      options(root, { inferenceWindow: CLOSED_WINDOW }),
    );
    expect(explicit.ok).toBe(true);
  });
});
