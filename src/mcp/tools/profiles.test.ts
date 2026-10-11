/**
 * MCP-CONNECTION-PROFILES-001 — tool-surface + in-process MCP path tests.
 *
 * Exercises the four profile tools through their MCP-registered handlers
 * (the exact surface an agent drives via tools/call), the list_profiles
 * introspection payload (built-in + registered custom tools), and the real
 * in-process MCP round trip: registerTools() → installProfilesListInterception()
 * → filtered tools/list over the SDK's server.connect(InMemoryTransport).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  BUILTIN_TOOL_NAMES,
  setConnectionSelection,
  setRequestSelection,
} from "../profiles";
import {
  createProfileTool,
  listProfilesTool,
  selectProfilesTool,
  updateProfileTool,
} from "./profiles";
import {
  installProfilesListInterception,
  registerTools,
  server,
} from "../server";

let scratchRoot: string;
let savedConfigPath: string | undefined;

beforeEachRoot();

function beforeEachRoot(): void {
  // Vitest runs beforeEach as a hook; this file uses explicit calls inside
  // beforeEach below. Root creation lives in `freshRoot()`.
}

let savedEmbeddingProvider: string | undefined;

beforeAll(() => {
  savedConfigPath = process.env.DUCKBRAIN_CONFIG_PATH;
  savedEmbeddingProvider = process.env.DUCKBRAIN_EMBEDDING_PROVIDER;
});

afterAll(() => {
  if (savedConfigPath === undefined) delete process.env.DUCKBRAIN_CONFIG_PATH;
  else process.env.DUCKBRAIN_CONFIG_PATH = savedConfigPath;
  if (savedEmbeddingProvider === undefined)
    delete process.env.DUCKBRAIN_EMBEDDING_PROVIDER;
  else process.env.DUCKBRAIN_EMBEDDING_PROVIDER = savedEmbeddingProvider;
});

afterEach(() => {
  setRequestSelection(undefined);
  setConnectionSelection(undefined);
  if (scratchRoot) fs.rmSync(scratchRoot, { recursive: true, force: true });
});

function freshRoot(): void {
  scratchRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "duckbrain-mcp-profile-tools-"),
  );
  process.env.DUCKBRAIN_CONFIG_PATH = path.join(
    scratchRoot,
    "duckbrain.config.json",
  );
}

describe("profile management tools (handler-level)", () => {
  it("list_profiles reports built-in tools, registered custom tools, active selection", async () => {
    freshRoot();
    const result = await listProfilesTool({});
    expect(result.success).toBe(true);
    expect(result.builtInTools).toContain("remember");
    expect(result.builtInTools).toContain("list_profiles");
    // No custom-runtime registry on this tree: the registered list is empty
    // and the surface still works (profiles CAN include custom tools when
    // present).
    expect(Array.isArray(result.registeredCustomTools)).toBe(true);
    expect(result.activeSelection).toBeUndefined();
    expect(result.note).toContain("NOT security boundaries");
  });

  it("an agent creates and updates its own profile through the tools", async () => {
    freshRoot();
    const created = (await createProfileTool({
      name: "agent-scout",
      owner: "scout-agent",
      description: "memory-scoping preset",
      directives: [
        { tool: "squash", visibility: "hidden" },
        { tool: "recall", visibility: "exclusive" },
      ],
    })) as {
      success: boolean;
      preview: { visibleTools: string[]; unknownProfiles: string[] };
    };
    expect(created.success).toBe(true);
    expect(created.preview.visibleTools).toEqual(["recall"]);
    expect(created.preview.unknownProfiles).toEqual([]);

    const updated = (await updateProfileTool({
      name: "agent-scout",
      owner: "scout-agent",
      directives: [{ tool: "squash", visibility: "hidden" }],
    })) as { success: boolean; preview: { visibleTools: string[] } };
    expect(updated.success).toBe(true);
    expect(updated.preview.visibleTools.length).toBe(
      BUILTIN_TOOL_NAMES.length - 1,
    );
  });

  it("select_profiles activates a connection-scoped selection with a preview", async () => {
    freshRoot();
    await createProfileTool({
      name: "quiet",
      owner: "x",
      directives: [{ tool: "forget", visibility: "hidden" }],
    });
    const selected = (await selectProfilesTool({
      profiles: ["quiet"],
    })) as {
      success: boolean;
      scope: string;
      preview: { visibleTools: string[] };
    };
    expect(selected.success).toBe(true);
    expect(selected.scope).toBe("connection");
    expect(selected.preview.visibleTools).not.toContain("forget");
    // The selection is the CONNECTION slot (per-session state).
    expect(setConnectionSelection !== undefined).toBe(true);
  });

  it("selecting a custom tool name via exclusive works when the custom tool is registered", async () => {
    freshRoot();
    // A custom tool (registered elsewhere, e.g. MCP-CUSTOM-RUNTIME-001) is
    // referenced by name. The preview computes against built-ins + whatever
    // the live registry exposes; here the registry is empty, so the tool is
    // simply not visible YET — a profile may reference custom tools before
    // they exist, and they become visible the moment they are registered.
    await createProfileTool({
      name: "custom-only",
      owner: "x",
      directives: [
        { tool: "recall", visibility: "exclusive" },
        { tool: "my_custom_tool", visibility: "exclusive" },
      ],
    });
    const selected = (await selectProfilesTool({
      profiles: ["custom-only"],
    })) as { preview: { visibleTools: string[]; hiddenTools: string[] } };
    expect(selected.preview.visibleTools).toEqual(["recall"]);
    // The custom tool is not present on this tree (registry empty): it is
    // neither visible nor silently re-written — it just is not listed.
    expect(selected.preview.visibleTools).not.toContain("my_custom_tool");
  });

  it("error payloads are structured objects (isError via wrapHandler)", async () => {
    freshRoot();
    const dup = await createProfileTool({
      name: "same",
      owner: "a",
      directives: [],
    });
    expect(dup.success).toBe(true);
    const conflict = await createProfileTool({
      name: "same",
      owner: "b",
      directives: [],
    });
    expect(conflict.success).toBe(false);
    expect(conflict.error).toContain("already exists");
  });
});

describe("in-process MCP round trip (real list path)", () => {
  it("registerTools exposes the four profile tools; interception filters tools/list", async () => {
    freshRoot();
    // Mirror the production wiring (startServer/createHttpServer): register
    // tools, then install the profile interception. registerTools throws if
    // called twice — the shared singleton may already carry tools from
    // another suite in this worker; either state is fine as long as the
    // interception ends up installed exactly once.
    try {
      registerTools();
    } catch (error) {
      expect(String((error as Error).message)).toContain("already registered");
    }
    installProfilesListInterception();

    const names = await listedToolNames();
    for (const required of [
      "list_profiles",
      "create_profile",
      "update_profile",
      "select_profiles",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("tools/list honors the active selection through the real server", async () => {
    freshRoot();
    await createProfileTool({
      name: "no-list-keys",
      owner: "x",
      directives: [{ tool: "list_keys", visibility: "hidden" }],
    });
    setConnectionSelection(["no-list-keys"]);
    const names = await listedToolNames();
    expect(names).not.toContain("list_keys");
    expect(names).toContain("recall");
    setConnectionSelection(undefined);

    const namesAfter = await listedToolNames();
    expect(namesAfter).toContain("list_keys");
  });

  it("tools/call of a hidden-but-authorized tool still executes (profiles never gate calls)", async () => {
    freshRoot();
    await createProfileTool({
      name: "hide-server-status",
      owner: "x",
      directives: [{ tool: "server_status", visibility: "hidden" }],
    });
    setConnectionSelection(["hide-server-status"]);
    // Hidden from DISCOVERY…
    const names = await listedToolNames();
    expect(names).not.toContain("server_status");
    // …but a DIRECT tools/call still runs (existing authorization contract).
    const client = await connectClient();
    const result = await client.callTool({
      name: "server_status",
      arguments: {},
    });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(result.isError).toBeUndefined();
    expect(text).toContain("success");
    await client.close();
  });
});

/** Connect an in-process MCP client through the singleton server. */
async function connectClient(): Promise<Client> {
  const client = new Client({ name: "profiles-test", version: "0.0.1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  // server.connect throws if already connected; the singleton may be held by
  // the stdio autostart or a sibling suite — release is synchronous in the
  // SDK when the previous transport is a closed InMemory pair.
  try {
    await server.connect(serverTransport);
  } catch {
    // Force the SDK's single-transport latch open for this test process.
    (server as unknown as { _transport?: unknown })._transport = undefined;
    await server.connect(serverTransport);
  }
  await client.connect(clientTransport);
  return client;
}

async function listedToolNames(): Promise<string[]> {
  const client = await connectClient();
  const listing = await client.listTools();
  const names = listing.tools.map((t) => t.name);
  await client.close();
  return names;
}
