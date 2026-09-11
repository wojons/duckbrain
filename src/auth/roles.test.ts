import { describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "./middleware";
import {
  ROLE_GRANTS,
  SQL_DEFAULTS,
  authorizeResource,
  authorizeTableAccess,
  authorizeRawSql,
  sqlMemoryLimitStatement,
  streamWithSqlRowCap,
  withSqlTimeout,
} from "./roles";

function principal(
  name: string,
  roles: AuthPrincipal["roles"],
  extras: Partial<AuthPrincipal> = {},
): AuthPrincipal {
  return { name, authenticated: true, roles, ...extras };
}

describe("SUPA-4 role grants", () => {
  it("matrix battery matches pinned table/file/sql defaults", () => {
    const subjects = {
      admin: principal("admin", ["admin"]),
      writer: principal("writer", ["writer"]),
      analyst: principal("analyst", ["analyst"]),
      uploader: principal("uploader", ["uploader"]),
    };
    const expected = {
      admin: [true, true, true, true, true, false],
      writer: [true, true, false, false, false, false],
      analyst: [true, false, true, false, true, false],
      uploader: [true, false, true, true, false, false],
    };

    for (const [role, actor] of Object.entries(subjects)) {
      const actual = [
        authorizeTableAccess(actor, "alpha", "memories", "read").allowed,
        authorizeTableAccess(actor, "alpha", "memories", "write").allowed,
        authorizeResource(actor, "alpha", "files.read").allowed,
        authorizeResource(actor, "alpha", "files.upload").allowed,
        authorizeRawSql(actor, "alpha", "read").allowed,
        authorizeRawSql(actor, "alpha", "write").allowed,
      ];
      expect(actual, role).toEqual(expected[role as keyof typeof expected]);
    }

    expect(ROLE_GRANTS.admin).toContain("sql.write");
    expect(ROLE_GRANTS.writer).toContain("sql.write");
    expect(SQL_DEFAULTS).toEqual({
      timeoutMs: 10_000,
      maxRows: 10_000,
      maxMemoryBytes: 256 * 1024 * 1024,
    });
  });

  it("admin bypasses tableGrants while an explicit non-admin map restricts defaults", () => {
    const grants = { t1: "read" as const };
    const writer = principal("writer", ["writer"], { tableGrants: grants });
    expect(authorizeTableAccess(writer, "alpha", "t1", "read").allowed).toBe(
      true,
    );
    expect(authorizeTableAccess(writer, "alpha", "t1", "write")).toMatchObject({
      allowed: false,
      reason: "table_grant",
    });
    expect(authorizeTableAccess(writer, "alpha", "t2", "read")).toMatchObject({
      allowed: false,
      reason: "table_grant",
    });
    expect(authorizeTableAccess(writer, "alpha", "t2", "write")).toMatchObject({
      allowed: false,
      reason: "table_grant",
    });

    const admin = principal("admin", ["admin"], { tableGrants: grants });
    expect(authorizeTableAccess(admin, "alpha", "t2", "write").allowed).toBe(
      true,
    );
  });

  it("multiple roles hold the union of grants", () => {
    const actor = principal("combined", ["analyst", "uploader"]);
    expect(authorizeResource(actor, "alpha", "files.upload").allowed).toBe(
      true,
    );
    expect(authorizeRawSql(actor, "alpha", "read").allowed).toBe(true);
    expect(
      authorizeTableAccess(actor, "alpha", "memories", "write"),
    ).toMatchObject({ allowed: false, reason: "role" });
  });

  it("namespace scope is orthogonal and denied before resource grants", () => {
    const actor = principal("scoped", ["admin"], { namespaces: ["nsA"] });
    expect(
      authorizeTableAccess(actor, "nsB", "memories", "read"),
    ).toMatchObject({ allowed: false, reason: "namespace_scope" });
    expect(authorizeRawSql(actor, "nsB", "read")).toMatchObject({
      allowed: false,
      reason: "namespace_scope",
    });
  });

  it("raw SQL requires both a role grant and the effective per-principal flag", () => {
    const writer = principal("writer", ["writer"]);
    expect(authorizeRawSql(writer, "alpha", "read")).toMatchObject({
      allowed: false,
      reason: "sql_flag",
    });
    expect(
      authorizeRawSql(
        principal("writer", ["writer"], { sql: { read: true, write: true } }),
        "alpha",
        "write",
      ).allowed,
    ).toBe(true);
    expect(
      authorizeRawSql(
        principal("analyst", ["analyst"], { sql: { write: true } }),
        "alpha",
        "write",
      ).allowed,
    ).toBe(true);
    expect(
      authorizeRawSql(
        principal("uploader", ["uploader"], { sql: { read: true } }),
        "alpha",
        "read",
      ),
    ).toMatchObject({ allowed: false, reason: "role" });
  });

  it("row cap yields the configured rows then fails loudly and audits the cap", async () => {
    const audit = vi.fn();
    const rows = Array.from({ length: 100 }, (_, index) => index);
    const streamed: number[] = [];

    await expect(async () => {
      for await (const row of streamWithSqlRowCap(rows, 10, audit)) {
        streamed.push(row);
      }
    }).rejects.toMatchObject({ code: "SQL_ROW_CAP" });

    expect(streamed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("timeout and memory primitives enforce the resolved SQL caps", async () => {
    expect(sqlMemoryLimitStatement(64 * 1024 * 1024)).toBe(
      "SET memory_limit='67108864B'",
    );
    const capAudit = vi.fn();
    await expect(
      withSqlTimeout(
        () => new Promise((resolve) => setTimeout(resolve, 50)),
        5,
        capAudit,
      ),
    ).rejects.toMatchObject({ code: "SQL_TIMEOUT" });
    expect(capAudit).toHaveBeenCalledTimes(1);
  });

  it("legacy principals without roles remain admin-equivalent within namespace scope", () => {
    const legacy = principal("legacy", undefined, { namespaces: ["alpha"] });
    expect(
      authorizeTableAccess(legacy, "alpha", "anything", "write").allowed,
    ).toBe(true);
    expect(authorizeRawSql(legacy, "alpha", "read").allowed).toBe(true);
    expect(authorizeRawSql(legacy, "alpha", "write")).toMatchObject({
      allowed: false,
      reason: "sql_flag",
    });
  });
});
