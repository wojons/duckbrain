/**
 * DOGFOOD-009 regression tests: CLI `list-keys` plain-text tree output
 *
 * The old CLI renderer split keys on "/" without filtering empty segments, so
 * leading-slash keys ("/projects/...") produced a cryptic nested JSON object
 * with a "" root key. The CLI now reuses the REST tree builder and renders an
 * indented plain-text tree.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock listKeysTool before importing the CLI
vi.mock("../mcp/tools/list_keys", () => ({
  listKeysTool: vi.fn(),
}));

import { listKeysTool } from "../mcp/tools/list_keys";
import { runHumanCLI } from "./human";
import { buildKeyTree, renderKeyTreeText } from "../utils/keyTree";

const mockedListKeysTool = vi.mocked(listKeysTool);

function mockKeys(keys: string[], hasMore: boolean = false) {
  mockedListKeysTool.mockResolvedValue({
    keys,
    hasMore,
    nextOffset: null,
    prefixes: {},
  });
}

describe("DOGFOOD-009: CLI list-keys plain-text tree", () => {
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logs = [];
    logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("renders an indented tree with folders and leaves, not JSON", async () => {
    mockKeys([
      "/projects/duckbrain/status",
      "/projects/duckbrain/other",
      "/notes/personal",
    ]);

    await runHumanCLI("list-keys", ["--depth=3"]);

    const output = logs.join("\n");

    // Header is preserved
    expect(logs[0]).toBe("Keys (3 total):");

    // Folders render with trailing slash at their depth
    expect(output).toContain("/notes/");
    expect(output).toContain("/projects/");
    expect(output).toContain("  /projects/duckbrain/");

    // Leaves render without trailing slash, nested under their folders
    expect(output).toContain("  /notes/personal\n");
    expect(output).toContain("    /projects/duckbrain/status");
    expect(output).toContain("    /projects/duckbrain/other");

    // No JSON artifacts anywhere in the output
    expect(output).not.toContain('""');
    expect(output).not.toContain("{");
    expect(output).not.toContain("}");

    // Root-level entries start at the first real segment (no empty root)
    const treeLines = logs.slice(1);
    for (const line of treeLines) {
      expect(line).toMatch(/^\s*\//);
    }
  });

  it("keeps the pagination hint when hasMore is true", async () => {
    mockKeys(["/a", "/b"], true);

    await runHumanCLI("list-keys", []);

    const output = logs.join("\n");
    expect(output).toContain("Keys (2 total):");
    expect(output).toContain("--offset=50");
  });

  it("prints 'No keys found' for an empty key list", async () => {
    mockKeys([]);

    await runHumanCLI("list-keys", []);

    expect(logs).toEqual(["No keys found"]);
  });

  it("prints 'No keys found' when keys are missing from the result", async () => {
    mockedListKeysTool.mockResolvedValue({
      hasMore: false,
      nextOffset: null,
      prefixes: {},
    } as any);

    await runHumanCLI("list-keys", []);

    expect(logs).toEqual(["No keys found"]);
  });
});

describe("DOGFOOD-009: shared key tree builder/renderer", () => {
  it("never creates an empty-segment node from a leading slash", () => {
    const tree = buildKeyTree(["/projects/duckbrain/status"], 10);

    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("projects");
    expect(tree[0].path).toBe("/projects");
    expect(JSON.stringify(tree)).not.toContain('"name":""');
  });

  it("marks intermediate nodes as folders and full-depth nodes as memory", () => {
    const tree = buildKeyTree(["/projects/duckbrain/status"], 10);

    expect(tree[0].type).toBe("folder");
    const duckbrain = tree[0].children![0];
    expect(duckbrain.type).toBe("folder");
    expect(duckbrain.children![0].type).toBe("memory");
  });

  it("renderKeyTreeText returns an empty string for an empty tree", () => {
    expect(renderKeyTreeText([])).toBe("");
  });

  it("renderKeyTreeText distinguishes folders from leaves", () => {
    const tree = buildKeyTree(["/notes/personal", "/notes/work"], 10);
    const text = renderKeyTreeText(tree);

    expect(text).toBe("/notes/\n  /notes/personal\n  /notes/work");
  });
});
