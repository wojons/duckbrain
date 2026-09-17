/**
 * DB-SUPA-6 AC-3 — DDL is namespace-admin only (SUPA-4 roles + namespace
 * scope). A non-admin principal can read/write declared tables under its table
 * grants, but it can never change the declaration.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  addColumn,
  createTable,
  declareView,
  redeclareView,
  retypeColumn,
  type DdlCallOptions,
} from "./ddl";
import type { AuthPrincipal } from "../auth/middleware";

const NS = "supa6-auth";

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supa6-auth-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, NS), { recursive: true });
  return root;
}

function options(
  root: string,
  principal: AuthPrincipal | undefined,
): DdlCallOptions {
  return {
    namespacesPath: root,
    principal,
    scheduleCommit: () => undefined,
  };
}

const createRequest = () => ({
  table: "scores",
  rowShape: "object" as const,
  keyColumns: ["id"],
  storagePath: "tables/scores/current.jsonl",
  columns: [{ name: "id", type: "string" as const, nullable: false }],
});

afterEach(() => {
  while (roots.length > 0)
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("SUPA-6 DDL authorization", () => {
  it("non-admin DDL is forbidden", async () => {
    const root = makeRoot();
    const nsDir = path.join(root, NS);
    const principal = (roles: AuthPrincipal["roles"], namespaces?: string[]) =>
      ({
        name: `token-${roles?.join("-") ?? "legacy"}`,
        authenticated: true,
        ...(roles ? { roles } : {}),
        ...(namespaces ? { namespaces } : {}),
      }) satisfies AuthPrincipal;

    const nonAdmins: AuthPrincipal[] = [
      principal(["writer"]),
      principal(["analyst"]),
      principal(["uploader"]),
      principal(["writer", "analyst"]),
    ];

    for (const who of nonAdmins) {
      // Every operation surface is refused with 403 FORBIDDEN.
      await expect(
        createTable(NS, createRequest(), options(root, who)),
      ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
      // … and nothing was created: no schema.json, no journal.
      expect(fs.existsSync(path.join(nsDir, "schema.json"))).toBe(false);
      expect(fs.existsSync(path.join(nsDir, ".duckbrain-ddl"))).toBe(false);
    }

    // An admin named in a different namespace scope is refused too.
    await expect(
      createTable(
        NS,
        createRequest(),
        options(root, principal(["admin"], ["other-namespace"])),
      ),
    ).rejects.toMatchObject({ status: 403 });

    // The admin creates it, then the non-admin operations on an existing
    // declaration are refused as well.
    const admin = principal(["admin"]);
    const created = await createTable(
      NS,
      createRequest(),
      options(root, admin),
    );
    expect(created.ok).toBe(true);
    const schemaAfterCreate = fs.readFileSync(
      path.join(nsDir, "schema.json"),
      "utf-8",
    );
    const writer = principal(["writer"]);
    await expect(
      addColumn(
        NS,
        {
          table: "scores",
          column: { name: "note", type: "string", nullable: true },
        },
        options(root, writer),
      ),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(
      retypeColumn(
        NS,
        {
          table: "scores",
          column: "id",
          type: "float64",
          policy: "materialize",
        },
        options(root, writer),
      ),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(
      declareView(
        NS,
        { view: "v1", dependsOn: ["scores"], query: "SELECT id FROM scores" },
        options(root, writer),
      ),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(
      redeclareView(
        NS,
        { view: "v1", dependsOn: ["scores"], query: "SELECT id FROM scores" },
        options(root, writer),
      ),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(fs.readFileSync(path.join(nsDir, "schema.json"), "utf-8")).toBe(
      schemaAfterCreate,
    );

    // The admin can evolve the same declaration.
    const evolved = await addColumn(
      NS,
      {
        table: "scores",
        column: { name: "note", type: "string", nullable: true },
      },
      options(root, admin),
    );
    expect(evolved.ok).toBe(true);
    expect(evolved.schemaVersion).toBe(2);

    // `auth.mode = none` (no principal) keeps local deployments working, and a
    // pre-SUPA-4 token shape (roles undefined) stays admin-equivalent.
    const anonymous = await addColumn(
      NS,
      {
        table: "scores",
        column: { name: "extra", type: "string", nullable: true },
      },
      { namespacesPath: root, scheduleCommit: () => undefined },
    );
    expect(anonymous.ok).toBe(true);
    const legacyToken = await addColumn(
      NS,
      {
        table: "scores",
        column: { name: "legacy", type: "string", nullable: true },
      },
      options(root, principal(undefined)),
    );
    expect(legacyToken.ok).toBe(true);
  });
});
