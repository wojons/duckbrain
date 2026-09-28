/**
 * DF-0926-04 (end-to-end half): with DUCKBRAIN_NAMESPACE set, writes made by
 * the REAL entry points land in that namespace — stdio MCP, the HTTP daemon
 * and the CLI.
 *
 * The docs (docs/guide/ai-configure.md, examples/mcp-client/README.md) sell
 * DUCKBRAIN_NAMESPACE as the per-agent isolation knob, and the task's live
 * reproduction was:
 *
 *   spawn `node bin/duckbrain.js stdio` with DUCKBRAIN_NAMESPACE=dogfood-examples,
 *   call remember, read the response -> "namespace":"default"
 *
 * Every client below runs as a real subprocess with a scratch namespace root
 * and a scratch config whose defaultNamespace is deliberately NOT the env
 * value, so a namespace that "matches the docs" can only have come from the
 * env var. Each arm also asserts the negative (nothing landed in the config
 * namespace) and the precedence rule (an explicit parameter still wins).
 *
 * Hermeticity: scratch root for DUCKBRAIN_NAMESPACES_PATH / DUCKBRAIN_CONFIG_PATH,
 * an ephemeral port for the daemon (never :3000), the real duckbrain.config.json
 * and ./namespaces are untouched, and the embedding provider is pinned to the
 * fast-failing openai/empty-key pair so no network call decides the outcome.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, ChildProcess } from "child_process";
import net from "net";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Process-spawning suite: file-scoped budgets (same convention as
// src/cli/http-mcp-auth-dogfood025.test.ts).
vi.setConfig({ hookTimeout: 120_000, testTimeout: 120_000 });

const BIN_PATH = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "df092604-e2e-"));
const NS_ROOT = path.join(SCRATCH, "namespaces");
const CONFIG_PATH = path.join(SCRATCH, "duckbrain.config.json");

/** The config file's own defaultNamespace — what the BUG wrote to. */
const CFG_DEFAULT = "df092604-cfg-default";
const ENV_STDIO = "df092604-env-stdio";
const ENV_HTTP = "df092604-env-http";
const ENV_CLI = "df092604-env-cli";
const EXPLICIT_NS = "df092604-explicit";

/* ------------------------------------------------------------- helpers */

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

function waitForHealth(port: number, timeout = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const attempt = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/health", timeout: 1000 },
        (res) => {
          // The embedding probe is deliberately degraded here, so /health
          // answers 503 while the API is live — accept both.
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

function waitForClose(child: ChildProcess, timeout = 30_000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve();
    }, timeout);
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Env for a child: scratch store + scratch config + the namespace under test.
 *
 * `degradeEmbeddings` is for the HTTP daemon only — it pins the embedding
 * provider to the fast-failing openai/empty-key pair so /health answers
 * promptly instead of probing for a local model server (dogfood025 pattern).
 */
function childEnv(
  namespace: string | undefined,
  { degradeEmbeddings = false }: { degradeEmbeddings?: boolean } = {},
): Record<string, string> {
  // MCP SDK's StdioClientTransport types `env` as Record<string, string>, so
  // drop the undefined-valued keys NodeJS.ProcessEnv allows.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.DUCKBRAIN_NAMESPACES_PATH = NS_ROOT;
  env.DUCKBRAIN_CONFIG_PATH = CONFIG_PATH;
  env.NO_COLOR = "1";
  if (degradeEmbeddings) {
    env.DUCKBRAIN_EMBEDDING_PROVIDER = "openai";
    env.DUCKBRAIN_EMBEDDING_API_KEY = "";
  }
  if (namespace === undefined) delete env.DUCKBRAIN_NAMESPACE;
  else env.DUCKBRAIN_NAMESPACE = namespace;
  return env;
}

/**
 * True when `key` appears in any JSONL row stored under <NS_ROOT>/<namespace>.
 * Walks every chunk file so the assertion holds regardless of rotation.
 */
function keyUnder(namespace: string, key: string): boolean {
  const root = path.join(NS_ROOT, namespace);
  if (!fs.existsSync(root)) return false;
  let found = false;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".jsonl")) {
        if (fs.readFileSync(p, "utf-8").includes(key)) found = true;
      }
    }
  };
  walk(root);
  return found;
}

