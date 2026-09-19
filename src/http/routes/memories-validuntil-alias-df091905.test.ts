/**
 * DF-0919-05 Regression Tests: camelCase validity-window aliases accepted.
 *
 * Live probe (2026-09-19, scratch daemon): POST /api/memories with
 * `validUntil: '2026-09-01'` returned 201 but the memory stayed visible in
 * the CURRENT view and carried NO valid_until field — zod (MCP remember
 * schema) and the REST route both silently dropped the camelCase key, so a
 * caller using the API-spec-adjacent spelling got unbounded retention with
 * no error. Resending as `valid_until` worked (row vanished from the
 * current view, visible via ?historical=true).
 *
 * Fix pinned here (ACCEPT BOTH SPELLINGS; snake_case wins on collision —
 * NOT a strict-schema 400, which would break existing fleet callers that
 * send extra keys):
 *
 *  MCP remember tool:
 *   (a) schema no longer strips validFrom/validUntil (safeParse keeps them)
 *   (b) rememberTool({validUntil: PAST}) persists valid_until — the row is
 *       excluded from the current view and visible via historical=true
 *   (c) rememberTool({validFrom: FUTURE}) persists valid_from — same views
 *   (d) both spellings present → snake_case WINS on both fields
 *   (e) a plain write without validity fields is unchanged (no regression)
 *
 *  REST POST /api/memories (against a REAL scratch daemon):
 *   (f) {validUntil: PAST} → 201 echoes valid_until (snake only, no camel
 *       echo), the memory is excluded from the current list view and
 *       visible via ?historical=true
 *   (g) {validFrom: FUTURE} → same, for valid_from
 *   (h) both spellings → snake_case wins, echoed and persisted
 *
 * Hermeticity (DB-GAP-045 pattern): the daemon runs on a unique free port
 * with DUCKBRAIN_DATA_DIR / DUCKBRAIN_NAMESPACES_PATH / DUCKBRAIN_AUTH_FILE
 * all in a temp dir; the auth store is minted with `duckbrain token` against
 * the scratch path only. Teardown kills ONLY this suite's child pid — never
 * `pkill`, never the production :3000 daemon. No production namespace; no
 * network beyond 127.0.0.1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import net from "net";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { rememberTool, rememberToolDef } from "../../mcp/tools/remember";
import { recallTool } from "../../mcp/tools/recall";

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

/* ================================================================ MCP side */

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const NS = path.join(NS_ROOT, "df091905");
const PARTITION = path.join(NS, "concept", "2026-08");
const JSONL = path.join(PARTITION, "current.jsonl");
const MANIFEST = path.join(NS, "manifest.json");

function mem(
  id: string,
  key: string,
  text: string,
  validity?: { valid_from?: string; valid_until?: string },
): string {
  return JSON.stringify({
    id,
    key,
    domain: "concept",
    timestamp: "2026-08-15T12:00:00.000Z",
    author: "test@example.com",
    action: "add",
    embedding_text: text,
    attributes: {},
    ...(validity?.valid_from !== undefined
      ? { valid_from: validity.valid_from }
      : {}),
    ...(validity?.valid_until !== undefined
      ? { valid_until: validity.valid_until }
      : {}),
  });
}

// Control row: no validity fields — must behave exactly as before DF-0919-05.
const CONTROL_ROW = mem("c1", "/df091905/control", "plain control row");

beforeAll(() => {
  fs.mkdirSync(PARTITION, { recursive: true });
  fs.writeFileSync(JSONL, CONTROL_ROW + "\n");
  fs.writeFileSync(
    MANIFEST,
    JSON.stringify({
      partitions: ["concept/2026-08"],
      lastUpdated: new Date().toISOString(),
    }),
  );
});

afterAll(() => {
  fs.rmSync(PARTITION, { recursive: true, force: true });
  fs.rmSync(MANIFEST, { force: true });
  fs.rmSync(path.join(NS, ".search"), { recursive: true, force: true });
  fs.rmSync(path.join(NS, ".embeddings"), { recursive: true, force: true });
});

