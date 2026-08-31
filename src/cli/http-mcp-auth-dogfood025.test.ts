/**
 * DOGFOOD-025 regression tests: MCP-over-HTTP remember stamps the
 * authenticated token author.
 *
 * Provenance hole (verified live 2026-08-26): authenticated tools/call
 * remember on a --auth=apikey daemon stamped author=git identity instead of
 * the token name — DB-GAP-031's fix landed in the REST handler only
 * (src/http/routes/memories.ts), while the MCP path wrote host-level
 * identity, erasing per-agent provenance.
 *
 * These tests exercise the REAL stack end-to-end (scratch daemon + real
 * MCP SDK client + real JSONL rows), mirroring the scratch-daemon harness
 * shape of src/cli/auth-file.test.ts (DB-GAP-043):
 *
 *  1. AC1: authenticated MCP tools/call remember via POST /mcp stamps
 *     author = <token-name>@duckbrain.local on the JSONL row.
 *  2. AC2: a client-supplied `author` argument is IGNORED when a principal
 *     is present (provenance cannot be erased by the caller).
 *  3. AC3: stdio remember (no auth) keeps its exact legacy behavior — the
 *     client-supplied author is honored.
 *  4. The /mcp route itself is behind auth (no key -> 401), proving the
 *     stamping came from a genuinely authenticated request.
 *
 * Hermeticity: the daemon runs with DUCKBRAIN_DATA_DIR /
 * DUCKBRAIN_NAMESPACES_PATH / --auth-file all in temp dirs — the real
 * ~/.duckbrain/auth.json and the repo's ./namespaces are never touched.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import net from "net";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BIN_PATH = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");
const SCRATCH_KEY = "sk-scratch-dogfood025";
const SCRATCH_TOKEN_NAME = "scratch-mcp-agent";
const PRINCIPAL_AUTHOR = `${SCRATCH_TOKEN_NAME}@duckbrain.local`;

/* ---------------------------------------------------------------- helpers */

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
          // GAP-030: this test spawns with openai + empty key (degraded
          // state), so /health answers 503 — accept it as live.
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
  fs.mkdirSync(path.join(nsPath, "default"), { recursive: true });
  return { dataDir, nsPath };
}

function writeScratchAuthFile(dir: string): string {
  const authFile = path.join(dir, "scratch-auth.json");
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      users: [],
      apiKeys: [{ key: SCRATCH_KEY, name: SCRATCH_TOKEN_NAME }],
    }),
  );
  return authFile;
}

function spawnHttpServer(
  port: number,
  dataDir: string,
  nsPath: string,
  authFile: string,
): ChildProcess {
  return spawn(
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
        // Fast-fail embedding probe so /health answers promptly
        // (tests/helpers.ts INT-CI-003 pattern).
        DUCKBRAIN_EMBEDDING_PROVIDER: "openai",
        DUCKBRAIN_EMBEDDING_API_KEY: "",
      },
      stdio: "pipe",
    },
  );
}

/**
 * Read every JSONL row under <nsPath>/default/<domain> that has a key
 * starting with the given prefix, sorted by timestamp. Walks all chunk
 * files (current.jsonl and rotated numeric chunks) so the assertion holds
 * regardless of rotation state.
 */
