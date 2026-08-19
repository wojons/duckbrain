/**
 * RETR-008 Regression Tests: CLI `search` snippet/highlight printing.
 *
 * Guards src/cli/human.ts searchCommand highlight wiring:
 *   - a hit's highlightedSnippet is what gets printed (the CLI's display
 *     form), with the raw snippet as fallback for consumers that don't
 *     carry it
 *   - the hit header surfaces the row TIMESTAMP alongside the key
 *     (dated chat-archive rows are identifiable in CLI output)
 *
 * searchTool is mocked so the tests exercise the CLI wiring only (the
 * tool + highlight projection are covered by search-retr008.test.ts).
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

/** Capture console.log/console.error lines for the duration of fn. */
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

function chatHit(
  id: string,
  key: string,
  timestamp: string,
  snippet: string,
  highlightedSnippet?: string,
): SearchOutput["memories"][number] {
  return {
    id,
    key,
    domain: "message",
    timestamp,
    author: "totalwindupflightsystems@gmail.com",
    action: "add",
    embedding_text: `${key} body`,
    attributes: {},
    score: 0.9,
    snippet,
    ...(highlightedSnippet !== undefined ? { highlightedSnippet } : {}),
    namespace: "chat-archive",
  };
}

describe("RETR-008: CLI search highlight printing", () => {
  it("prints the highlighted snippet and the dated row's timestamp", async () => {
    vi.mocked(searchTool).mockResolvedValue({
      memories: [
        chatHit(
          "c1",
          "/chats/karahermes-set/2026-06-26",
          "2026-08-07T09:26:26.867Z",
          "…for the GAP-020 harness…",
          "…for the <mark>GAP-020</mark> harness…",
        ),
      ],
      count: 1,
      total: 1,
      namespace: "chat-archive",
    });

    const { logs } = await capture(() =>
      runHumanCLI("search", ["GAP-020", "--namespace=chat-archive"]),
    );
    // The highlighted display form is what the CLI prints.
    expect(logs.some((l) => l.includes("<mark>GAP-020</mark>"))).toBe(true);
    // The raw snippet is NOT printed in place of the highlight.
    expect(logs.some((l) => l.includes("…for the GAP-020 harness…"))).toBe(
      false,
    );
    // Header surfaces key + timestamp + domain for the dated chat row.
    expect(
      logs.some((l) =>
        l.includes(
          "/chats/karahermes-set/2026-06-26 [message · 2026-08-07T09:26:26.867Z]",
        ),
      ),
    ).toBe(true);
  });

  it("falls back to the raw snippet when a hit carries no highlight", async () => {
    vi.mocked(searchTool).mockResolvedValue({
      memories: [
        chatHit(
          "c2",
          "/chats/karahermes-set/2026-06-27",
          "2026-08-07T09:27:00.000Z",
          "plain snippet text",
        ),
      ],
      count: 1,
      total: 1,
      namespace: "chat-archive",
    });

    const { logs } = await capture(() =>
      runHumanCLI("search", ["milk", "--namespace=chat-archive"]),
    );
    expect(logs.some((l) => l.includes("plain snippet text"))).toBe(true);
  });

  it("accepts the space-separated --namespace form without leaking it into the query", async () => {
    vi.mocked(searchTool).mockResolvedValue({
      memories: [],
      count: 0,
      total: 0,
      namespace: "chat-archive",
    });

    const { logs } = await capture(() =>
      runHumanCLI("search", [
        "GAP-020",
        "--namespace",
        "chat-archive",
        "--limit=3",
      ]),
    );
    // The namespace name must NOT join the query, and the flag value must
    // reach the tool — the canonical form from the RETR-008 PASS criterion
    // (`duckbrain search "GAP-020" --namespace chat-archive`).
    expect(vi.mocked(searchTool)).toHaveBeenCalledWith({
      query: "GAP-020",
      limit: 3,
      namespace: "chat-archive",
    });
    expect(logs.join("\n")).not.toContain("Namespace 'true'");
  });
});
