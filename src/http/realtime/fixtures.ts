/**
 * Test fixtures for the DB-SUPA-5 realtime suites.
 *
 * Nothing on the runtime request path imports this module: it exists because
 * eight suites need the same real ingredients — a temporary namespaces root, a
 * real per-namespace git repository, writes through the real `NamespaceWriter`,
 * a real namespace commit, an SSE sink the test controls, and an SSE frame
 * parser. Duplicating that machinery eight times is how a suite drifts away
 * from the contract it is supposed to prove.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createMemory, type MemoryType } from "../../schema/memory";
import {
  NamespaceWriter,
  type NamespaceWriterOptions,
} from "../../serialization/namespaceWriter";
import type { WriteInput } from "../../serialization/types";
import type { SseSink } from "./hub";

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RealtimeFixtureOptions {
  namespace?: string;
  /** Commit inside the flush (default true) or leave rows uncommitted. */
  commitOnFlush?: boolean;
  writerOptions?: Partial<NamespaceWriterOptions>;
  /** Audit-ledger segment line bound (forces rotation in a small fixture). */
  auditMaxLinesPerChunk?: number;
  auditMaxBytesPerChunk?: number;
}

export interface RealtimeFixture {
  root: string;
  ns: string;
  nsPath: string;
  writer: NamespaceWriter;
  /** Force a namespace commit now; returns the resulting HEAD. */
  commit(message?: string): void;
  head(): string | null;
  revList(args: string[]): string[];
  git(args: string[]): string;
  cleanup(): void;
}

export function gitIn(repoDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function createRealtimeFixture(
  prefix: string,
  options: RealtimeFixtureOptions = {},
): RealtimeFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const ns = options.namespace ?? "nsA";
  const nsPath = path.join(root, ns);
  fs.mkdirSync(nsPath, { recursive: true });

  const scheduleCommit =
    options.commitOnFlush === false
      ? () => undefined
      : (namespacePath: string) => {
          // Immediate (undebounced) commit: the fixture's whole point is that a
          // suite can decide exactly when a change becomes committed.
          const { commitNamespaceWithParams } = require("../../git/autocommit");
          commitNamespaceWithParams(
            namespacePath,
            "test: supa5 fixture commit",
            { maxLines: 100, maxSeconds: 30, enabled: false },
          );
        };

  const writer = new NamespaceWriter(ns, {
    namespacesPath: root,
    scheduleCommit,
    ...options.writerOptions,
    ...(options.auditMaxLinesPerChunk !== undefined
      ? { auditMaxLinesPerChunk: options.auditMaxLinesPerChunk }
      : {}),
    ...(options.auditMaxBytesPerChunk !== undefined
      ? { auditMaxBytesPerChunk: options.auditMaxBytesPerChunk }
      : {}),
  });

  const fixture: RealtimeFixture = {
    root,
    ns,
    nsPath,
    writer,
    commit(message = "test: forced commit") {
      try {
        gitIn(nsPath, ["add", "-A"]);
        gitIn(nsPath, ["commit", "-m", message]);
      } catch {
        // Nothing staged — HEAD simply does not move, exactly like the real
        // best-effort autocommit path.
      }
    },
    head() {
      try {
        return gitIn(nsPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
      } catch {
        return null;
      }
    },
    revList(args: string[]) {
      const raw = gitIn(nsPath, ["rev-list", ...args]);
      return raw.split("\n").filter((line) => line !== "");
    },
    git(args: string[]) {
      return gitIn(nsPath, args);
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };

  // Make sure the namespace is a git repository even before the first write,
  // so `head()` answers deterministically and the fixture can commit on demand.
  if (!fs.existsSync(path.join(nsPath, ".git"))) {
    gitIn(nsPath, ["init", "-q"]);
    gitIn(nsPath, ["config", "user.email", "duckbrain@localhost.localdomain"]);
    gitIn(nsPath, ["config", "user.name", "DuckBrain"]);
  }
  return fixture;
}

/** A memory-shaped write input for a fixture namespace. */
export function memoryInput(
  index: number,
  ns: string,
  overrides: Partial<WriteInput> = {},
): WriteInput {
  const record: MemoryType = createMemory({
    key: `/supa5/${ns}/${index}`,
    domain: "concept",
    author: "test@example.com",
    embedding_text: `record ${index}`,
    attributes: { index },
  });
  return {
    ns,
    table: "memories",
    op: "insert",
    record,
    principal: undefined,
    targetPath: "concept/2026-09/current.jsonl",
    partitionPath: "concept/2026-09/",
    ...overrides,
  };
}

/** A tombstone write input for the same record identity. */
export function tombstoneInput(
  record: MemoryType,
  ns: string,
  overrides: Partial<WriteInput> = {},
): WriteInput {
  const tombstone: MemoryType = {
    ...record,
    action: "tombstone",
    timestamp: new Date().toISOString(),
  };
  return {
    ns,
    table: "memories",
    op: "delete",
    record: tombstone,
    principal: undefined,
    targetPath: "concept/2026-09/current.jsonl",
    partitionPath: "concept/2026-09/",
    ...overrides,
  };
}

export interface SseFrame {
  comment: string | null;
  event: string | null;
  id: string | null;
  data: string | null;
  raw: string;
}

/** Parse an SSE stream body into frames (comments included). */
export function parseSse(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of text.split("\n\n")) {
    if (block.trim() === "") continue;
    const frame: SseFrame = {
      comment: null,
      event: null,
      id: null,
      data: null,
      raw: block,
    };
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) {
        frame.comment = line.slice(1).trim();
        continue;
      }
      const separator = line.indexOf(":");
      if (separator < 0) continue;
      const field = line.slice(0, separator);
      const value = line.slice(separator + 1).replace(/^ /, "");
      if (field === "event") frame.event = value;
      else if (field === "id") frame.id = value;
      else if (field === "data") frame.data = value;
    }
    frames.push(frame);
  }
  return frames;
}

export interface RecordingSink extends SseSink {
  readonly frames: string[];
  readonly drained: number;
  closed: boolean;
  blocking: boolean;
  text(): string;
  sse(): SseFrame[];
  changeEvents(): Array<Record<string, unknown>>;
  cursors(): string[];
  drain(): void;
}

/**
 * A response sink whose backpressure the test controls. `blocking = true`
 * models a subscriber that stopped draining: every write buffers (returns
 * false) until `drain()` releases it, so queue bounds are exercised against a
 * real sink rather than inferred from a spy.
 */
export function createRecordingSink(initiallyBlocking = false): RecordingSink {
  const frames: string[] = [];
  const listeners: Array<() => void> = [];
  let closeCount = 0;
  const sink: RecordingSink = {
    frames,
    closed: false,
    blocking: initiallyBlocking,
    get drained() {
      return closeCount;
    },
    write(chunk: string) {
      frames.push(chunk);
      return !sink.blocking;
    },
    onDrain(listener: () => void) {
      listeners.push(listener);
    },
    end() {
      sink.closed = true;
      closeCount += 1;
    },
    drain() {
      sink.blocking = false;
      const pending = listeners.splice(0, listeners.length);
      for (const listener of pending) listener();
    },
    text() {
      return frames.join("");
    },
    sse() {
      return parseSse(sink.text());
    },
    changeEvents() {
      return sink
        .sse()
        .filter((frame) => frame.event === "duckbrain.change.v1")
        .map((frame) => JSON.parse(frame.data ?? "{}"));
    },
    cursors() {
      return sink
        .sse()
        .filter((frame) => frame.event === "duckbrain.change.v1")
        .map((frame) => frame.id ?? "");
    },
  };
  return sink;
}
