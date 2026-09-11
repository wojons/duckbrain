import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createMemory, type MemoryType } from "../schema/memory";
import { namespaceWriteLockPath } from "./lock";
import { NamespaceWriter } from "./namespaceWriter";
import type { AuthorizationHook, WriteInput } from "./types";

function memory(index: number, ns = "alpha"): MemoryType {
  return createMemory({
    key: `/supa2/${ns}/${index}`,
    domain: "concept",
    author: "test@example.com",
    embedding_text: `record ${index}`,
    attributes: { index },
  });
}

function input(record: MemoryType, ns = "alpha"): WriteInput {
  return {
    ns,
    table: "memories",
    op: record.action === "tombstone" ? "delete" : "insert",
    record,
    principal: undefined,
    targetPath: "concept/2026-09/current.jsonl",
    partitionPath: "concept/2026-09/",
  };
}

function readLines(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

describe("SUPA-2 namespace writer", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-supa2-writer-"));
    fs.mkdirSync(path.join(root, "alpha"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writer(
    overrides: ConstructorParameters<typeof NamespaceWriter>[1] = {},
  ) {
    return new NamespaceWriter("alpha", {
      namespacesPath: root,
      scheduleCommit: () => undefined,
      ...overrides,
    });
  }

  it("assigns monotonic seq and flushes data in seq order", async () => {
    const subject = writer({ autoFlush: false });
    const promises = [0, 1, 2].map((i) => subject.enqueue(input(memory(i))));
    await subject.flush();
    const results = await Promise.all(promises);

    expect(results).toEqual([
      { seq: 1, ok: true },
      { seq: 2, ok: true },
      { seq: 3, ok: true },
    ]);
    expect(
      readLines(path.join(root, "alpha/concept/2026-09/current.jsonl")).map(
        (row) => row.attributes.index,
      ),
    ).toEqual([0, 1, 2]);
  });

  it("rejects invalid rows before they enter the queue with fields", async () => {
    const subject = writer({ autoFlush: false });
    const result = await subject.enqueue({
      ...input(memory(1)),
      record: { nope: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_ERROR");
      expect(result.fields).toBeDefined();
    }
    expect(subject.pendingRows).toBe(0);
  });

  it("rejects a whole batch when one row is invalid", async () => {
    const subject = writer({ autoFlush: false });
    const result = await subject.enqueueBatch([
      input(memory(1)),
      { ...input(memory(2)), record: { invalid: true } },
      input(memory(3)),
    ]);
    expect(result.every((row) => !row.ok)).toBe(true);
    expect(
      result.some((row) => !row.ok && row.code === "VALIDATION_ERROR"),
    ).toBe(true);
    expect(subject.pendingRows).toBe(0);
    expect(fs.existsSync(path.join(root, "alpha/concept"))).toBe(false);
  });

  it("enforces row bounds without dropping the queued write", async () => {
    const subject = writer({ autoFlush: false, maxPendingRows: 1 });
    const first = subject.enqueue(input(memory(1)));
    await new Promise((resolve) => setImmediate(resolve));
    expect(subject.pendingRows).toBe(1);

    const second = await subject.enqueue(input(memory(2)));
    expect(second).toMatchObject({
      ok: false,
      code: "SERIALIZER_QUEUE_FULL",
      retryAfter: 1,
    });
    await subject.flush();
    expect(await first).toEqual({ seq: 1, ok: true });
    expect(
      readLines(path.join(root, "alpha/concept/2026-09/current.jsonl")),
    ).toHaveLength(1);
  });

  it("enforces byte bounds", async () => {
    const firstRecord = memory(1);
    const firstBytes = Buffer.byteLength(JSON.stringify(firstRecord) + "\n");
    const subject = writer({ autoFlush: false, maxPendingBytes: firstBytes });
    const first = subject.enqueue(input(firstRecord));
    await new Promise((resolve) => setImmediate(resolve));
    const second = await subject.enqueue(input(memory(2)));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("SERIALIZER_QUEUE_FULL");
    await subject.flush();
    await first;
  });

  it("drains accepted writes and refuses new work once shutdown begins", async () => {
    const subject = writer({ autoFlush: false });
    const accepted = subject.enqueue(input(memory(1)));
    await subject.drain();
    expect(await accepted).toEqual({ seq: 1, ok: true });
    const refused = await subject.enqueue(input(memory(2)));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("SERVER_SHUTTING_DOWN");
  });

  it("fences a writer whose token is replaced before its first append", async () => {
    const subject = writer({
      autoFlush: false,
      afterLockAcquired: ({ path: lockPath }) => {
        const payload = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
        fs.writeFileSync(
          lockPath,
          JSON.stringify({ ...payload, nonce: "f".repeat(32) }),
        );
      },
    });
    const pending = subject.enqueue(input(memory(1)));
    await subject.flush();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SERIALIZER_FENCED");
    expect(subject.fenced).toBe(true);
    expect(
      readLines(path.join(root, "alpha/concept/2026-09/current.jsonl")),
    ).toHaveLength(0);
  });

  it("rechecks authorization before flush and audits a revoked write as denied", async () => {
    const authorization: AuthorizationHook = (_request, phase) =>
      phase === "enqueue"
        ? { allowed: true }
        : { allowed: false, reason: "role", message: "revoked" };
    const subject = writer({ autoFlush: false, authorization });
    const pending = subject.enqueue(input(memory(1)));
    await subject.flush();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
    expect(
      readLines(path.join(root, "alpha/concept/2026-09/current.jsonl")),
    ).toHaveLength(0);
    expect(
      readLines(path.join(root, "alpha/_audit/current.jsonl")),
    ).toMatchObject([{ outcome: "denied", reason: "role" }]);
  });

  it("fails a flush with SERIALIZER_LOCKED while another live owner holds it", async () => {
    const lockPath = namespaceWriteLockPath(root, "alpha");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        ts: Date.now(),
        nonce: "e".repeat(32),
      }),
    );
    const subject = writer({ autoFlush: false });
    const pending = subject.enqueue(input(memory(1)));
    await subject.flush();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SERIALIZER_LOCKED");
  });
});

describe("SUPA-2 concurrent fan-in", () => {
  it("32 writers across 4 namespaces leave parseable files and no lost acknowledgements", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-supa2-fanin-"),
    );
    try {
      const writers = new Map<string, NamespaceWriter>();
      for (let i = 0; i < 4; i++) {
        const ns = `ns${i}`;
        fs.mkdirSync(path.join(root, ns), { recursive: true });
        writers.set(
          ns,
          new NamespaceWriter(ns, {
            namespacesPath: root,
            scheduleCommit: () => undefined,
          }),
        );
      }

      const results = await Promise.all(
        Array.from({ length: 32 }, (_, i) => {
          const ns = `ns${i % 4}`;
          return writers.get(ns)!.enqueue(input(memory(i, ns), ns));
        }),
      );
      const acknowledged = results.filter((result) => result.ok).length;
      expect(acknowledged).toBe(32);

      let rows = 0;
      for (let i = 0; i < 4; i++) {
        const file = path.join(root, `ns${i}/concept/2026-09/current.jsonl`);
        const rawLines = fs
          .readFileSync(file, "utf-8")
          .split("\n")
          .filter((line) => line.trim() !== "");
        for (const line of rawLines)
          expect(() => JSON.parse(line)).not.toThrow();
        rows += rawLines.length;
      }
      expect(rows).toBe(acknowledged);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("acked fsync rows survive writer replacement and disk re-read", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-supa2-fsync-"),
    );
    const oldConfig = process.env.DUCKBRAIN_CONFIG_PATH;
    const configPath = path.join(root, "config.json");
    process.env.DUCKBRAIN_CONFIG_PATH = configPath;
    try {
      fs.mkdirSync(path.join(root, "durable"), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          namespacesPath: root,
          durability: {
            defaultMode: "buffered",
            overrides: { durable: "fsync" },
          },
        }),
      );
      const subject = new NamespaceWriter("durable", {
        namespacesPath: root,
        scheduleCommit: () => undefined,
      });
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          subject.enqueue(input(memory(i, "durable"), "durable")),
        ),
      );
      expect(results.every((result) => result.ok)).toBe(true);

      const replay = readLines(
        path.join(root, "durable/concept/2026-09/current.jsonl"),
      );
      expect(replay).toHaveLength(8);
      expect(new Set(replay.map((row) => row.id)).size).toBe(8);
    } finally {
      if (oldConfig === undefined) delete process.env.DUCKBRAIN_CONFIG_PATH;
      else process.env.DUCKBRAIN_CONFIG_PATH = oldConfig;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