function readRowsByKeyPrefix(
  nsPath: string,
  domain: string,
  keyPrefix: string,
): any[] {
  const domainDir = path.join(nsPath, "default", domain);
  if (!fs.existsSync(domainDir)) return [];
  const rows: any[] = [];
  for (const entry of fs.readdirSync(domainDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const partitionDir = path.join(domainDir, entry.name);
    for (const file of fs.readdirSync(partitionDir)) {
      if (!file.endsWith(".jsonl")) continue;
      for (const line of fs
        .readFileSync(path.join(partitionDir, file), "utf-8")
        .split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (typeof row.key === "string" && row.key.startsWith(keyPrefix)) {
          rows.push(row);
        }
      }
    }
  }
  return rows.sort((a, b) =>
    String(a.timestamp).localeCompare(String(b.timestamp)),
  );
}

/** Raw JSON-RPC POST to /mcp, returning status + parsed body. */
async function postMcpRaw(
  port: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/* ----------------------------------------------------------------- tests */

describe("DOGFOOD-025: MCP-over-HTTP remember stamps the authenticated token author", () => {
  let port: number;
  let dataDir: string;
  let nsPath: string;
  let daemon: ChildProcess;
  let stdioChild: ChildProcess;
  let httpClient: Client | undefined;
  let httpTransport: StreamableHTTPClientTransport | undefined;

  beforeAll(async () => {
    port = await findFreePort();
    ({ dataDir, nsPath } = prepareDataDir("duckbrain-dogfood025-"));
    const authFile = writeScratchAuthFile(dataDir);

    daemon = spawnHttpServer(port, dataDir, nsPath, authFile);
    await waitForHealth(port);

    // AC3: stdio server (no auth) — spawn a fresh child so the singleton
    // MCP server in THIS process is never touched.
    stdioChild = spawn(process.execPath, [BIN_PATH, "stdio"], {
      cwd: dataDir,
      env: {
        ...process.env,
        DUCKBRAIN_DATA_DIR: dataDir,
        DUCKBRAIN_NAMESPACES_PATH: nsPath,
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
  }, 60000);

  afterAll(async () => {
    try {
      await httpTransport?.close();
    } catch {
      // ignore
    }
    for (const child of [daemon, stdioChild]) {
      try {
        if (child && child.exitCode === null) child.kill("SIGTERM");
        if (child) await waitForClose(child);
      } catch {
        try {
          child?.kill("SIGKILL");
        } catch {
          // ignore if already dead
        }
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 30000);

  /** Fresh authenticated MCP client per test (stateless streamable HTTP). */
  async function connectHttpClient(): Promise<Client> {
    httpTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      {
        requestInit: {
          headers: { "X-API-Key": SCRATCH_KEY },
        },
      },
    );
    httpClient = new Client({ name: "dogfood025-test", version: "1.0.0" });
    await httpClient.connect(httpTransport);
    return httpClient;
  }

  /** Call remember over HTTP and return the parsed tool result object. */
  async function rememberViaHttp(
    client: Client,
    args: Record<string, unknown>,
  ): Promise<any> {
    const result = await client.callTool({
      name: "remember",
      arguments: args,
    });
    const text = (result as { content: Array<{ type: string; text: string }> })
      .content[0].text;
    return JSON.parse(text);
  }

  it("AC1: authenticated remember stamps author=<token>@duckbrain.local on the JSONL row", async () => {
    const client = await connectHttpClient();
    const key = "/dogfood025/ac1";

    const result = await rememberViaHttp(client, {
      key,
      domain: "concept",
      attributes: {},
      embedding_text: "dogfood025 ac1 — authenticated provenance",
    });

    expect(result.success).toBe(true);
    expect(result.author).toBe(PRINCIPAL_AUTHOR);

    const rows = readRowsByKeyPrefix(nsPath, "concept", key);
    expect(rows).toHaveLength(1);
    expect(rows[0].author).toBe(PRINCIPAL_AUTHOR);
  });

  it("AC2: client-supplied author argument is ignored when authenticated", async () => {
    const client = await connectHttpClient();
    const key = "/dogfood025/ac2";

    const result = await rememberViaHttp(client, {
      key,
      domain: "concept",
      attributes: {},
      embedding_text: "dogfood025 ac2 — spoofed author must be ignored",
      author: "spoofed-author@example.com",
    });

    expect(result.success).toBe(true);
    expect(result.author).toBe(PRINCIPAL_AUTHOR);

    const rows = readRowsByKeyPrefix(nsPath, "concept", key);
    expect(rows).toHaveLength(1);
    expect(rows[0].author).toBe(PRINCIPAL_AUTHOR);
    expect(rows[0].author).not.toBe("spoofed-author@example.com");
  });

  it("AC3: stdio remember (no auth) still honors a client-supplied author", async () => {
    const transport = new (
      await import("@modelcontextprotocol/sdk/client/stdio.js")
    ).StdioClientTransport({
      command: process.execPath,
      args: [BIN_PATH, "stdio"],
      cwd: dataDir,
      env: {
        ...process.env,
        DUCKBRAIN_DATA_DIR: dataDir,
        DUCKBRAIN_NAMESPACES_PATH: nsPath,
        NO_COLOR: "1",
      },
      stderr: "pipe",
    });
    const client = new Client({
      name: "dogfood025-stdio-test",
      version: "1.0.0",
    });
    await client.connect(transport);

    const key = "/dogfood025/ac3";
    const result = await client.callTool({
      name: "remember",
      arguments: {
        key,
        domain: "concept",
        attributes: {},
        embedding_text: "dogfood025 ac3 — stdio local author",
        author: "stdio-author@example.com",
      },
    });
    const text = (result as { content: Array<{ type: string; text: string }> })
      .content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(true);
    expect(parsed.author).toBe("stdio-author@example.com");

    const rows = readRowsByKeyPrefix(nsPath, "concept", key);
    expect(rows).toHaveLength(1);
    expect(rows[0].author).toBe("stdio-author@example.com");

    await transport.close();
  });

  it("the /mcp route itself is behind auth — no key means 401", async () => {
    const { status } = await postMcpRaw(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "remember",
        arguments: {
          key: "/dogfood025/unauth",
          domain: "concept",
          attributes: {},
          embedding_text: "should never be reached",
        },
      },
    });
    expect(status).toBe(401);
    // And nothing was written.
    expect(
      readRowsByKeyPrefix(nsPath, "concept", "/dogfood025/unauth"),
    ).toHaveLength(0);
  });
});
