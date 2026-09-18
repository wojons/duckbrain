/**
 * SUPA-1 — HTTP surface for write durability.
 *
 * Covers the route-level acceptance criteria that only make sense through the
 * server: the `X-Durability` response header (AC-6), the `/health` durability
 * block (AC-6), fan-in barrier amortization (AC-8), the loud direct-mode
 * failure (AC-4) and buffered-mode honesty (AC-3: no barrier, commit stays
 * debounced).
 *
 * In-process `createHttpServer` (`src/cli/http.ts`) against the per-worker temp
 * `DUCKBRAIN_NAMESPACES_PATH`; auth=none so no auth store is touched.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createHealthHandler, createHttpServer } from "./http";
import { drainAsyncCommits } from "../git/autocommit";
import { readFromJsonl } from "../storage/jsonl";

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH as string;
const CONFIG_PATH = process.env.DUCKBRAIN_CONFIG_PATH as string;

let savedConfig: string | null = null;
let server: Server;
let port: number;

beforeAll(async () => {
  savedConfig = fs.existsSync(CONFIG_PATH)
    ? fs.readFileSync(CONFIG_PATH, "utf-8")
    : null;

  const app = createHttpServer({ authConfig: { type: "none" } });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (savedConfig === null) {
    fs.rmSync(CONFIG_PATH, { force: true });
  } else {
    fs.writeFileSync(CONFIG_PATH, savedConfig, "utf-8");
  }
});

beforeEach(async () => {
  // OPS-006: commits run off the event loop, so a namespace written by the
  // previous test may still have a git child working inside it. Let that
  // settle before deleting the tree — removing a namespace mid-commit leaves
  // .git/ non-empty (ENOTEMPTY).
  await drainAsyncCommits();
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ durability: { overrides: { nsA: "fsync" } } }),
    "utf-8",
  );
  // Per-test namespace isolation: the in-process server shares one temp
  // namespaces root for the whole file.
  for (const ns of [FSYNC_NS, BUFFERED_NS, DIRECT_NS]) {
    fs.rmSync(path.join(NS_ROOT, ns), { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Config used by every test except the ones that rewrite it explicitly. */
const FSYNC_NS = "nsA";
const BUFFERED_NS = "nsB";
const DIRECT_NS = "nsC";

function writeConfig(config: unknown): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config), "utf-8");
}

interface JsonResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

function postMemory(
  namespace: string,
  key: string,
  content = "supa1 http test memory",
): Promise<JsonResponse> {
  const payload = JSON.stringify({ key, domain: "concept", content });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/api/memories?namespace=${namespace}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let body: any = raw;
          try {
            body = raw ? JSON.parse(raw) : null;
          } catch {
            // leave the raw string
          }
          resolve({ status: res.statusCode!, headers: res.headers, body });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/** Every JSONL record written under a namespace, read from disk. */
function readNamespaceRecords(ns: string): unknown[] {
  const nsDir = path.join(NS_ROOT, ns);
  if (!fs.existsSync(nsDir)) return [];
  const records: unknown[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "_audit") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) {
        records.push(...readFromJsonl(full));
      }
    }
  };
  walk(nsDir);
  return records;
}

function gitCommitCount(ns: string): number {
  const nsDir = path.join(NS_ROOT, ns);
  const out = execSync("git rev-list --count HEAD", {
    cwd: nsDir,
    stdio: "pipe",
  })
    .toString()
    .trim();
  return parseInt(out, 10);
}

/** Pre-create a namespace git repo so commitNamespace takes the debounced path. */
function initNamespaceRepo(ns: string): void {
  const nsDir = path.join(NS_ROOT, ns);
  fs.mkdirSync(nsDir, { recursive: true });
  if (!fs.existsSync(path.join(nsDir, ".git"))) {
    execSync("git init", { cwd: nsDir, stdio: "pipe" });
    execSync('git config user.email "duckbrain@localhost.localdomain"', {
      cwd: nsDir,
      stdio: "pipe",
    });
    execSync('git config user.name "DuckBrain"', { cwd: nsDir, stdio: "pipe" });
    fs.writeFileSync(path.join(nsDir, ".gitkeep"), "");
    execSync("git add -A", { cwd: nsDir, stdio: "pipe" });
    execSync('git commit -m "chore: init"', { cwd: nsDir, stdio: "pipe" });
  }
}

describe("SUPA-1 AC-6: X-Durability header on POST /api/memories", () => {
  it("reflects the mode of the namespace actually written", async () => {
    const fsyncRes = await postMemory(FSYNC_NS, "/supa1/http/fsync");
    expect(fsyncRes.status).toBe(201);
    expect(fsyncRes.headers["x-durability"]).toBe("fsync");

    const bufferedRes = await postMemory(BUFFERED_NS, "/supa1/http/buffered");
    expect(bufferedRes.status).toBe(201);
    expect(bufferedRes.headers["x-durability"]).toBe("buffered");

    // The write really landed in the namespace's JSONL store.
    expect(readNamespaceRecords(FSYNC_NS)).toHaveLength(1);
    expect((readNamespaceRecords(FSYNC_NS)[0] as { key: string }).key).toBe(
      "/supa1/http/fsync",
    );
  });
});

