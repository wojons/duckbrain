/**
 * DB-GAP-031 (MCP parity) integration test — the LIVE end-to-end reproduction
 * of card t_c772251b, against a real daemon over real HTTP.
 *
 * Report (2026-10-02): a token minted `--namespace=<agent>,default` could WRITE
 * to an ungranted namespace through `POST /mcp` (HTTP 200, success:true, row on
 * disk) while the REST route for the same namespace answered 403. The /mcp
 * transport authenticated the request (author stamping worked) but never
 * evaluated the token's `namespaces` grant.
 *
 * This suite drives the SAME two transports with the SAME token and asserts
 * they now agree, and that REST behavior is unchanged:
 *
 *   MCP  remember @ ungranted  -> refused, reason 'namespace_scope', no row
 *   MCP  recall   @ ungranted  -> refused, reason 'namespace_scope'
 *   MCP  remember @ granted    -> success + author stamped from the token
 *   MCP  recall   @ granted    -> reads the row back
 *   MCP  remember @ own grant  -> success (the refusal is grant-driven)
 *   REST GET  /api/memories @ ungranted -> 403   (unchanged)
 *   REST POST /api/memories @ ungranted -> 403   (unchanged)
 *   REST GET  /api/memories @ granted   -> 200   (unchanged)
 *   POST /mcp without a key             -> 401   (unchanged)
 *
 * The daemon is spawned from this repo (`node --import tsx bin/duckbrain.ts`)
 * with a scratch HOME / auth store / namespace root, so the live store is never
 * touched. Run with `pnpm test:integration`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  getRandomPort,
  startDuckbrainHttp,
  stopProcess,
  waitForUrl,
  DAEMON_READY_TIMEOUT_MS,
} from "./helpers";
import { hashApiKey } from "../src/auth/storeSchema";

const port = getRandomPort();
let server: ChildProcess;
let scratchRoot: string;
let home: string;
let authFile: string;
let namespacesPath: string;

/** Scoped to `granted` + `default` — the card's `--namespace=<agent>,default` shape. */
const grantedToken = "a".repeat(48);
/** A second agent scoped elsewhere: it must still reach its OWN namespace. */
const otherToken = "b".repeat(48);

const GRANTED = "granted";
const UNGRANTED = "default";
const OTHER = "elsewhere";

interface Reply {
  status: number;
  body: any;
}

/** Talk MCP JSON-RPC over the Streamable HTTP transport (single JSON response). */
async function mcp(
  method: string,
  params: unknown,
  token?: string,
): Promise<Reply> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { "X-API-Key": token } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const raw = await response.text();
  return { status: response.status, body: parseBody(raw) };
}

/** Mcp replies are JSON, or SSE frames ('data: {...}'). */
function parseBody(raw: string): any {
  const text = raw.trim();
  if (text.startsWith("data:")) {
    const frames = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim());
    return frames.length ? JSON.parse(frames[frames.length - 1]) : undefined;
  }
  return text ? JSON.parse(text) : undefined;
}

/** Unwrap result.content[0].text into the tool's own payload object. */
function toolPayload(reply: Reply): any {
  const content = reply.body?.result?.content;
  if (Array.isArray(content) && content[0]?.text) {
    try {
      return JSON.parse(content[0].text);
    } catch {
      return { _raw: content[0].text };
    }
  }
  return reply.body?.result ?? {};
}

function toolCall(name: string, args: Record<string, unknown>) {
  return {
    name,
    arguments: args,
  };
}

async function rest(
  method: string,
  urlPath: string,
  token: string,
  body?: unknown,
): Promise<Reply> {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      "X-API-Key": token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : undefined };
}

