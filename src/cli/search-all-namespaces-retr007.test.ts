/**
 * RETR-007 Regression Tests: CLI `search --all-namespaces`.
 *
 * Guards src/cli/human.ts searchCommand --all-namespaces wiring:
 *   - the flag forwards { allNamespaces: true } and omits namespace
 *   - without the flag the default namespace is forwarded (unchanged)
 *   - union results print each hit's source namespace in the header
 *   - skipped index-less namespaces surface as a stderr note
 *   - `search --help` lists the new flag
 *
 * searchTool is mocked so the tests exercise the CLI wiring only (the
 * tool + union itself are covered by search-retr007.test.ts).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { runHumanCLI } from "./human";
import { searchTool } from "../mcp/tools/search";
import type { SearchOutput } from "../mcp/tools/search";

vi.mock("../mcp/tools/search", async () => {
  const actual = await vi.importActual<typeof import("../mcp/tools/search")>(
    "../mcp/tools/search",
  );
  return {
    ...actual,
    searchTool: vi.fn(),
  };
});

afterEach(() => {
  vi.mocked(searchTool).mockReset();
  vi.mocked(searchTool).mockResolvedValue({
    memories: [],
    count: 0,
    total: 0,
    namespace: "default",
  });
});

/** Capture console.log/console.error lines for the duration of fn.
 * process.exit(1) surfaces as a throw under vitest — swallowed here so
 * callers can assert the usage message; `rejected` records the exit. */
async function capture(
  fn: () => Promise<void>,
): Promise<{ logs: string[]; errors: string[]; rejected: boolean }> {
  const logs: string[] = [];
  const errors: string[] = [];
  let rejected = false;
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...a: any[]) => logs.push(a.map(String).join(" ")));
  const errSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...a: any[]) => errors.push(a.map(String).join(" ")));
  try {
    await fn();
  } catch {
    rejected = true;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { logs, errors, rejected };
}

function unionHit(
  id: string,
  key: string,
  namespace: string,
): SearchOutput["memories"][number] {
  return {
    id,
    key,
    domain: "raw_note",
    timestamp: "2026-08-07T00:00:00.000Z",
    author: "test@example.com",
    action: "add",
    embedding_text: `${key} body`,
    attributes: {},
    score: 0.5,
    snippet: "snippet text",
    namespace,
  };
}

describe("RETR-007: CLI search --all-namespaces", () => {
  it("--all-namespaces forwards allNamespaces: true and no namespace", async () => {
    await capture(() =>
      runHumanCLI("search", ["S3", "--all-namespaces", "--limit=5"]),
    );
    expect(vi.mocked(searchTool)).toHaveBeenCalledWith({
      query: "S3",
      limit: 5,
      allNamespaces: true,
    });
  });

  it("without the flag, the default namespace is forwarded (unchanged)", async () => {
    await capture(() => runHumanCLI("search", ["S3"]));
    expect(vi.mocked(searchTool)).toHaveBeenCalledWith({
      query: "S3",
      limit: 10,
      namespace: "default",
    });
  });

  it("union results print each hit's source namespace in the header", async () => {
    vi.mocked(searchTool).mockResolvedValue({
      memories: [
        unionHit("m1", "/proj/s3-config", "search-retr007-a"),
        unionHit("m2", "/proj/s3-archive", "search-retr007-b"),
      ],
      count: 2,
      total: 2,
      namespace: "all",
      namespacesSearched: ["search-retr007-a", "search-retr007-b"],
      namespacesSkipped: [],
    });

    const { logs } = await capture(() =>
      runHumanCLI("search", ["S3", "--all-namespaces"]),
    );
    expect(logs.some((l) => l.includes("[ns: search-retr007-a]"))).toBe(true);
    expect(logs.some((l) => l.includes("[ns: search-retr007-b]"))).toBe(true);
  });

  it("warns on stderr when index-less namespaces were skipped", async () => {
    vi.mocked(searchTool).mockResolvedValue({
      memories: [],
      count: 0,
      total: 0,
      namespace: "all",
      namespacesSearched: ["default"],
      namespacesSkipped: ["chat-archive"],
    });

    const { errors } = await capture(() =>
      runHumanCLI("search", ["S3", "--all-namespaces"]),
    );
    expect(errors.some((e) => e.includes("skipped 1 namespace"))).toBe(true);
    expect(errors.some((e) => e.includes("chat-archive"))).toBe(true);
  });

  it("--help lists --all-namespaces", async () => {
    const { logs } = await capture(() => runHumanCLI("search", ["--help"]));
    expect(logs.join("\n")).toContain("--all-namespaces");
  });
});
