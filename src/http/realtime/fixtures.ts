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
import http from "http";
import os from "os";
import path from "path";
import type { Express, NextFunction, Request, Response } from "express";
import { resolveNamespacesPath } from "../../config";
import { invalidateRealtimeTableCache } from "../routes/realtime";
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
  /**
   * Reuse an existing namespaces root instead of a fresh temp dir. Pass
   * `configNamespacesPath()` when a suite needs the route's table registry
   * (`listTables`) to see the same namespace the feed reads — the registry is
   * config-derived and not injectable.
   */
  root?: string;
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

/** The config-derived namespaces root the route's table registry reads. */
export function configNamespacesPath(): string {
  // GAP-062: fixtures live under the config-derived root, never the cwd.
  return path.resolve(resolveNamespacesPath());
}

export function gitIn(repoDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Declare a generic table for a namespace (`tables/<table>.table.json`, the
 * SUPA-3/SUPA-6 declaration SUPA-5 consumes for key columns and schema
 * version) and drop the cached registry entry that would hide it.
 *
 * The emitted declaration satisfies the route's table-registry validation
 * (`name`, `format`, non-empty `columns`, `primary` naming a column, relative
 * `glob`) so declared tables are visible to both the registry and the feed.
 */
export function writeDeclaredTable(
  namespacePath: string,
  table: string,
  declaration: {
    primary?: string;
    columns: string[];
    schemaVersion?: number;
    glob?: string;
  },
): void {
  const dir = path.join(namespacePath, "tables");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${table}.table.json`),
    JSON.stringify({
      name: table,
      format: "jsonl-objects",
      glob: declaration.glob ?? `${table}/**/*.jsonl`,
      ...(declaration.primary ? { primary: declaration.primary } : {}),
      schemaVersion: declaration.schemaVersion ?? 1,
      columns: declaration.columns.map((name) => ({
        name,
        type: "varchar",
      })),
    }),
    "utf-8",
  );
  invalidateRealtimeTableCache();
}

/**
 * Middleware that installs the principal the auth-ready route reads through
 * `getPrincipal(req)` — the same seam the real auth middleware populates.
 */
export function principalMiddleware(
  principal: unknown,
): (req: Request, _res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
    (req as Request & { user?: unknown }).user = principal;
    next();
  };
}

export interface RunningApp {
  port: number;
  server: http.Server;
  url(path: string): string;
  /** Close the listener and every open SSE connection. */
  close(): Promise<void>;
}

/** Listen on an ephemeral loopback port and track sockets for clean teardown. */
export function startApp(app: Express): Promise<RunningApp> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    const sockets = new Set<import("net").Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("test server did not bind a TCP port"));
        return;
      }
      resolve({
        port: address.port,
        server,
        url: (p: string) => `http://127.0.0.1:${address.port}${p}`,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

export interface SseClient {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  /** Everything received so far. */
  text(): string;
  frames(): SseFrame[];
  /** Parsed `duckbrain.change.v1` payloads, in arrival order. */
  events(): Array<Record<string, unknown>>;
  /** SSE `id:` values of change events, in arrival order. */
  cursors(): string[];
  /** Resolves when `predicate` holds; rejects after `timeoutMs`. */
  waitFor(
    predicate: (client: SseClient) => boolean,
    timeoutMs?: number,
  ): Promise<void>;
  /** True once the server ended the response. */
  ended(): boolean;
  close(): void;
}

/** A real HTTP SSE client against a live server. */
export function openSseClient(
  port: number,
  requestPath: string,
  options: { headers?: Record<string, string> } = {},
): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        headers: { accept: "text/event-stream", ...options.headers },
      },
      (res) => {
        let body = "";
        let finished = false;
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          finished = true;
        });
        res.on("error", () => {
          finished = true;
        });
        const client: SseClient = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: () => body,
          frames: () => parseSse(body),
          events: () =>
            parseSse(body)
              .filter((frame) => frame.event === "duckbrain.change.v1")
              .map((frame) => JSON.parse(frame.data ?? "{}")),
          cursors: () =>
            parseSse(body)
              .filter((frame) => frame.event === "duckbrain.change.v1")
              .map((frame) => frame.id ?? ""),
          async waitFor(predicate, timeoutMs = 5000) {
            const start = Date.now();
            while (!predicate(client)) {
              if (Date.now() - start > timeoutMs) {
                throw new Error(
                  `SSE client timed out waiting; received:\n${body}`,
                );
              }
              await delay(20);
            }
          },
          ended: () => finished || res.destroyed,
          close: () => {
            req.destroy();
            res.destroy();
          },
        };
        resolve(client);
      },
    );
    req.on("error", reject);
  });
}

/** Wait for a predicate with a bounded budget. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await delay(10);
  }
}

export function createRealtimeFixture(
  prefix: string,
  options: RealtimeFixtureOptions = {},
): RealtimeFixture {
  const ownsRoot = options.root === undefined;
  if (options.root !== undefined)
    fs.mkdirSync(options.root, { recursive: true });
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
      // A shared (config-derived) root belongs to the test worker, not to the
      // fixture: deleting it would remove sibling namespaces.
      if (ownsRoot) fs.rmSync(root, { recursive: true, force: true });
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