describe("MCP namespace-grant parity (DB-GAP-031, card t_c772251b)", () => {
  beforeAll(async () => {
    scratchRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-mcp-grant-int-"),
    );
    home = path.join(scratchRoot, "home");
    const authDir = path.join(home, ".duckbrain");
    namespacesPath = path.join(scratchRoot, "namespaces");
    authFile = path.join(authDir, "auth.json");
    fs.mkdirSync(authDir, { recursive: true });
    for (const ns of [GRANTED, UNGRANTED, OTHER]) {
      fs.mkdirSync(path.join(namespacesPath, ns), { recursive: true });
    }
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        users: [],
        apiKeys: [
          {
            keyHash: hashApiKey(grantedToken),
            name: "granted-agent",
            roles: ["writer"],
            namespaces: [GRANTED, UNGRANTED],
          },
          {
            keyHash: hashApiKey(otherToken),
            name: "other-agent",
            roles: ["writer"],
            namespaces: [OTHER],
          },
        ],
      }),
    );

    server = await startDuckbrainHttp({
      port,
      authType: "apikey",
      authFile,
      env: {
        HOME: home,
        DUCKBRAIN_DATA_DIR: scratchRoot,
        DUCKBRAIN_NAMESPACES_PATH: namespacesPath,
      },
    });
    await waitForUrl(
      `http://127.0.0.1:${port}/health`,
      DAEMON_READY_TIMEOUT_MS,
      server,
    );
    // INT-CI-003: the hook must outlast the 60s daemon-ready budget.
  }, 120000);

  afterAll(async () => {
    // Teardown must JOIN the daemon: a fire-and-forget SIGTERM leaves git
    // (namespace commits) and DuckDB writers racing the recursive rm below.
    await stopProcess(server);
    try {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    } catch {
      // Best-effort teardown — never fail the suite on cleanup.
    }
  });

  it("rejects POST /mcp without a key", async () => {
    const reply = await mcp("tools/call", toolCall("remember", {}));
    expect(reply.status).toBe(401);
  });

  it("refuses an MCP write into an ungranted namespace and writes nothing", async () => {
    const reply = await mcp(
      "tools/call",
      toolCall("remember", {
        key: "/mcp-grant/denied",
        domain: "concept",
        attributes: { probe: "t_c772251b" },
        embedding_text: "denied write probe",
        namespace: GRANTED,
      }),
      otherToken,
    );

    expect(reply.status).toBe(200);
    expect(reply.body.result.isError).toBe(true);
    const payload = toolPayload(reply);
    expect(payload.success).toBe(false);
    expect(payload.reason).toBe("namespace_scope");
    expect(payload.code).toBe("NAMESPACE_SCOPE");
    expect(payload.error).toContain("no grant for namespace 'granted'");

    // No row landed: the granted token cannot read the key back.
    const readback = await mcp(
      "tools/call",
      toolCall("recall", {
        key: "/mcp-grant/denied",
        namespace: GRANTED,
        limit: 5,
      }),
      grantedToken,
    );
    expect(toolPayload(readback).memories ?? []).toHaveLength(0);
  });

  it("accepts the same MCP write inside the grant and stamps the token author", async () => {
    const reply = await mcp(
      "tools/call",
      toolCall("remember", {
        key: "/mcp-grant/allowed",
        domain: "concept",
        attributes: { probe: "t_c772251b" },
        embedding_text: "allowed write probe",
        namespace: GRANTED,
      }),
      grantedToken,
    );

    expect(reply.status).toBe(200);
    const payload = toolPayload(reply);
    expect(payload.success).toBe(true);
    expect(payload.namespace).toBe(GRANTED);
    // DOGFOOD-025 regression: author stamping stays intact.
    expect(payload.author).toBe("granted-agent@duckbrain.local");

    const readback = await mcp(
      "tools/call",
      toolCall("recall", {
        key: "/mcp-grant/allowed",
        namespace: GRANTED,
        limit: 5,
      }),
      grantedToken,
    );
    const rows = toolPayload(readback).memories ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("/mcp-grant/allowed");
  });

  it("refuses an MCP read of an ungranted namespace", async () => {
    const reply = await mcp(
      "tools/call",
      toolCall("recall", { key: "/mcp-grant", namespace: GRANTED, limit: 5 }),
      otherToken,
    );
    expect(reply.body.result.isError).toBe(true);
    const payload = toolPayload(reply);
    expect(payload.success).toBe(false);
    expect(payload.reason).toBe("namespace_scope");
    expect(payload.memories).toEqual([]);
  });

  it("lets a scoped token keep using its own namespace over MCP", async () => {
    const reply = await mcp(
      "tools/call",
      toolCall("remember", {
        key: "/mcp-grant/own",
        domain: "concept",
        attributes: {},
        embedding_text: "own namespace write",
        namespace: OTHER,
      }),
      otherToken,
    );
    expect(toolPayload(reply).success).toBe(true);
  });

  it("refuses cross-namespace search for a scoped token over MCP", async () => {
    const reply = await mcp(
      "tools/call",
      toolCall("recall", {
        allNamespaces: true,
        contains: "probe",
        limit: 5,
      }),
      grantedToken,
    );
    const payload = toolPayload(reply);
    expect(payload.success).toBe(false);
    expect(payload.reason).toBe("namespace_scope");
  });

  it("keeps the REST behavior for the same tokens unchanged", async () => {
    // Ungranted -> 403 (the enforced behavior the MCP path now matches).
    const deniedRead = await rest(
      "GET",
      `/api/memories?namespace=${GRANTED}&limit=1`,
      otherToken,
    );
    expect(deniedRead.status).toBe(403);

    const deniedWrite = await rest("POST", "/api/memories", otherToken, {
      key: "/mcp-grant/rest-denied",
      domain: "concept",
      attributes: {},
      content: "rest denied write",
      namespace: GRANTED,
    });
    expect(deniedWrite.status).toBe(403);

    // Granted -> 200, and the REST write lands in the granted namespace.
    const allowedRead = await rest(
      "GET",
      `/api/memories?namespace=${GRANTED}&limit=5`,
      grantedToken,
    );
    expect(allowedRead.status).toBe(200);

    const allowedWrite = await rest("POST", "/api/memories", grantedToken, {
      key: "/mcp-grant/rest-allowed",
      domain: "concept",
      attributes: {},
      content: "rest allowed write",
      namespace: GRANTED,
    });
    expect([200, 201]).toContain(allowedWrite.status);
    expect(allowedWrite.body?.namespace ?? GRANTED).toBe(GRANTED);

    // The refused REST write left nothing readable behind.
    const readback = await mcp(
      "tools/call",
      toolCall("recall", {
        key: "/mcp-grant/rest-denied",
        namespace: GRANTED,
        limit: 5,
      }),
      grantedToken,
    );
    expect(toolPayload(readback).memories ?? []).toHaveLength(0);
  });
});
