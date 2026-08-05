import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChildProcess, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  getRandomPort,
  startDuckbrainHttp,
  killProcess,
  waitForUrl,
  curl,
} from "./helpers";

const port = getRandomPort();
let server: ChildProcess;

describe("HTTP Server E2E Integration", () => {
  beforeAll(async () => {
    server = await startDuckbrainHttp({ port });
    await waitForUrl(`http://127.0.0.1:${port}/health`, 15000);
  }, 30000);

  afterAll(() => {
    killProcess(server);
  });

  it("should respond to /health with uptime and status", async () => {
    const res = await curl(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("healthy");
    expect(body.uptime).toBeGreaterThan(0);
    expect(body.timestamp).toBeTruthy();
  });

  it("should respond to /stats", async () => {
    const res = await curl(`http://127.0.0.1:${port}/stats`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.nodeVersion).toBeTruthy();
  });

  it("should respond to /namespaces", async () => {
    const res = await curl(`http://127.0.0.1:${port}/namespaces`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.namespaces).toBeDefined();
  });

  it("should respond to /users with authors array", async () => {
    const res = await curl(`http://127.0.0.1:${port}/users`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.users).toBeDefined();
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.count).toBe(body.users.length);
  });

  it("should respond to /activity with activities array", async () => {
    const res = await curl(`http://127.0.0.1:${port}/activity`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.activities).toBeDefined();
    expect(Array.isArray(body.activities)).toBe(true);
    expect(body.count).toBe(body.activities.length);
  });

  it("should respond to /api/tree with redirect to /api/keys", async () => {
    const res = await curl(`http://127.0.0.1:${port}/api/tree`);
    expect(res.status).toBe(301);
    expect(res.headers).toContain("/api/keys");
  });

  it("should respond to /api/timeline with redirect to /api/memories", async () => {
    const res = await curl(`http://127.0.0.1:${port}/api/timeline`);
    expect(res.status).toBe(301);
    expect(res.headers).toContain("/api/memories");
  });

  it("should respond to /api/search with redirect to /api/memories", async () => {
    const res = await curl(`http://127.0.0.1:${port}/api/search`);
    expect(res.status).toBe(301);
    expect(res.headers).toContain("/api/memories");
  });

  it("should reject unknown routes with 404", async () => {
    const res = await curl(`http://127.0.0.1:${port}/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("should bind to localhost only by default", async () => {
    const localPort = getRandomPort();
    const localServer = await startDuckbrainHttp({ port: localPort });
    try {
      await waitForUrl(`http://127.0.0.1:${localPort}/health`, 15000);
      const res = await curl(`http://127.0.0.1:${localPort}/health`);
      expect(res.status).toBe(200);
    } finally {
      killProcess(localServer);
    }
  });
});

/**
 * GAP-001 E2E regression: cross-process DuckDB file-lock contention.
 *
 * Simulates the production failure: a second process (fleet stdio MCP
 * server) holds an exclusive read-write lock on <namespace>/duckdb.db.
 * Pre-fix, the http daemon's reads then failed with DUCKDB_CONNECTION_LOST
 * (namespace was write-only). Post-fix, readers use per-process scratch
 * files and must serve 200 regardless of the foreign lock.
 */
describe("GAP-001: reads survive a foreign write-lock on the namespace DuckDB file", () => {
  const nsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-gap001-e2e-"));
  const gapPort = getRandomPort();
  let gapServer: ChildProcess;
  let lockHolder: ChildProcess | null = null;
  const savedNsEnv = process.env.DUCKBRAIN_NAMESPACES_PATH;

  function waitForLocked(child: ChildProcess, timeoutMs = 15000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("lock holder did not report LOCKED in time")),
        timeoutMs,
      );
      child.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("LOCKED")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`lock holder exited early with code ${code}`));
      });
    });
  }

  beforeAll(async () => {
    fs.mkdirSync(path.join(nsRoot, "default"), { recursive: true });
    process.env.DUCKBRAIN_NAMESPACES_PATH = nsRoot;
    gapServer = await startDuckbrainHttp({ port: gapPort });
    await waitForUrl(`http://127.0.0.1:${gapPort}/health`, 15000);
  }, 45000);

  afterAll(() => {
    if (lockHolder) killProcess(lockHolder);
    killProcess(gapServer);
    if (savedNsEnv === undefined) {
      delete process.env.DUCKBRAIN_NAMESPACES_PATH;
    } else {
      process.env.DUCKBRAIN_NAMESPACES_PATH = savedNsEnv;
    }
    fs.rmSync(nsRoot, { recursive: true, force: true });
  });

  it("serves /api/keys and /api/memories while another process write-locks the namespace duckdb.db", async () => {
    // Seed a memory through the daemon (writes append JSONL, never duckdb.db)
    const seed = await curl(
      `-X POST -H "Content-Type: application/json" -d '${JSON.stringify({
        key: "/gap001/e2e/locked-read",
        domain: "raw_note",
        content: "seed for GAP-001 lock regression",
      })}' http://127.0.0.1:${gapPort}/api/memories?namespace=default`,
    );
    expect(seed.status).toBe(201);

    // Spawn a child that opens <nsRoot>/default/duckdb.db READ-WRITE and
    // holds the exclusive lock — the production fleet-stdio condition.
    const dbPath = path.join(nsRoot, "default", "duckdb.db");
    const holderScript = path.join(nsRoot, "lock-holder.mjs");
    fs.writeFileSync(
      holderScript,
      [
        'import { createRequire } from "module";',
        'const require = createRequire(process.cwd() + "/package.json");',
        'const { Database } = require("duckdb");',
        "const db = new Database(process.argv[2], { threads: \"1\" });",
        'db.run("CREATE TABLE IF NOT EXISTS lock_probe (i INTEGER)", (err) => {',
        "  if (err) { console.error(\"LOCK FAIL\", err.message); process.exit(1); }",
        '  console.log("LOCKED");',
        "  setInterval(() => {}, 1000);",
        "});",
        "",
      ].join("\n"),
    );
    lockHolder = spawn("node", [holderScript, dbPath], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    await waitForLocked(lockHolder);

    // The namespace's duckdb.db now exists and is write-locked by the child.
    // Pre-fix this made every read on the namespace fail with
    // DUCKDB_CONNECTION_LOST. Post-fix reads must succeed.
    const keys = await curl(
      `http://127.0.0.1:${gapPort}/api/keys?namespace=default&limit=10`,
    );
    expect(keys.status).toBe(200);
    expect(keys.body).toContain("/gap001/e2e/locked-read");

    const memories = await curl(
      `http://127.0.0.1:${gapPort}/api/memories?namespace=default&limit=5`,
    );
    expect(memories.status).toBe(200);
    const parsed = JSON.parse(memories.body);
    expect(parsed.items.length).toBeGreaterThanOrEqual(1);
    expect(parsed.items[0].key).toBe("/gap001/e2e/locked-read");
  }, 30000);
});
