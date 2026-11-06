/**
 * RLS-001 — declared ROW-LEVEL policy: declaration validation + evaluation.
 *
 * The unit half of the row: `parseTablePolicy` refuses a policy that cannot be
 * evaluated (a column the table does not declare, an unknown principal
 * reference), and `rowPolicyDecision` fails CLOSED — a row missing the policy
 * column, or an unresolvable principal, is denied rather than admitted.
 * The end-to-end half (two principals over the real routes, audit reasons,
 * change feed) is src/http/routes/tables-rls001.test.ts.
 */

import { describe, it, expect } from "vitest";
import type { AuthPrincipal } from "../auth/middleware";
import {
  POLICY_PRINCIPAL_FIELDS,
  ROW_POLICY_REASON,
  RowPolicyDeclarationError,
  auditPolicyDenial,
  parseTablePolicy,
  principalPolicyValue,
  resolveRowPolicy,
  rowPolicyDecision,
} from "./policy";

const COLUMNS = ["id", "owner", "amount"];
const CONTEXT = { table: "invoices", columns: COLUMNS };

function principal(name: string): AuthPrincipal {
  return { name, authenticated: true };
}

describe("RLS-001: policy declaration", () => {
  it("accepts a read+write policy naming declared columns", () => {
    const policy = parseTablePolicy(
      { read: { column: "owner", equals: ".id" }, write: { column: "owner", equals: ".id" } },
      CONTEXT,
    );
    expect(policy).toEqual({
      read: { column: "owner", equals: ".id" },
      write: { column: "owner", equals: ".id" },
    });
  });

  it("accepts a literal value (a row everybody may read)", () => {
    const policy = parseTablePolicy(
      { read: { column: "owner", equals: "public" } },
      CONTEXT,
    );
    expect(policy?.read).toEqual({ column: "owner", equals: "public" });
  });

  it("returns undefined when no policy was declared", () => {
    expect(parseTablePolicy(undefined, CONTEXT)).toBeUndefined();
  });

  it("refuses a policy column the table does not declare", () => {
    expect(() =>
      parseTablePolicy({ read: { column: "tenant", equals: ".id" } }, CONTEXT),
    ).toThrow(RowPolicyDeclarationError);
    expect(() =>
      parseTablePolicy({ read: { column: "tenant", equals: ".id" } }, CONTEXT),
    ).toThrow(/not a declared column/);
  });

  it("refuses an unknown principal reference", () => {
    expect(() =>
      parseTablePolicy({ read: { column: "owner", equals: ".email" } }, CONTEXT),
    ).toThrow(/unknown principal field/);
  });

  it("refuses unknown fields, an empty policy, and a non-object", () => {
    expect(() =>
      parseTablePolicy({ read: { column: "owner", equals: ".id", extra: 1 } }, CONTEXT),
    ).toThrow(/unknown field 'extra'/);
    expect(() => parseTablePolicy({ read: { column: "owner", equals: ".id" }, all: true }, CONTEXT)).toThrow(
      /unknown field 'all'/,
    );
    expect(() => parseTablePolicy({}, CONTEXT)).toThrow(/neither read nor write/);
    expect(() => parseTablePolicy("owner", CONTEXT)).toThrow(/must be an object/);
    expect(() => parseTablePolicy({ read: { column: "owner", equals: "" } }, CONTEXT)).toThrow(
      /non-empty string/,
    );
  });

  it("names the principal fields a .reference may use", () => {
    expect([...POLICY_PRINCIPAL_FIELDS]).toEqual(["id", "name"]);
  });
});

describe("RLS-001: policy evaluation", () => {
  const policy = {
    read: { column: "owner", equals: ".id" },
    write: { column: "owner", equals: ".id" },
  };

  it("admits the owner's row and denies another principal's row", () => {
    expect(
      rowPolicyDecision(policy, "read", { id: "1", owner: "alice" }, principal("alice")),
    ).toEqual({ allowed: true });
    const denied = rowPolicyDecision(
      policy,
      "read",
      { id: "1", owner: "alice" },
      principal("bob"),
    );
    expect(denied).toMatchObject({ allowed: false, reason: ROW_POLICY_REASON });
    expect(denied.allowed === false && denied.message).toMatch(/outside principal 'bob' row policy/);
  });

  it("denies a row that is MISSING the policy column (never allows it)", () => {
    const denied = rowPolicyDecision(
      { read: { column: "owner", equals: ".id" } },
      "read",
      { id: "9", amount: 5 },
      principal("alice"),
    );
    expect(denied).toMatchObject({ allowed: false, reason: ROW_POLICY_REASON });
    expect(denied.allowed === false && denied.message).toMatch(/has no 'owner' value/);
    // null and empty are "missing": a row that cannot prove an owner is not
    // everybody's row.
    for (const row of [{ owner: null }, { owner: "" }, {}]) {
      expect(
        rowPolicyDecision({ read: { column: "owner", equals: ".id" } }, "read", row, principal("alice"))
          .allowed,
      ).toBe(false);
    }
  });

  it("compares the canonical string form (7 and \"7\" are the same owner)", () => {
    const literal = { read: { column: "owner", equals: "7" } };
    expect(rowPolicyDecision(literal, "read", { owner: 7 }, principal("alice")).allowed).toBe(true);
    expect(rowPolicyDecision(literal, "read", { owner: "7" }, principal("alice")).allowed).toBe(true);
  });

  it("treats auth=none (no principal) as open, exactly like the grant model", () => {
    expect(rowPolicyDecision(policy, "read", { owner: "alice" }, undefined)).toEqual({
      allowed: true,
    });
    expect(resolveRowPolicy(policy, "write", undefined)).toEqual({ kind: "open" });
  });

  it("resolves .id and .name to the principal identity", () => {
    expect(principalPolicyValue({ column: "owner", equals: ".id" }, principal("carol"))).toBe("carol");
    expect(principalPolicyValue({ column: "owner", equals: ".name" }, principal("carol"))).toBe("carol");
    expect(principalPolicyValue({ column: "owner", equals: "team-3" }, principal("carol"))).toBe("team-3");
    expect(principalPolicyValue({ column: "owner", equals: ".id" }, undefined)).toBeNull();
  });

  it("read and write are graded independently", () => {
    const readOnly = { read: { column: "owner", equals: ".id" } };
    expect(rowPolicyDecision(readOnly, "read", { owner: "alice" }, principal("alice")).allowed).toBe(true);
    // No write rule declared → the grant layer alone decides writes.
    expect(rowPolicyDecision(readOnly, "write", { owner: "bob" }, principal("alice")).allowed).toBe(true);
  });

  it("swallows an auditor failure and reports a full denial row when it succeeds", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await auditPolicyDenial((event) => void seen.push(event as never), {
      ns: "n1",
      table: "invoices",
      op: "tables.read",
      principal: "bob",
      reason: ROW_POLICY_REASON,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      ns: "n1",
      table: "invoices",
      op: "tables.read",
      principal: "bob",
      reason: "row_policy",
      outcome: "denied",
    });
    expect(typeof seen[0]!.ts).toBe("string");
    // A throwing auditor can never change the caller's answer.
    await expect(
      auditPolicyDenial(() => {
        throw new Error("audit sink exploded");
      }, { ns: "n1", table: "invoices", op: "tables.read", principal: "bob", reason: ROW_POLICY_REASON }),
    ).resolves.toBeUndefined();
  });
});
