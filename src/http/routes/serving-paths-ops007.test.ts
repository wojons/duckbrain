/**
 * OPS-007 — the two remaining synchronous child-process spawns on
 * HTTP-serving paths must be gone:
 *
 *  - `git init` in `createNamespaceTool` (POST /api/namespaces)
 *  - `git log --all --format=%aN` in the GET /users handler (per namespace)
 *
 * The proof is BEHAVIOURAL, mirroring `src/git/autocommit-ops006.test.ts`:
 *
 *  1. the synchronous child-process primitives (`execSync` / `spawnSync`) are
 *     patched to STALL the event loop for 1500ms when product code calls them,
 *     and counted. While GET /users (and `createNamespaceTool`) run, a 50ms
 *     heartbeat on the SAME loop must keep firing (<250ms gaps) and a
 *     concurrent cheap route must answer (<500ms). Pre-fix both product paths
 *     call `execSync`, so the loop is held for the whole stall and every one of
 *     those assertions fails.
 *  2. the recorded async `execFile` calls must all carry a finite `timeout`
 *     (bounded child execution) — no unbounded spawn.
 *  3. ordinary behaviour is unchanged: git authors are deduplicated + sorted,
 *     a namespace with no git repo still contributes nothing (DuckDB fallback)
 *     and the response shape is identical; a failing `git init` still warns and
 *     still creates the namespace.
 *
 * Isolation: `DUCKBRAIN_NAMESPACES_PATH` + `DUCKBRAIN_CONFIG_PATH` are the
 * suite temp dirs created by `src/test-setup.ts`, so no live namespace, no
 * tracked `duckbrain.config.json` and no production daemon is touched. Git
 * calls made by the TESTS use `execFileSync` (never the patched primitives).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "child_process";
import express from "express";
import { createServer, Server, request as httpRequest } from "http";
import fs from "fs";
import os from "os";
import path from "path";

/** Stall duration the patched sync primitive burns on its first armed call. */
const SYNC_STALL_MS = 1500;
/**
 * Upper bound a heartbeat gap may reach while a serving path runs. Sits well
 * below SYNC_STALL_MS so the pre-fix (synchronous) signature — a gap of >= the
 * whole stall — is unmistakable, while staying robust on a loaded host where a
 * 50ms tick can slip.
 */
const HEARTBEAT_BUDGET_MS = 1000;
/** Heartbeat sampling cadence. */
const HEARTBEAT_INTERVAL_MS = 50;
/** Upper bound for the concurrent cheap route while git runs (< SYNC_STALL_MS). */
const CONCURRENT_ROUTE_BUDGET_MS = 1000;

