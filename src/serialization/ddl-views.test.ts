/**
 * DB-SUPA-6 AC-7 — view re-declaration.
 *
 * A view is read-only and declarative. A compatible re-declare (same exposed
 * column names/types, changed validated query) increments the version and
 * dependent views keep validating; an exposed-shape change, a dependency cycle
 * or an undeclared dependency is rejected WITHOUT replacing `schema.json`.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createTable,
  declareView,
  redeclareView,
  type DdlCallOptions,
} from "./ddl";
import { loadNamespaceSchema } from "./schemaRegistry";
import { viewExposedColumns } from "./schemaJson";
import type { AuthPrincipal } from "../auth/middleware";
import { ApiError } from "../http/middleware/errorHandler";

const NS = "supa6-views";
const ADMIN: AuthPrincipal = {
  name: "admin-token",
  authenticated: true,
  roles: ["admin"],
};

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supa6-views-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, NS), { recursive: true });
  return root;
}

function options(root: string): DdlCallOptions {
  return {
    namespacesPath: root,
    principal: ADMIN,
    scheduleCommit: () => undefined,
  };
}

const schemaFile = (root: string): string => path.join(root, NS, "schema.json");

const schemaText = (root: string): string =>
  fs.readFileSync(schemaFile(root), "utf-8");

afterEach(() => {
  while (roots.length > 0)
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("SUPA-6 view declarations", () => {
  it("compatible view redeclare increments version", async () => {
    const root = makeRoot();
    await createTable(
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

    const declared = await declareView(
      NS,
      {
        view: "top_scores",
        dependsOn: ["scores"],
        query: "SELECT id, score FROM scores WHERE score >= 90",
      },
      options(root),
    );
    expect(declared.schemaVersion).toBe(1);
    expect(declared.viewDefinition?.query).toMatch(/>= 90/);

    // A dependent view declared on top of it validates too.
    const dependent = await declareView(
      NS,
      {
        view: "top_ids",
        dependsOn: ["top_scores"],
        query: "SELECT id FROM top_scores WHERE score >= 95",
      },
      options(root),
    );
    expect(dependent.schemaVersion).toBe(1);
    const document = loadNamespaceSchema(NS, { namespacesPath: root }).document;
    expect(viewExposedColumns(document, "top_ids")).toEqual([
      { name: "id", type: "string", nullable: true },
    ]);

    // Compatible re-declare: only the validated query changes.
    const redeclared = await redeclareView(
      NS,
      {
        view: "top_scores",
        dependsOn: ["scores"],
        query: "SELECT id, score FROM scores WHERE score >= 50",
      },
      options(root),
    );
    expect(redeclared.schemaVersion).toBe(2);
    const after = loadNamespaceSchema(NS, { namespacesPath: root }).document;
    expect(after.views.top_scores?.schemaVersion).toBe(2);
    expect(after.views.top_scores?.query).toMatch(/>= 50/);
    // Exposed shape is unchanged, so the dependent view still validates.
    expect(viewExposedColumns(after, "top_scores")).toEqual([
      { name: "id", type: "string", nullable: true },
      { name: "score", type: "float64", nullable: true },
    ]);
    expect(viewExposedColumns(after, "top_ids")).toHaveLength(1);
    // A view never materializes data or adds a storage path.
    expect(
      (after.views.top_scores as unknown as Record<string, unknown>).storage,
    ).toBeUndefined();
  });

  it("dependency cycle and exposed-shape drift are rejected", async () => {
    const root = makeRoot();
    await createTable(
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
    await declareView(
      NS,
      {
        view: "base",
        dependsOn: ["scores"],
        query: "SELECT id, score FROM scores WHERE score >= 1",
      },
      options(root),
    );
    await declareView(
      NS,
      {
        view: "mirror",
        dependsOn: ["base"],
        query: "SELECT id, score FROM base WHERE score >= 1",
      },
      options(root),
    );
    const before = schemaText(root);

    // Exposed-shape drift (dropping a column) → refused, schema.json intact.
    try {
      await redeclareView(
        NS,
        {
          view: "base",
          dependsOn: ["scores"],
          query: "SELECT id FROM scores WHERE score >= 1",
        },
        options(root),
      );
      throw new Error("expected VIEW_SHAPE_CHANGED");
    } catch (error) {
      const api = error as ApiError;
      expect(api.code).toBe("VIEW_SHAPE_CHANGED");
      expect(api.status).toBe(409);
    }
    expect(schemaText(root)).toBe(before);

    // A retype of an exposed column is shape drift too.
    try {
      await redeclareView(
        NS,
        {
          view: "base",
          dependsOn: ["scores"],
          query:
            "SELECT id, CAST(score AS VARCHAR) FROM scores WHERE score >= 1",
        },
        options(root),
      );
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as ApiError).code).toBe("VALIDATION_ERROR");
    }
    expect(schemaText(root)).toBe(before);

    // Dependency cycle: base → mirror → base, with the exposed shape intact so
    // the cycle check is what fires.
    try {
      await redeclareView(
        NS,
        {
          view: "base",
          dependsOn: ["mirror"],
          query: "SELECT id, score FROM mirror WHERE score >= 1",
        },
        options(root),
      );
      throw new Error("expected a cycle rejection");
    } catch (error) {
      const api = error as ApiError;
      expect(api.code).toBe("VALIDATION_ERROR");
      expect(api.message).toMatch(/cycle|dependsOn|dependency/i);
    }
    expect(schemaText(root)).toBe(before);

    // Undeclared dependency.
    try {
      await declareView(
        NS,
        {
          view: "ghostly",
          dependsOn: ["ghosts"],
          query: "SELECT id FROM ghosts",
        },
        options(root),
      );
      throw new Error("expected an undeclared-dependency rejection");
    } catch (error) {
      expect((error as ApiError).code).toBe("VALIDATION_ERROR");
    }
    // Reference to an undeclared column of a declared dependency.
    try {
      await declareView(
        NS,
        {
          view: "badcols",
          dependsOn: ["scores"],
          query: "SELECT missing FROM scores",
        },
        options(root),
      );
      throw new Error("expected an undeclared-column rejection");
    } catch (error) {
      expect((error as ApiError).code).toBe("VALIDATION_ERROR");
    }
    // Re-declaring an unknown view is a 404, not a silent create.
    try {
      await redeclareView(
        NS,
        {
          view: "absent",
          dependsOn: ["scores"],
          query: "SELECT id FROM scores",
        },
        options(root),
      );
      throw new Error("expected VIEW_NOT_FOUND");
    } catch (error) {
      expect((error as ApiError).code).toBe("VIEW_NOT_FOUND");
      expect((error as ApiError).status).toBe(404);
    }
    // Declaring an existing view name is an explicit conflict.
    try {
      await declareView(
        NS,
        {
          view: "base",
          dependsOn: ["scores"],
          query: "SELECT id, score FROM scores WHERE score >= 2",
        },
        options(root),
      );
      throw new Error("expected VIEW_ALREADY_DECLARED");
    } catch (error) {
      expect((error as ApiError).code).toBe("VIEW_ALREADY_DECLARED");
    }
    expect(schemaText(root)).toBe(before);
  });
});