describe("DF-0919-05: MCP remember accepts camelCase validity aliases", () => {
  it("(a) schema keeps validFrom/validUntil instead of stripping them", () => {
    const result = rememberToolDef.inputSchema.safeParse({
      key: "/df091905/schema-probe",
      domain: "concept",
      attributes: {},
      embedding_text: "schema probe",
      validFrom: PAST,
      validUntil: PAST,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.validFrom).toBe(PAST);
      expect(data.validUntil).toBe(PAST);
    }
  });

  it("(b) validUntil: PAST persists valid_until — excluded from current, visible historical", async () => {
    const write = await rememberTool({
      key: "/df091905/camel-until",
      domain: "concept",
      attributes: {},
      embedding_text: "camelCase validUntil write",
      author: "test@example.com",
      namespace: "df091905",
      validUntil: PAST,
    });

    expect(write.success).toBe(true);

    // Current view: the expired write is NOT returned.
    const current = await recallTool({
      key: "/df091905/camel-until",
      namespace: "df091905",
      limit: 10,
    });
    expect(current.error).toBeUndefined();
    expect(current.memories).toEqual([]);
    expect(current.total).toBe(0);

    // Historical view: it IS returned, with valid_until intact.
    const historical = await recallTool({
      key: "/df091905/camel-until",
      namespace: "df091905",
      historical: true,
      limit: 10,
    });
    expect(historical.error).toBeUndefined();
    expect(historical.memories).toHaveLength(1);
    expect(historical.memories[0].id).toBe(write.id);
    expect(historical.memories[0].valid_until).toBe(PAST);
  });

  it("(c) validFrom: FUTURE persists valid_from — excluded from current, visible historical", async () => {
    const write = await rememberTool({
      key: "/df091905/camel-from",
      domain: "concept",
      attributes: {},
      embedding_text: "camelCase validFrom write",
      author: "test@example.com",
      namespace: "df091905",
      validFrom: FUTURE,
    });

    expect(write.success).toBe(true);

    const current = await recallTool({
      key: "/df091905/camel-from",
      namespace: "df091905",
      limit: 10,
    });
    expect(current.error).toBeUndefined();
    expect(current.memories).toEqual([]);

    const historical = await recallTool({
      key: "/df091905/camel-from",
      namespace: "df091905",
      historical: true,
      limit: 10,
    });
    expect(historical.error).toBeUndefined();
    expect(historical.memories).toHaveLength(1);
    expect(historical.memories[0].id).toBe(write.id);
    expect(historical.memories[0].valid_from).toBe(FUTURE);
  });

  it("(d) both spellings present → snake_case wins on BOTH fields", async () => {
    const write = await rememberTool({
      key: "/df091905/both-spellings",
      domain: "concept",
      attributes: {},
      embedding_text: "snake wins precedence write",
      author: "test@example.com",
      namespace: "df091905",
      // Snake window says: valid now (PAST → FUTURE). The camel values say
      // expired/not-yet-valid (FUTURE → PAST). The persisted row must carry
      // the SNAKE window — a camel win would exclude the row from the
      // current view entirely.
      valid_from: PAST,
      validFrom: FUTURE,
      valid_until: FUTURE,
      validUntil: PAST,
    });

    expect(write.success).toBe(true);

    // Current view: row is current per the snake window.
    const current = await recallTool({
      key: "/df091905/both-spellings",
      namespace: "df091905",
      limit: 10,
    });
    expect(current.error).toBeUndefined();
    expect(current.memories).toHaveLength(1);
    expect(current.memories[0].id).toBe(write.id);
    expect(current.memories[0].valid_from).toBe(PAST);
    expect(current.memories[0].valid_until).toBe(FUTURE);
  });

  it("(e) plain write without validity fields stays current (no regression)", async () => {
    const write = await rememberTool({
      key: "/df091905/plain",
      domain: "concept",
      attributes: {},
      embedding_text: "plain write unchanged",
      author: "test@example.com",
      namespace: "df091905",
    });

    expect(write.success).toBe(true);

    const current = await recallTool({
      key: "/df091905/plain",
      namespace: "df091905",
      limit: 10,
    });
    expect(current.memories).toHaveLength(1);
    expect(current.memories[0].id).toBe(write.id);
    expect(current.memories[0]).not.toHaveProperty("valid_until");
    expect(current.memories[0]).not.toHaveProperty("valid_from");
  });
});

/* =============================================================== REST side */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const BIN_PATH = path.join(REPO_ROOT, "bin", "duckbrain.js");

const HTTP_NS = "df091905";

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function waitForHealth(port: number, timeout = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const attempt = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/health", timeout: 500 },
        (res) => {
          // Embedding provider intentionally degraded (openai + empty key):
          // /health answers 503 — accept it as live (DOGFOOD-025 pattern).
          if (res.statusCode === 200 || res.statusCode === 503) {
            res.resume();
            resolve();
            return;
          }
          res.resume();
          retry();
        },
      );
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - start > timeout) {
        reject(new Error(`server did not become healthy on port ${port}`));
        return;
      }
      setTimeout(attempt, 100);
    };
    attempt();
  });
}

function waitForClose(
  child: ChildProcess,
  timeout = 30000,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("child process did not exit in time"));
    }, timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function prepareDataDir(prefix: string): { dataDir: string; nsPath: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const nsPath = path.join(dataDir, "namespaces");
  fs.mkdirSync(path.join(nsPath, HTTP_NS), { recursive: true });
  return { dataDir, nsPath };
}

function mintScratchToken(dataDir: string): {
  authFile: string;
  token: string;
} {
  const authFile = path.join(dataDir, "scratch-auth.json");
  const res = spawnSync(process.execPath, [BIN_PATH, "token", "--name=test"], {
    env: { ...process.env, DUCKBRAIN_AUTH_FILE: authFile },
    encoding: "utf-8",
  });
  if (res.status !== 0) {
    throw new Error(`token mint failed (${res.status}): ${res.stderr}`);
  }
  const lines = res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const token = lines[1] ?? "";
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new Error(
      `could not parse raw token from mint output: ${JSON.stringify(res.stdout)}`,
    );
  }
  return { authFile, token };
}