/** Tripwire recorder (hoisted so the `vi.mock` factory below can reach it). */
const rec = vi.hoisted(() => ({
  /** Synchronous child-process spawns product code performed. */
  syncCalls: 0,
  /** True → the NEXT sync spawn burns SYNC_STALL_MS (arms one call at a time). */
  armed: false,
  /** Every async `execFile` product code performed. */
  execFileCalls: [] as { argv: string[]; cwd: string; timeoutMs?: number }[],
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();

  /** Burn the event loop for SYNC_STALL_MS — exactly what execSync does. */
  const stall = (): void => {
    const end = Date.now() + SYNC_STALL_MS;
    while (Date.now() < end) {
      /* intentionally busy: a synchronous primitive blocks, it does not yield */
    }
  };

  const recordSyncSpawn = (): void => {
    rec.syncCalls += 1;
    if (rec.armed) {
      rec.armed = false;
      stall();
    }
  };

  return {
    ...actual,
    execSync: (...args: unknown[]) => {
      recordSyncSpawn();
      return (actual.execSync as (...a: unknown[]) => unknown)(...args);
    },
    spawnSync: (...args: unknown[]) => {
      recordSyncSpawn();
      return (actual.spawnSync as (...a: unknown[]) => unknown)(...args);
    },
    execFile: (...args: unknown[]) => {
      const [, argv, options] = args as [
        string,
        string[],
        { cwd?: string; timeout?: number } | undefined,
      ];
      rec.execFileCalls.push({
        argv: Array.isArray(argv) ? argv : [],
        cwd: options?.cwd ?? "",
        timeoutMs: options?.timeout,
      });
      return (actual.execFile as (...a: unknown[]) => unknown)(...args);
    },
  };
});

import { createUsersRoutes } from "./users";
import { createNamespaceTool } from "../../mcp/tools/namespace";

const CONFIG_PATH =
  process.env.DUCKBRAIN_CONFIG_PATH ||
  path.join(process.cwd(), "duckbrain.config.json");
const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
/** Namespace name mapped to the scratch repo that carries two git authors. */
const AUTHOR_NS = "ops007-authors";

let server: Server;
let port: number;
let scratchRepo: string;
let configSnapshot: string;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimal HTTP round trip against the test server, returning elapsed ms. */
function get(
  pathName: string,
): Promise<{ status: number; body: any; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path: pathName, method: "GET" },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          const elapsedMs = Date.now() - started;
          try {
            resolve({
              status: res.statusCode!,
              body: JSON.parse(data),
              elapsedMs,
            });
          } catch {
            resolve({ status: res.statusCode!, body: data, elapsedMs });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  // Track the TEMP config so every mutation this file makes is reverted.
  configSnapshot = fs.existsSync(CONFIG_PATH)
    ? fs.readFileSync(CONFIG_PATH, "utf-8")
    : "";

  // A real namespace repo with two distinct authors (one name repeated).
  scratchRepo = fs.mkdtempSync(
    path.join(os.tmpdir(), "duckbrain-ops007-repo-"),
  );
  git(scratchRepo, "init", "-q");
  fs.writeFileSync(path.join(scratchRepo, "current.jsonl"), "{}\n", "utf8");
  git(
    scratchRepo,
    "-c",
    "user.name=Ada Lovelace",
    "-c",
    "user.email=ada@x",
    "add",
    "-A",
  );
  git(
    scratchRepo,
    "-c",
    "user.name=Ada Lovelace",
    "-c",
    "user.email=ada@x",
    "commit",
    "-q",
    "-m",
    "feat: first",
  );
  git(
    scratchRepo,
    "-c",
    "user.name=Grace Hopper",
    "-c",
    "user.email=grace@x",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "feat: second",
  );
  git(
    scratchRepo,
    "-c",
    "user.name=Ada Lovelace",
    "-c",
    "user.email=ada@x",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "feat: third",
  );

  // Register it in the (temp) config BEFORE any route call, so a cached
  // getConfig can never hide the mapping from the /users scan.
  const cfg = configSnapshot ? JSON.parse(configSnapshot) : {};
  cfg.namespacesPath = NS_ROOT;
  cfg.namespaceMappings = {
    ...(cfg.namespaceMappings || {}),
    [AUTHOR_NS]: scratchRepo,
  };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");

  // Real routes, minimal app: the users router as the daemon mounts it plus a
  // cheap liveness route standing in for the daemon's /health.
  const app = express();
  app.use("/users", createUsersRoutes);
  app.get("/health", (_req, res) => {
    res.json({ status: "healthy" });
  });
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") port = addr.port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Restore the temp config file (never the repo config).
  if (configSnapshot) fs.writeFileSync(CONFIG_PATH, configSnapshot, "utf-8");
  else if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
});

describe("OPS-007: GET /users never blocks the event loop on git", () => {
  it("serves a concurrent route + heartbeat while the author scan runs", async () => {
    const syncBefore = rec.syncCalls;
    const gaps: number[] = [];
    let last = Date.now();
    const heartbeat = setInterval(() => {
      const now = Date.now();
      gaps.push(now - last);
      last = now;
    }, HEARTBEAT_INTERVAL_MS);

    let health: { status: number; elapsedMs: number };
    let users: { status: number; body: any };
    try {
      // Arm the sync tripwire for the call the route is about to make:
      // pre-fix that call stalls the loop for SYNC_STALL_MS.
      rec.armed = true;
      const usersPromise = get("/users");
      await delay(150);
      health = await get("/health");
      users = await usersPromise;
      // A stalled loop cannot run the heartbeat DURING the stall — the overdue
      // tick only lands once the loop is free, so let one beat pass first.
      await delay(4 * HEARTBEAT_INTERVAL_MS);
    } finally {
      clearInterval(heartbeat);
      rec.armed = false;
    }

    // Non-blocking: the concurrent cheap route answered while git ran…
    expect(health!.status).toBe(200);
    expect(health!.elapsedMs).toBeLessThan(CONCURRENT_ROUTE_BUDGET_MS);
    // …and the loop kept ticking throughout the scan.
    expect(gaps.length).toBeGreaterThan(3);
    expect(Math.max(...gaps)).toBeLessThan(HEARTBEAT_BUDGET_MS);
    // No synchronous spawn was reachable from the route.
    expect(rec.syncCalls - syncBefore).toBe(0);

    // Response shape unchanged.
    expect(users!.status).toBe(200);
    expect(Array.isArray(users!.body.users)).toBe(true);
    expect(users!.body.count).toBe(users!.body.users.length);
  });

  it("deduplicates git authors and still answers when a namespace has no git", async () => {
    const { status, body } = await get("/users");

    expect(status).toBe(200);
    expect(body.users).toContain("Ada Lovelace");
    expect(body.users).toContain("Grace Hopper");
    // Deduplicated (Ada authored 3 commits → one entry) and sorted.
    expect(body.users.filter((u: string) => u === "Ada Lovelace")).toHaveLength(
      1,
    );
    expect(body.users).toEqual([...body.users].sort());
    expect(body.count).toBe(body.users.length);
    // The DuckDB-fallback namespace (no .git) contributed nothing but did not
    // break the response — the fallback path ran, the route stayed 200.
    expect(body.users.length).toBeGreaterThanOrEqual(2);

    // Bounded child execution: every async git call carried a finite timeout.
    const authorCalls = rec.execFileCalls.filter((c) => c.argv.includes("log"));
    expect(authorCalls.length).toBeGreaterThan(0);
    for (const call of authorCalls) {
      expect(call.argv).toContain("--format=%aN");
      expect(call.timeoutMs).toBeDefined();
      expect(call.timeoutMs!).toBeGreaterThan(0);
      expect(call.timeoutMs!).toBeLessThanOrEqual(5000);
    }
  });
});

