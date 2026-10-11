/**
 * MCP-CONNECTION-PROFILES-001 — unit tests for the profile state model.
 *
 * Covers the acceptance surface that needs no server: deterministic
 * composition (overlaps, conflicts, order), per-connection isolation,
 * create/update ownership, header parsing, the built-in/custom-tool split,
 * and — the load-bearing one — that composition shapes VISIBILITY only and
 * has no representation of authorization.
 *
 * Every test runs against a scratch DUCKBRAIN_CONFIG_PATH root so neither
 * the repo config nor the live profile store is touched (GAP-007/GAP-022
 * isolation doctrine). The active-selection slots are reset after each test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  BUILTIN_TOOL_NAMES,
  CONNECTION_NOTE,
  activeSelection,
  composeVisibility,
  createProfile,
  filterToolsList,
  getProfile,
  listProfiles,
  parseProfilesHeader,
  profileStorePath,
  readProfileStore,
  setConnectionSelection,
  setRequestSelection,
  updateProfile,
} from "./profiles";

let scratchRoot: string;
let savedConfigPath: string | undefined;

function scratch(): string {
  return scratchRoot;
}

const ALL_TOOLS = [...BUILTIN_TOOL_NAMES];

beforeEach(() => {
  scratchRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "duckbrain-mcp-profiles-"),
  );
  savedConfigPath = process.env.DUCKBRAIN_CONFIG_PATH;
  process.env.DUCKBRAIN_CONFIG_PATH = path.join(
    scratchRoot,
    "duckbrain.config.json",
  );
});

afterEach(() => {
  setRequestSelection(undefined);
  setConnectionSelection(undefined);
  if (savedConfigPath === undefined) delete process.env.DUCKBRAIN_CONFIG_PATH;
  else process.env.DUCKBRAIN_CONFIG_PATH = savedConfigPath;
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

describe("profile store (additive, scratch-rooted)", () => {
  it("reads an empty store when no file exists", () => {
    expect(readProfileStore(scratch())).toEqual({ version: 1, profiles: [] });
  });

  it("creates a profile and lists it; create refuses to overwrite", () => {
    const created = createProfile({
      name: "scout",
      owner: "agent-a",
      directives: [{ tool: "squash", visibility: "hidden" }],
      root: scratch(),
    });
    expect(created.success).toBe(true);
    expect(listProfiles(scratch()).map((p) => p.name)).toEqual(["scout"]);

    const again = createProfile({
      name: "scout",
      owner: "agent-b",
      root: scratch(),
    });
    expect(again.success).toBe(false);
    expect(again.error).toContain("already exists");
    // The original definition is untouched.
    expect(getProfile("scout", scratch())?.owner).toBe("agent-a");
  });

  it("update replaces directives and enforces owner isolation", () => {
    createProfile({
      name: "p",
      owner: "agent-a",
      directives: [{ tool: "forget", visibility: "hidden" }],
      root: scratch(),
    });

    const foreign = updateProfile({
      name: "p",
      owner: "agent-b",
      directives: [],
      root: scratch(),
    });
    expect(foreign.success).toBe(false);
    expect(foreign.error).toContain("owned by 'agent-a'");
    // Foreign update mutated nothing.
    expect(getProfile("p", scratch())?.directives).toHaveLength(1);

    const own = updateProfile({
      name: "p",
      owner: "agent-a",
      directives: [
        { tool: "forget", visibility: "default" },
        { tool: "squash", visibility: "hidden" },
      ],
      root: scratch(),
    });
    expect(own.success).toBe(true);
    expect(getProfile("p", scratch())?.directives).toHaveLength(2);
    expect(getProfile("p", scratch())?.createdAt).toBe(
      getProfile("p", scratch())?.createdAt,
    );
  });

  it("update of a missing profile is a loud error, not a create", () => {
    const result = updateProfile({
      name: "ghost",
      owner: "agent-a",
      directives: [],
      root: scratch(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("does not exist");
  });

  it("writes the store next to the scratch config root, not the repo", () => {
    createProfile({ name: "where", owner: "x", root: scratch() });
    const expected = path.join(scratchRoot, ".duckbrain", "mcp-profiles.json");
    expect(fs.existsSync(expected)).toBe(true);
    expect(profileStorePath(scratch())).toBe(expected);
  });
});

describe("deterministic composition", () => {
  it("no selection returns every tool (discovery unchanged)", () => {
    const result = composeVisibility(undefined, ALL_TOOLS, scratch());
    expect(result.visible).toEqual(ALL_TOOLS);
  });

  it("hidden removes tools from visibility", () => {
    createProfile({
      name: "no-admin",
      owner: "agent-a",
      directives: [
        { tool: "squash", visibility: "hidden" },
        { tool: "delete_namespace", visibility: "hidden" },
      ],
      root: scratch(),
    });
    const result = composeVisibility(["no-admin"], ALL_TOOLS, scratch());
    expect(result.visible).not.toContain("squash");
    expect(result.visible).not.toContain("delete_namespace");
    expect(result.visible).toContain("recall");
    expect(result.hiddenNames.sort()).toEqual(["delete_namespace", "squash"]);
  });

  it("exclusive narrows visibility to exactly the exclusive-named set", () => {
    createProfile({
      name: "minimal",
      owner: "agent-a",
      directives: [
        { tool: "remember", visibility: "exclusive" },
        { tool: "recall", visibility: "exclusive" },
      ],
      root: scratch(),
    });
    const result = composeVisibility(["minimal"], ALL_TOOLS, scratch());
    expect(result.visible.sort()).toEqual(["recall", "remember"]);
    expect(result.exclusiveActive).toBe(true);
  });

  it("multi-profile overlap: union of directives; order-independent; default never re-widens a hidden", () => {
    createProfile({
      name: "no-write",
      owner: "agent-a",
      directives: [
        { tool: "remember", visibility: "hidden" },
        { tool: "forget", visibility: "hidden" },
      ],
      root: scratch(),
    });
    createProfile({
      name: "writer",
      owner: "agent-a",
      directives: [{ tool: "remember", visibility: "default" }],
      root: scratch(),
    });
    // Composition is the set union of directives: writer's `default` on
    // remember is a NO-OP against no-write's `hidden` (a default never
    // re-widens what another selected profile hid). forget stays hidden.
    // Order cannot change the outcome.
    const forward = composeVisibility(
      ["no-write", "writer"],
      ALL_TOOLS,
      scratch(),
    );
    expect(forward.visible).not.toContain("remember");
    expect(forward.visible).not.toContain("forget");

    const reversed = composeVisibility(
      ["writer", "no-write"],
      ALL_TOOLS,
      scratch(),
    );
    expect(reversed.visible).toEqual(forward.visible);
    expect(reversed.visible).not.toContain("remember");
  });

  it("multi-profile exclusive: any exclusive directive narrows, hidden still wins", () => {
    createProfile({
      name: "only-read",
      owner: "agent-a",
      directives: [
        { tool: "recall", visibility: "exclusive" },
        { tool: "list_keys", visibility: "exclusive" },
      ],
      root: scratch(),
    });
    createProfile({
      name: "mute-keys",
      owner: "agent-a",
      directives: [{ tool: "list_keys", visibility: "hidden" }],
      root: scratch(),
    });
    // hidden beats exclusive REGARDLESS of order (documented conflict rule).
    const a = composeVisibility(
      ["only-read", "mute-keys"],
      ALL_TOOLS,
      scratch(),
    );
    const b = composeVisibility(
      ["mute-keys", "only-read"],
      ALL_TOOLS,
      scratch(),
    );
    for (const result of [a, b]) {
      expect(result.visible).toEqual(["recall"]);
      expect(result.exclusiveActive).toBe(true);
    }
  });

  it("unknown profile names are reported and never fabricate visibility", () => {
    const result = composeVisibility(["does-not-exist"], ALL_TOOLS, scratch());
    expect(result.unknownProfiles).toEqual(["does-not-exist"]);
    // No selection effect: everything stays visible.
    expect(result.visible).toEqual(ALL_TOOLS);
  });

  it("deterministic: same inputs produce byte-identical outputs", () => {
    createProfile({
      name: "det",
      owner: "x",
      directives: [
        { tool: "squash", visibility: "exclusive" },
        { tool: "recall", visibility: "exclusive" },
        { tool: "forget", visibility: "hidden" },
      ],
      root: scratch(),
    });
    const run = () =>
      JSON.stringify(composeVisibility(["det"], ALL_TOOLS, scratch()).visible);
    expect(run()).toBe(run());
    expect(run()).toBe(JSON.stringify(["recall", "squash"]));
  });
});

describe("selection state isolation (per connection/session)", () => {
  it("request slot overrides connection slot; clear restores", () => {
    setConnectionSelection(["conn-profile"]);
    expect(activeSelection()).toEqual(["conn-profile"]);
    setRequestSelection(["req-profile"]);
    expect(activeSelection()).toEqual(["req-profile"]);
    setRequestSelection(undefined);
    expect(activeSelection()).toEqual(["conn-profile"]);
  });

  it("clearing the connection selection returns to no selection", () => {
    setConnectionSelection(["x"]);
    setConnectionSelection(undefined);
    expect(activeSelection()).toBeUndefined();
  });
});

describe("X-DuckBrain-Profiles header parsing", () => {
  it("parses comma-separated names with whitespace", () => {
    expect(parseProfilesHeader(" a , b,c")).toEqual(["a", "b", "c"]);
  });

  it("absent or blank header means no selection (undefined)", () => {
    expect(parseProfilesHeader(undefined)).toBeUndefined();
    expect(parseProfilesHeader("")).toBeUndefined();
    expect(parseProfilesHeader("  ,  ")).toBeUndefined();
  });

  it("accepts array header values (express repeated headers)", () => {
    expect(parseProfilesHeader(["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("visibility-only contract (the hard boundary)", () => {
  it("composition output has NO authorization representation", () => {
    // The entire composition result is name lists + booleans. There is no
    // grant, role, token, namespace, or permission field anywhere in the
    // model — profiles cannot carry authority by construction.
    createProfile({
      name: "anything",
      owner: "x",
      directives: [{ tool: "recall", visibility: "exclusive" }],
      root: scratch(),
    });
    const result = composeVisibility(["anything"], ALL_TOOLS, scratch());
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "grant",
      "role",
      "token",
      "permission",
      "namespace",
      "auth",
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
    // The ConnectionProfile record itself carries only visibility state.
    const profile = JSON.stringify(getProfile("anything", scratch()));
    for (const forbidden of ["keyHash", "passwordHash", "tableGrants"]) {
      expect(profile).not.toContain(forbidden);
    }
  });

  it("CONNECTION_NOTE states the not-a-security-boundary contract", () => {
    expect(CONNECTION_NOTE).toContain("NOT security boundaries");
    expect(CONNECTION_NOTE).toContain("authentication, namespace grants");
  });

  it("filterToolsList filters entries by the active selection", () => {
    createProfile({
      name: "quiet",
      owner: "x",
      directives: [{ tool: "squash", visibility: "hidden" }],
      root: scratch(),
    });
    setConnectionSelection(["quiet"]);
    const payload = ALL_TOOLS.map((name) => ({ name, title: name }));
    const filtered = filterToolsList(payload);
    expect(filtered.tools.map((t) => t.name)).not.toContain("squash");
    expect(filtered.tools).toHaveLength(ALL_TOOLS.length - 1);
    // No selection -> unchanged payload (filter is a no-op passthrough).
    setConnectionSelection(undefined);
    expect(filterToolsList(payload).tools).toHaveLength(ALL_TOOLS.length);
  });
});