describe("DF-0919-05: REST POST /api/memories accepts camelCase validity aliases", () => {
  let port: number;
  let dataDir: string;
  let token: string;
  let daemon: ChildProcess | undefined;

  beforeAll(async () => {
    port = await findFreePort();
    ({ dataDir } = prepareDataDir("duckbrain-df091905-"));
    const nsPath = path.join(dataDir, "namespaces");
    const { authFile, token: minted } = mintScratchToken(dataDir);
    token = minted;

    daemon = spawn(
      process.execPath,
      [
        BIN_PATH,
        "http",
        `--port=${port}`,
        "--auth=apikey",
        `--auth-file=${authFile}`,
      ],
      {
        env: {
          ...process.env,
          DUCKBRAIN_DATA_DIR: dataDir,
          DUCKBRAIN_NAMESPACES_PATH: nsPath,
          NO_COLOR: "1",
          // Fast-fail embedding probe so /health answers promptly.
          DUCKBRAIN_EMBEDDING_PROVIDER: "openai",
          DUCKBRAIN_EMBEDDING_API_KEY: "",
        },
        stdio: "pipe",
      },
    );
    await waitForHealth(port);
  }, 60000);

  afterAll(async () => {
    // Kill ONLY this suite's child pid — never pkill, never :3000.
    if (daemon) {
      try {
        if (daemon.exitCode === null) daemon.kill("SIGTERM");
        await waitForClose(daemon);
      } catch {
        try {
          daemon.kill("SIGKILL");
        } catch {
          // already dead
        }
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 30000);

  async function postMemory(
    key: string,
    extra: Record<string, unknown>,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/memories?namespace=${HTTP_NS}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": token,
        },
        body: JSON.stringify({
          key,
          domain: "concept",
          content: `df091905 camelCase alias probe ${key}`,
          ...extra,
        }),
      },
    );
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async function listByKey(
    key: string,
    historical: boolean,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/memories?namespace=${HTTP_NS}` +
        `&prefix=${encodeURIComponent(key)}` +
        `&historical=${historical}&limit=50`,
      { headers: { "X-API-Key": token } },
    );
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  it("(f) {validUntil: PAST} → 201 echoes valid_until; excluded from current view, visible via ?historical=true", async () => {
    const key = "/df091905/http-until";
    const post = await postMemory(key, { validUntil: PAST });
    expect(post.status).toBe(201);

    // The 201 echo is snake_case only — the camel key is not reflected.
    expect(post.body.valid_until).toBe(PAST);
    expect(post.body.validUntil).toBeUndefined();

    // THE DF-0919-05 assertion: NOT in the current view.
    const current = await listByKey(key, false);
    expect(current.status).toBe(200);
    expect(current.body.items ?? []).toHaveLength(0);

    // …but present in the historical view with the persisted window.
    const historical = await listByKey(key, true);
    expect(historical.status).toBe(200);
    const items = historical.body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].valid_until).toBe(PAST);
  }, 30000);

  it("(g) {validFrom: FUTURE} → 201 echoes valid_from; excluded from current view, visible via ?historical=true", async () => {
    const key = "/df091905/http-from";
    const post = await postMemory(key, { validFrom: FUTURE });
    expect(post.status).toBe(201);
    expect(post.body.valid_from).toBe(FUTURE);
    expect(post.body.validFrom).toBeUndefined();

    const current = await listByKey(key, false);
    expect(current.status).toBe(200);
    expect(current.body.items ?? []).toHaveLength(0);

    const historical = await listByKey(key, true);
    expect(historical.status).toBe(200);
    const items = historical.body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].valid_from).toBe(FUTURE);
  }, 30000);

  it("(h) both spellings on the wire → snake_case wins per field, echoed and persisted", async () => {
    const key = "/df091905/http-both";
    const post = await postMemory(key, {
      valid_from: PAST, // snake wins → persisted
      validFrom: FUTURE, // camel loses
      valid_until: FUTURE, // snake wins → persisted
      validUntil: PAST, // camel loses
    });
    expect(post.status).toBe(201);

    // snake values echoed; the camel losers appear nowhere.
    expect(post.body.valid_from).toBe(PAST);
    expect(post.body.valid_until).toBe(FUTURE);
    expect(post.body.validFrom).toBeUndefined();
    expect(post.body.validUntil).toBeUndefined();

    // Persisted row: currently VALID per the snake window → present in
    // the current view (a camel-win would have made it expired).
    const current = await listByKey(key, false);
    expect(current.status).toBe(200);
    const currentItems = current.body.items as Array<Record<string, unknown>>;
    expect(currentItems).toHaveLength(1);
    expect(currentItems[0].valid_from).toBe(PAST);
    expect(currentItems[0].valid_until).toBe(FUTURE);

    const historical = await listByKey(key, true);
    expect(historical.status).toBe(200);
    const items = historical.body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].valid_from).toBe(PAST);
    expect(items[0].valid_until).toBe(FUTURE);
  }, 30000);
});