/** Namespace directories that exist on disk under the scratch root. */
function namespaceDirs(): string[] {
  if (!fs.existsSync(NS_ROOT)) return [];
  return fs
    .readdirSync(NS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

function runCli(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 90_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      cwd: SCRATCH,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/* --------------------------------------------------------------- suite */

beforeAll(() => {
  fs.mkdirSync(NS_ROOT, { recursive: true });
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ defaultNamespace: CFG_DEFAULT }, null, 2),
    "utf-8",
  );
});

afterAll(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

describe("DF-0926-04: DUCKBRAIN_NAMESPACE selects the namespace for real clients", () => {
  it("stdio MCP: remember without a namespace argument lands in DUCKBRAIN_NAMESPACE", async () => {
    const key = "/df092604/stdio-env";
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN_PATH, "stdio"],
      cwd: SCRATCH,
      env: childEnv(ENV_STDIO),
      stderr: "pipe",
    });
    const client = new Client({ name: "df092604-stdio", version: "1.0.0" });
    await client.connect(transport);

    try {
      const result = await client.callTool({
        name: "remember",
        arguments: {
          key,
          domain: "concept",
          attributes: {},
          embedding_text: "DF-0926-04 stdio env proof",
        },
      });
      const parsed = JSON.parse(
        (result as { content: Array<{ type: string; text: string }> })
          .content[0].text,
      );

      expect(parsed.success).toBe(true);
      // The live reproduction of the bug read "namespace":"default" right here.
      expect(parsed.namespace).toBe(ENV_STDIO);
      expect(parsed.namespace).not.toBe(CFG_DEFAULT);

      expect(keyUnder(ENV_STDIO, key)).toBe(true);
      expect(keyUnder(CFG_DEFAULT, key)).toBe(false);
    } finally {
      await transport.close();
    }
  });

  it("stdio MCP: an explicit namespace argument still beats the env var", async () => {
    const key = "/df092604/stdio-explicit";
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN_PATH, "stdio"],
      cwd: SCRATCH,
      env: childEnv(ENV_STDIO),
      stderr: "pipe",
    });
    const client = new Client({
      name: "df092604-stdio-explicit",
      version: "1.0.0",
    });
    await client.connect(transport);

    try {
      const result = await client.callTool({
        name: "remember",
        arguments: {
          key,
          domain: "concept",
          attributes: {},
          embedding_text: "DF-0926-04 explicit-arg precedence",
          namespace: EXPLICIT_NS,
        },
      });
      const parsed = JSON.parse(
        (result as { content: Array<{ type: string; text: string }> })
          .content[0].text,
      );

      expect(parsed.success).toBe(true);
      expect(parsed.namespace).toBe(EXPLICIT_NS);

      expect(keyUnder(EXPLICIT_NS, key)).toBe(true);
      expect(keyUnder(ENV_STDIO, key)).toBe(false);
    } finally {
      await transport.close();
    }
  });

  it("CLI: remember (no --namespace) lands in DUCKBRAIN_NAMESPACE, and the config default when the var is unset", async () => {
    const envKey = "/df092604/cli-env";
    const withEnv = await runCli(
      [
        "remember",
        envKey,
        "--domain=raw_note",
        "--content=DF-0926-04 cli env proof",
        "--wait",
      ],
      childEnv(ENV_CLI),
    );

    expect(withEnv.code).toBe(0);
    expect(keyUnder(ENV_CLI, envKey)).toBe(true);
    expect(keyUnder(CFG_DEFAULT, envKey)).toBe(false);

    // Control: the same command with the env var REMOVED keeps the legacy
    // resolution (config defaultNamespace), proving the env var is additive.
    const cfgKey = "/df092604/cli-cfg";
    const withoutEnv = await runCli(
      [
        "remember",
        cfgKey,
        "--domain=raw_note",
        "--content=DF-0926-04 cli config-fallback control",
        "--wait",
      ],
      childEnv(undefined),
    );

    expect(withoutEnv.code).toBe(0);
    expect(keyUnder(CFG_DEFAULT, cfgKey)).toBe(true);
  });
});

