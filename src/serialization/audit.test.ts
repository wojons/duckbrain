import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createMemory } from "../schema/memory";
import { appendAuditRow, readAuditRows } from "./audit";
import { NamespaceWriter } from "./namespaceWriter";

function request(ns: string, index: number) {
  return {
    ns,
    table: "memories",
    op: "insert" as const,
    record: createMemory({
      key: `/audit/${index}`,
      domain: "event" as const,
      author: "test@example.com",
      embedding_text: `audit ${index}`,
    }),
    principal: { name: "writer", authenticated: true },
    targetPath: "event/2026-09/current.jsonl",
    partitionPath: "event/2026-09/",
  };
}

describe("SUPA-2 audit rows", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-supa2-audit-"));
    fs.mkdirSync(path.join(root, "alpha"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes a matching accepted row behind every acknowledged write", async () => {
    const writer = new NamespaceWriter("alpha", {
      namespacesPath: root,
      scheduleCommit: () => undefined,
    });
    const result = await writer.enqueue(request("alpha", 1));
    expect(result).toEqual({ seq: 1, ok: true });
    expect(readAuditRows(root, "alpha")).toMatchObject([
      {
        ns: "alpha",
        table: "memories",
        op: "insert",
        principal: "writer",
        outcome: "accepted",
        seq: 1,
      },
    ]);
  });

  it("writes enqueue denials without entering the data queue", async () => {
    const writer = new NamespaceWriter("alpha", {
      namespacesPath: root,
      scheduleCommit: () => undefined,
      authorization: () => ({
        allowed: false,
        reason: "table_grant",
        message: "write denied",
      }),
    });
    const result = await writer.enqueue(request("alpha", 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
    expect(writer.pendingRows).toBe(0);
    expect(readAuditRows(root, "alpha")).toMatchObject([
      { outcome: "denied", reason: "table_grant", principal: "writer" },
    ]);
  });

  it("does not subject internal audit appends to data queue pressure", async () => {
    const writer = new NamespaceWriter("alpha", {
      namespacesPath: root,
      scheduleCommit: () => undefined,
      maxPendingRows: 1,
      autoFlush: false,
    });
    const data = writer.enqueue(request("alpha", 1));
    await new Promise((resolve) => setImmediate(resolve));
    const audit = appendAuditRow(
      "alpha",
      {
        ts: new Date().toISOString(),
        ns: "alpha",
        table: "memories",
        op: "insert",
        principal: "admin",
        outcome: "denied",
        reason: "role",
      },
      writer,
    );
    await writer.flush();
    expect(await data).toEqual({ seq: 1, ok: true });
    await expect(audit).resolves.toBeUndefined();
    expect(readAuditRows(root, "alpha")).toHaveLength(2);
  });
});