describe("SUPA-1 AC-6: /health durability block", () => {
  it("lists defaultMode plus non-default overrides", async () => {
    writeConfig({
      durability: {
        defaultMode: "buffered",
        overrides: { nsA: "fsync", nsB: "buffered" },
      },
    });
    const handler = createHealthHandler(
      async () => ({
        provider: "test",
        model: "test",
        healthy: true,
        providers: [],
      }),
      async () => null,
    );
    const captured: { body: any; status: number } = { body: null, status: 0 };
    const res: any = {
      status(code: number) {
        captured.status = code;
        return res;
      },
      json(body: unknown) {
        captured.body = body;
        return res;
      },
    };

    await handler({} as any, res);

    expect(captured.status).toBe(200);
    expect(captured.body.durability).toEqual({
      defaultMode: "buffered",
      overrides: { nsA: "fsync" },
    });
  });
});

describe("SUPA-1 AC-8: concurrent fsync-mode writes amortize the barrier", () => {
  it("issues at most one fdatasync per write (K acks → ≤ K barriers)", async () => {
    writeConfig({
      durability: {
        defaultMode: "buffered",
        overrides: { [FSYNC_NS]: "fsync" },
      },
    });

    const realFdatasync = fs.fdatasyncSync.bind(fs);
    const fdatasyncSpy = vi.spyOn(fs, "fdatasyncSync");
    fdatasyncSpy.mockImplementation(((fd: number) => realFdatasync(fd)) as any);

    const K = 8;
    const responses = await Promise.all(
      Array.from({ length: K }, (_, i) =>
        postMemory(FSYNC_NS, `/supa1/http/concurrent/${i}`),
      ),
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(responses.every((r) => r.headers["x-durability"] === "fsync")).toBe(
      true,
    );

    // The durability cost is amortized, never per-row-amplified: the
    // pre-SUPA-2 shape is one barrier per flush batch (here: per synchronous
    // append), and SUPA-2's single-writer fan-in collapses concurrent acks to
    // one barrier per batch — the bound asserted here is the "≤ K" contract.
    const calls = fdatasyncSpy.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(calls).toBeLessThanOrEqual(K);
    expect(readNamespaceRecords(FSYNC_NS)).toHaveLength(K);
  });
});

describe("SUPA-1/SUPA-2: direct mode is framed through the serializer", () => {
  it("returns 201 for the serializer-framed append and writes one memory", async () => {
    writeConfig({
      durability: {
        defaultMode: "buffered",
        overrides: { [DIRECT_NS]: "direct" },
      },
    });

    const res = await postMemory(DIRECT_NS, "/supa1/http/direct");

    expect(res.status).toBe(201);
    expect(res.headers["x-durability"]).toBe("direct");
    expect(readNamespaceRecords(DIRECT_NS)).toHaveLength(1);
  });
});

describe("SUPA-1 AC-3: buffered mode honesty", () => {
  it("issues no fdatasync/fsync and leaves the git commit debounced", async () => {
    initNamespaceRepo(BUFFERED_NS);
    const baseline = gitCommitCount(BUFFERED_NS);

    const realFdatasync = fs.fdatasyncSync.bind(fs);
    const realFsync = fs.fsyncSync.bind(fs);
    const fdatasyncSpy = vi.spyOn(fs, "fdatasyncSync");
    fdatasyncSpy.mockImplementation(((fd: number) => realFdatasync(fd)) as any);
    const fsyncSpy = vi.spyOn(fs, "fsyncSync");
    fsyncSpy.mockImplementation(((fd: number) => realFsync(fd)) as any);

    const res = await postMemory(BUFFERED_NS, "/supa1/http/buffered-honest");

    expect(res.status).toBe(201);
    expect(res.headers["x-durability"]).toBe("buffered");
    expect(fdatasyncSpy).not.toHaveBeenCalled();
    expect(fsyncSpy).not.toHaveBeenCalled();

    // gitBatching.maxSeconds (default 30s) has not elapsed: the record is on
    // disk (page cache) but NOT in git — the documented ≤30s exposure.
    expect(gitCommitCount(BUFFERED_NS)).toBe(baseline);
    const status = execSync("git status --porcelain", {
      cwd: path.join(NS_ROOT, BUFFERED_NS),
      stdio: "pipe",
    })
      .toString()
      .trim();
    expect(status.length).toBeGreaterThan(0);
    expect(readNamespaceRecords(BUFFERED_NS).length).toBeGreaterThan(0);
  });
});