describe("OPS-007: createNamespaceTool never blocks the event loop on git init", () => {
  it("keeps a heartbeat firing and still inits the repo", async () => {
    const name = "ops007-nonblock";
    const syncBefore = rec.syncCalls;
    const initBefore = rec.execFileCalls.length;
    const gaps: number[] = [];
    let last = Date.now();
    const heartbeat = setInterval(() => {
      const now = Date.now();
      gaps.push(now - last);
      last = now;
    }, HEARTBEAT_INTERVAL_MS);

    let created: { success: boolean; path?: string; error?: string };
    try {
      rec.armed = true;
      created = await createNamespaceTool({ name, setDefault: false });
      await delay(4 * HEARTBEAT_INTERVAL_MS);
    } finally {
      clearInterval(heartbeat);
      rec.armed = false;
    }

    expect(created!.success).toBe(true);
    expect(rec.syncCalls - syncBefore).toBe(0);
    expect(Math.max(...gaps)).toBeLessThan(HEARTBEAT_BUDGET_MS);

    // …and the init genuinely happened (the assertion is not vacuous).
    const nsPath = created!.path!;
    expect(fs.existsSync(path.join(nsPath, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(nsPath, "manifest.json"))).toBe(true);

    // The spawn was the async, bounded one.
    const initCalls = rec.execFileCalls.slice(initBefore);
    const initCall = initCalls.find((c) => c.argv.includes("init"));
    expect(initCall).toBeDefined();
    expect(initCall!.cwd).toBe(nsPath);
    expect(initCall!.timeoutMs).toBeDefined();
    expect(initCall!.timeoutMs!).toBeGreaterThan(0);
    expect(initCall!.timeoutMs!).toBeLessThanOrEqual(15_000);
  });

  it("still creates the namespace and warns when git init fails (best-effort)", async () => {
    // A `git` first on PATH that always fails: exercises the warning branch
    // without any synchronous primitive in the product code.
    const stubDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-ops007-stub-"),
    );
    const stub = path.join(stubDir, "git");
    fs.writeFileSync(stub, "#!/bin/sh\nexit 1\n", "utf8");
    fs.chmodSync(stub, 0o755);

    const originalPath = process.env.PATH;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let created: { success: boolean; path?: string; error?: string };
    const syncBefore = rec.syncCalls;
    try {
      process.env.PATH = `${stubDir}${path.delimiter}${originalPath}`;
      created = await createNamespaceTool({
        name: "ops007-nogit",
        setDefault: false,
      });
    } finally {
      process.env.PATH = originalPath;
    }

    const warned = warn.mock.calls
      .map((call) => call.map((arg) => String(arg)).join(" "))
      .join("\n");
    warn.mockRestore();

    expect(created!.success).toBe(true);
    expect(fs.existsSync(path.join(created!.path!, "manifest.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(created!.path!, ".git"))).toBe(false);
    expect(warned).toContain("Could not init git");
    expect(rec.syncCalls - syncBefore).toBe(0);
  });
});