describe("DF-0926-04: the HTTP API resolves the same namespace as the config/env", () => {
  let port: number;
  let daemon: ChildProcess;

  beforeAll(async () => {
    port = await findFreePort();
    daemon = spawn(
      process.execPath,
      // --auth=none is the documented explicit local/test opt-out; this suite
      // is about namespace resolution, not authentication (the grant path has
      // its own suites), and it must never touch the production auth store.
      [BIN_PATH, "http", `--port=${port}`, "--auth=none"],
      {
        cwd: SCRATCH,
        env: childEnv(ENV_HTTP, { degradeEmbeddings: true }),
        stdio: "pipe",
      },
    );
    await waitForHealth(port);
  }, 120_000);

  afterAll(async () => {
    if (daemon) {
      try {
        daemon.kill("SIGTERM");
      } catch {
        // already gone
      }
      await waitForClose(daemon);
    }
  });

  it("POST /api/memories with no namespace parameter writes to DUCKBRAIN_NAMESPACE, and the un-parameterized GET reads it back", async () => {
    const key = "/df092604/http-env";

    const post = await fetch(`http://127.0.0.1:${port}/api/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key,
        domain: "concept",
        content: "DF-0926-04 http env proof",
      }),
    });
    expect(post.status).toBe(201);
    await post.json();

    expect(keyUnder(ENV_HTTP, key)).toBe(true);
    expect(keyUnder(CFG_DEFAULT, key)).toBe(false);

    // Read path: no ?namespace= at all, so it must resolve the same way.
    const get = await fetch(
      `http://127.0.0.1:${port}/api/memories/key${encodeURI(key)}`,
      { headers: { Accept: "application/json" } },
    );
    expect(get.status).toBe(200);
    const memory = (await get.json()) as { key?: string };
    expect(memory.key).toBe(key);

    // The same route WITHOUT the env var's namespace cannot see it — the
    // discriminator that makes the assertion above meaningful.
    const elsewhere = await fetch(
      `http://127.0.0.1:${port}/api/memories/key${encodeURI(key)}?namespace=${CFG_DEFAULT}`,
    );
    expect(elsewhere.status).toBe(404);
  });

  it("an explicit ?namespace= still wins over DUCKBRAIN_NAMESPACE", async () => {
    const key = "/df092604/http-explicit";

    const post = await fetch(
      `http://127.0.0.1:${port}/api/memories?namespace=${EXPLICIT_NS}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          domain: "concept",
          content: "DF-0926-04 http explicit precedence",
        }),
      },
    );
    expect(post.status).toBe(201);
    await post.json();

    expect(keyUnder(EXPLICIT_NS, key)).toBe(true);
    expect(keyUnder(ENV_HTTP, key)).toBe(false);
  });

  it("no write from any client leaked into the config's own namespace", () => {
    // The bug's signature: every documented per-agent write landed in the
    // config defaultNamespace. Only the deliberate unset-env control may.
    expect(keyUnder(CFG_DEFAULT, "/df092604/stdio-env")).toBe(false);
    expect(keyUnder(CFG_DEFAULT, "/df092604/stdio-explicit")).toBe(false);
    expect(keyUnder(CFG_DEFAULT, "/df092604/cli-env")).toBe(false);
    expect(keyUnder(CFG_DEFAULT, "/df092604/http-env")).toBe(false);
    expect(keyUnder(CFG_DEFAULT, "/df092604/http-explicit")).toBe(false);

    const dirs = namespaceDirs();
    expect(dirs).toContain(ENV_STDIO);
    expect(dirs).toContain(ENV_HTTP);
    expect(dirs).toContain(ENV_CLI);
    expect(dirs).toContain(EXPLICIT_NS);
    expect(dirs).toContain(CFG_DEFAULT);
  });
});
