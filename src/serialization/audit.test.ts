import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createMemory } from "../schema/memory";
import { acceptedTableMutationRecord, appendAuditRow, readAuditRows } from "./audit";
import { contentHashFor, isChangeRecordCandidate } from "./changeRecord";
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

describe("SUPA-5 accepted table-mutation change records", () => {
  let root: string;
  let nsPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-supa2-audit-mut-"));
    nsPath = path.join(root, "alpha");
    fs.mkdirSync(path.join(nsPath, "tables"), { recursive: true });
    fs.writeFileSync(
      path.join(nsPath, "tables", "widgets.table.json"),
      JSON.stringify({
        name: "widgets",
        format: "jsonl-objects",
        glob: "tables/widgets.jsonl",
        primary: "id",
        schemaVersion: 3,
        columns: [
          { name: "id", type: "integer" },
          { name: "qty", type: "integer" },
        ],
      }),
      "utf-8",
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("emits every marker isChangeRecordCandidate and replay require", () => {
    const line = JSON.stringify({ id: 1, qty: 4 });
    const record = acceptedTableMutationRecord({
      ns: "alpha",
      namespacePath: nsPath,
      table: "widgets",
      op: "update",
      principal: "writer",
      targetPath: "tables/widgets.jsonl",
      dataLine: line,
      row: { id: 1, qty: 4 },
      ts: "2026-10-18T00:00:00.000Z",
    });

    // The marker `contentHash` is the digest of the EXACT line on disk, so
    // replay can prove the record still describes a real row image.
    expect(record.contentHash).toBe(contentHashFor(line));
    expect(record.targetPath).toBe("tables/widgets.jsonl");
    expect(record.key).toEqual({ id: 1 });
    expect(record.tombstone).toBe(false);
    expect(record.schemaVersion).toBe(3);
    expect(isChangeRecordCandidate(record as Record<string, unknown>)).toBe(
      true,
    );
  });

  it("marks deletes as tombstones and keeps the declared key material", () => {
    const record = acceptedTableMutationRecord({
      ns: "alpha",
      namespacePath: nsPath,
      table: "widgets",
      op: "delete",
      principal: null,
      targetPath: "tables/widgets.jsonl",
      dataLine: JSON.stringify({ id: 2, qty: 0 }),
      row: { id: 2, qty: 0 },
      removed: true,
    });

    expect(record.tombstone).toBe(true);
    expect(record.key).toEqual({ id: 2 });
    // A tombstone record is still a candidate: replay must see it and resolve
    // its row image, never treat it as a marker-less audit row.
    expect(isChangeRecordCandidate(record as Record<string, unknown>)).toBe(
      true,
    );
  });
});
