/**
 * Card t_369581ef integration test — the LIVE end-to-end proof that the MCP
 * namespace-MANAGEMENT tools grade the token's namespace grant exactly like
 * the REST routes, and that every MCP refusal lands a denial audit row.
 *
 * Report (2026-10-02, filed while closing t_c772251b): `create_namespace`,
 * `switch_namespace`, `delete_namespace` and `list_namespaces` ran through the
 * auth middleware but never evaluated the token's `namespaces` grant, so a
 * token scoped to `home-ns` could CREATE, take over (switch) or DELETE a
 * foreign namespace through `POST /mcp` while REST refused the same namespace
 * with 403 (POST /api/namespaces, DELETE /api/namespaces/:name mount
 * `requireNamespaceGrant`). The refusals the MCP path DID return wrote no
 * denial row (SUPA-4 audit-every-denial).
 *
 * This suite drives both transports with the same tokens against a real
 * daemon and asserts:
 *
 *   MCP  create_namespace  @ ungranted -> refused, reason 'namespace_scope', no dir
 *   REST POST   /api/namespaces        @ ungranted -> 403        (unchanged)
 *   MCP  delete_namespace  @ ungranted -> refused, target intact
 *   REST DELETE /api/namespaces/:name  @ ungranted -> 403        (unchanged)
 *   MCP  switch_namespace  @ ungranted -> refused, active ns unchanged
 *   MCP  switch_namespace  @ granted   -> success (real use still works)
 *   MCP  list_namespaces   @ scoped    -> enumerates ONLY granted names
 *   MCP  list_namespaces   @ unrestricted -> full listing (unchanged)
 *   MCP  create/delete     @ granted   -> success (grant-driven, not blanket)
 *   denial audit: an MCP refusal row with reason 'namespace_scope' lands in
 *   the SAME sink REST writes to (namespace ledger, or the server-level file
 *   when the target namespace does not exist yet)
 *
 * The daemon is spawned from this repo (`node --import tsx bin/duckbrain.ts`)
 * with a scratch HOME / auth store / namespace root, so the live store is
 * never touched. Run with `pnpm test:integration`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  DAEMON_READY_TIMEOUT_MS,
  getRandomPort,
  startDuckbrainHttp,
  stopProcess,
  waitForUrl,
} from "./helpers";
import { hashApiKey } from "../src/auth/storeSchema";
import { readAuditRows, readServerDenials } from "../src/serialization/audit";

const port = getRandomPort();
let server: ChildProcess;
let scratchRoot: string;
let home: string;
let authFile: string;
let namespacesPath: string;

/** Scoped to `home-ns` + `second-ns` — the `--namespace=<agent>,<ns>` shape. */
const scopedToken = "s".repeat(48);
/**
 * A SECOND scoped token used for the REST comparison arms, so the denial rows
 * the REST middlewares write carry a DIFFERENT principal: the audit leg must
 * prove the MCP refusals wrote their own rows, not inherit REST's.
 */
const restProbeToken = "r".repeat(48);
/** Unrestricted (no `namespaces` field): must keep today's behavior. */
const adminToken = "a".repeat(48);

const GRANTED = "home-ns";
const GRANTABLE = "second-ns";
const FOREIGN = "foreign";

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
  return { name, arguments: args };
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

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw last;
}

