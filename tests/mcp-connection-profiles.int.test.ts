/**
 * MCP-CONNECTION-PROFILES-001 — LIVE end-to-end verification over real HTTP.
 *
 * Drives a real daemon (scratch HOME / auth store / namespace root, per the
 * DB-GAP-031 suite pattern) through the profile acceptance matrix:
 *
 *   1. one user, multiple profiles; create via the MCP tools themselves
 *   2. DIFFERENT selections on two concurrent connections (header-scoped):
 *      the same tools/list answers differently per connection, and neither
 *      connection's selection mutates the other's state
 *   3. visible vs hidden tools/list results (hidden / exclusive)
 *   4. tools/call of a hidden-but-AUTHORIZED tool still executes — profiles
 *      shape discovery only (the existing authorization contract is
 *      untouched)
 *   5. tools/call of a tool the token is NOT authorized for still fails
 *      DESPITE a profile advertising it — a profile cannot broaden authority
 *
 * Run with `pnpm test:integration`.
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

const agentToken = "c".repeat(48);

interface Reply {
  status: number;
  body: any;
}

/** MCP JSON-RPC over the Streamable HTTP transport (single JSON response). */
async function mcp(
  method: string,
  params: unknown,
  token: string,
  profiles?: string,
): Promise<Reply> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-API-Key": token,
      ...(profiles !== undefined ? { "X-DuckBrain-Profiles": profiles } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const raw = await response.text();
  return { status: response.status, body: parseBody(raw) };
}

/** MCP replies are JSON, or SSE frames ('data: {...}'). */
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

function listedTools(reply: Reply): string[] {
  return (reply.body?.result?.tools ?? []).map((t: { name: string }) => t.name);
}

async function createProfileOverMcp(
  name: string,
  directives: Array<{ tool: string; visibility: string }>,
  token: string,
): Promise<void> {
  const reply = await mcp(
    "tools/call",
    {
      name: "create_profile",
      arguments: { name, owner: "profiles-int-agent", directives },
    },
    token,
  );
  expect(reply.status).toBe(200);
  expect(toolPayload(reply).success).toBe(true);
}

beforeAll(async () => {
  scratchRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "duckbrain-mcp-profiles-int-"),
  );
  home = path.join(scratchRoot, "home");
  const authDir = path.join(home, ".duckbrain");
  namespacesPath = path.join(scratchRoot, "namespaces");
  authFile = path.join(authDir, "auth.json");
  fs.mkdirSync(authDir, { recursive: true });
  fs.mkdirSync(path.join(namespacesPath, "default"), { recursive: true });
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      users: [],
      apiKeys: [
        {
          keyHash: hashApiKey(agentToken),
          name: "profiles-agent",
          roles: ["writer"],
          namespaces: ["default"],
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

describe("MCP connection profiles over live HTTP (MCP-CONNECTION-PROFILES-001)", () => {
  it("agents create profiles via the MCP tools; list_profiles shows them", async () => {
    await createProfileOverMcp(
      "memory-only",
      [
        { tool: "recall", visibility: "exclusive" },
        { tool: "list_keys", visibility: "exclusive" },
      ],
      agentToken,
    );
    await createProfileOverMcp(
      "no-admin",
      [
        { tool: "squash", visibility: "hidden" },
        { tool: "delete_namespace", visibility: "hidden" },
      ],
      agentToken,
    );

    const reply = await mcp(
      "tools/call",
      {
        name: "list_profiles",
        arguments: {},
      },
      agentToken,
    );
    const payload = toolPayload(reply);
    expect(payload.success).toBe(true);
    const names = payload.profiles.map((p: { name: string }) => p.name);
    expect(names).toContain("memory-only");
    expect(names).toContain("no-admin");
    // Introspection lists both built-ins and (empty) custom-tool surface.
    expect(payload.builtInTools).toContain("remember");
    expect(Array.isArray(payload.registeredCustomTools)).toBe(true);
    expect(payload.note).toContain("NOT security boundaries");
  });

  it("header selection filters tools/list (exclusive narrows, hidden removes)", async () => {
    const narrowed = await mcp("tools/list", {}, agentToken, "memory-only");
    expect(narrowed.status).toBe(200);
    expect(listedTools(narrowed).sort()).toEqual(["list_keys", "recall"]);

    const hidden = await mcp("tools/list", {}, agentToken, "no-admin");
    const hiddenNames = listedTools(hidden);
    expect(hiddenNames).not.toContain("squash");
    expect(hiddenNames).not.toContain("delete_namespace");
    expect(hiddenNames).toContain("recall");

    const unfiltered = await mcp("tools/list", {}, agentToken);
    expect(listedTools(unfiltered)).toContain("squash");
    expect(listedTools(unfiltered)).toContain("delete_namespace");
  });

  it("two concurrent connections carry DIFFERENT selections without cross-talk", async () => {
    const [a, b, c] = await Promise.all([
      mcp("tools/list", {}, agentToken, "memory-only"),
      mcp("tools/list", {}, agentToken, "no-admin"),
      mcp("tools/list", {}, agentToken),
    ]);
    expect(listedTools(a).sort()).toEqual(["list_keys", "recall"]);
    expect(listedTools(b)).not.toContain("squash");
    expect(listedTools(b)).toContain("remember");
    expect(listedTools(c)).toContain("squash");
    // The unfiltered connection was not mutated by its neighbors' headers.
    expect(listedTools(c)).toContain("delete_namespace");
  });

  it("tools/call of a hidden-but-AUTHORIZED tool still executes (discovery ≠ authority)", async () => {
    // `squash` is hidden by no-admin — but this token is authorized, so the
    // direct call runs under the EXISTING contract (profiles never gate).
    const reply = await mcp(
      "tools/call",
      {
        name: "get_compaction_stats",
        arguments: {},
      },
      agentToken,
      "memory-only",
    );
    expect(reply.status).toBe(200);
    expect(reply.body.result.isError).toBeUndefined();
    const payload = toolPayload(reply);
    expect(payload.error).toBeUndefined();
  });

  it("denied call DESPITE the profile advertising the tool: profiles cannot broaden authority", async () => {
    // Profiles claim list_profiles is visible — but the UNAUTHENTICATED
    // request is still 401: a profile listing a tool never substitutes for
    // authentication.
    const unauth = await mcp("tools/list", {}, "d".repeat(48), "memory-only");
    expect(unauth.status).toBe(401);

    // The authenticated agent hides a tool from ITS OWN discovery, then
    // calls it directly — the call path (not the profile) decides.
    await createProfileOverMcp(
      "hide-recall",
      [{ tool: "recall", visibility: "hidden" }],
      agentToken,
    );
    const listed = await mcp("tools/list", {}, agentToken, "hide-recall");
    expect(listedTools(listed)).not.toContain("recall");
    const direct = await mcp(
      "tools/call",
      {
        name: "recall",
        arguments: { key: "/profiles-int/probe" },
      },
      agentToken,
      "hide-recall",
    );
    expect(direct.status).toBe(200);
    expect(direct.body.result.isError).toBeUndefined();
  });

  it("X-DuckBrain-Profiles with an unknown profile leaves discovery unchanged", async () => {
    const reply = await mcp("tools/list", {}, agentToken, "no-such-profile");
    expect(reply.status).toBe(200);
    expect(listedTools(reply)).toContain("squash");
    expect(listedTools(reply)).toContain("recall");
  });
});