describe("MCP namespace-management grant parity (card t_369581ef)", () => {
  beforeAll(async () => {
    scratchRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-mcp-admin-grant-int-"),
    );
    home = path.join(scratchRoot, "home");
    const authDir = path.join(home, ".duckbrain");
    namespacesPath = path.join(scratchRoot, "namespaces");
    authFile = path.join(authDir, "auth.json");
    fs.mkdirSync(authDir, { recursive: true });
    for (const ns of [GRANTED, FOREIGN, "default"]) {
      fs.mkdirSync(path.join(namespacesPath, ns), { recursive: true });
    }
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        users: [],
        apiKeys: [
          {
            keyHash: hashApiKey(scopedToken),
            name: "scoped-agent",
            roles: ["writer"],
            namespaces: [GRANTED, GRANTABLE],
          },
          {
            keyHash: hashApiKey(restProbeToken),
            name: "rest-probe-agent",
            roles: ["writer"],
            namespaces: ["rest-ns"],
          },
          {
            keyHash: hashApiKey(adminToken),
            name: "admin-agent",
            roles: ["admin"],
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
  }, 120000);

  afterAll(async () => {
    await stopProcess(server);
    try {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    } catch {
      // Best-effort teardown — never fail the suite on cleanup.
    }
  });

  it("refuses an MCP create of an ungranted namespace and creates nothing", async () => {
    const reply = await mcp(
      "tools/call",
      toolCall("create_namespace", { name: FOREIGN, setDefault: false }),
      scopedToken,
    );

    expect(reply.status).toBe(200);
    expect(reply.body.result.isError).toBe(true);
    const payload = toolPayload(reply);
    expect(payload.success).toBe(false);
    expect(payload.reason).toBe("namespace_scope");
    expect(payload.code).toBe("NAMESPACE_SCOPE");
    expect(payload.error).toContain("no grant for namespace 'foreign'");

    // A brand-new name: a refused create must not materialize it either.
    const fresh = await mcp(
      "tools/call",
      toolCall("create_namespace", { name: "intruder", setDefault: false }),
      scopedToken,
    );
    expect(toolPayload(fresh).reason).toBe("namespace_scope");
    expect(fs.existsSync(path.join(namespacesPath, "intruder"))).toBe(false);

    // REST refuses the same create (unchanged). A different scoped token, so
    // this denial row cannot be confused with the MCP ones below.
    const denied = await rest("POST", "/api/namespaces", restProbeToken, {
      name: "intruder",
    });
    expect(denied.status).toBe(403);
    expect(fs.existsSync(path.join(namespacesPath, "intruder"))).toBe(false);
  });

  it("refuses an MCP delete of an ungranted namespace and keeps it intact", async () => {
    const reply = await mcp(
      "tools/call",
      toolCall("delete_namespace", { name: FOREIGN, confirm: true }),
      scopedToken,
    );

    expect(reply.body.result.isError).toBe(true);
    const payload = toolPayload(reply);
    expect(payload.success).toBe(false);
    expect(payload.reason).toBe("namespace_scope");
    expect(payload.error).not.toContain("not found");
    expect(fs.existsSync(path.join(namespacesPath, FOREIGN))).toBe(true);

    // REST refuses the same delete (unchanged) — different scoped token.
    const denied = await rest(
      "DELETE",
      `/api/namespaces/${FOREIGN}`,
      restProbeToken,
      { confirm: true },
    );
    expect(denied.status).toBe(403);
    expect(fs.existsSync(path.join(namespacesPath, FOREIGN))).toBe(true);
  });

  it("refuses an MCP switch to an ungranted namespace and still allows the granted one", async () => {
    const refused = await mcp(
      "tools/call",
      toolCall("switch_namespace", { name: FOREIGN }),
      scopedToken,
    );

    expect(refused.body.result.isError).toBe(true);
    expect(toolPayload(refused).reason).toBe("namespace_scope");

    // The active namespace did not move to the foreign one.
    const named = await rest("GET", "/api/namespaces", adminToken);
    expect(named.status).toBe(200);
    expect(named.body.currentNamespace).not.toBe(FOREIGN);

    // Real use still works: switching to a GRANTED namespace succeeds.
    const granted = await mcp(
      "tools/call",
      toolCall("switch_namespace", { name: GRANTED }),
      scopedToken,
    );
    expect(toolPayload(granted).success).toBe(true);
    expect(toolPayload(granted).current).toBe(GRANTED);
  });

  it("does not enumerate namespaces outside the grant", async () => {
    const scoped = await mcp(
      "tools/call",
      toolCall("list_namespaces", {}),
      scopedToken,
    );
    const scopedNames = (toolPayload(scoped).namespaces ?? []).map(
      (ns: any) => ns.name,
    );
    expect(scopedNames).toContain(GRANTED);
    expect(scopedNames).not.toContain(FOREIGN);

    // Unrestricted tokens keep the full listing (unchanged).
    const admin = await mcp(
      "tools/call",
      toolCall("list_namespaces", {}),
      adminToken,
    );
    expect(
      (toolPayload(admin).namespaces ?? []).map((ns: any) => ns.name),
    ).toContain(FOREIGN);
  });

  it("still creates and deletes inside the grant (the refusal is grant-driven)", async () => {
    const created = await mcp(
      "tools/call",
      toolCall("create_namespace", { name: GRANTABLE, setDefault: false }),
      scopedToken,
    );
    expect(toolPayload(created).success).toBe(true);
    expect(fs.existsSync(path.join(namespacesPath, GRANTABLE))).toBe(true);

    // The active namespace is GRANTED (previous test), so GRANTABLE is free.
    const removed = await mcp(
      "tools/call",
      toolCall("delete_namespace", { name: GRANTABLE, confirm: true }),
      scopedToken,
    );
    expect(toolPayload(removed).success).toBe(true);
    expect(fs.existsSync(path.join(namespacesPath, GRANTABLE))).toBe(false);
  });

  it("audits every MCP refusal in the same sink REST writes to", async () => {
    await eventually(() => {
      // The refusal for an EXISTING foreign namespace (delete/switch) lands in
      // that namespace's ledger — the same place REST's 403 for it lands. The
      // REST arms used a DIFFERENT token, so a 'scoped-agent' row here can
      // only have been written by the MCP refusals under test.
      expect(readAuditRows(namespacesPath, FOREIGN)).toContainEqual(
        expect.objectContaining({
          ns: FOREIGN,
          op: "namespace.access",
          reason: "namespace_scope",
          principal: "scoped-agent",
          outcome: "denied",
        }),
      );
      // The refusal for a namespace that does not exist yet (create) has no
      // ledger to write to; it lands in the bounded server-level file, so
      // "every denial is audited" holds for it too.
      expect(readServerDenials(namespacesPath)).toContainEqual(
        expect.objectContaining({
          op: "namespace.access",
          reason: "namespace_scope",
          principal: "scoped-agent",
          outcome: "denied",
        }),
      );
      // The REST arms' own rows are the contrast: same shape, other principal.
      expect(readAuditRows(namespacesPath, FOREIGN)).toContainEqual(
        expect.objectContaining({
          ns: FOREIGN,
          op: "namespace.access",
          reason: "namespace_scope",
          principal: "rest-probe-agent",
          outcome: "denied",
        }),
      );
    });
  });
});
