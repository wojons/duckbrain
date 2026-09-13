/**
 * MemoryTable behaviour tests.
 *
 * The table is the UI's memory browser: it renders whatever GET /api/memories
 * returns and drives pagination itself (react-query infinite query with
 * limit/offset). These tests assert the requests it issues and the rows it
 * renders — no snapshots, no network.
 */

import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryTable } from "./memory-table";
import { installApiStub, makeMemories, standardRoutes } from "../test/api-stub";
import { renderWithProviders } from "../test/harness";
import { useUIStore } from "../stores/ui-store";

// jsdom has no layout engine, so @tanstack/react-virtual measures a 0px
// scroll container and would render a single row. Replace only the
// measurement layer: every row of the dataset is "visible", the real table
// rendering path (columns, cells, pagination) is exercised unchanged.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number; estimateSize?: () => number }) => {
    const size = options.estimateSize ? options.estimateSize() : 48;
    return {
      getVirtualItems: () =>
        Array.from({ length: options.count }, (_, index) => ({
          index,
          key: index,
          start: index * size,
          size,
          end: (index + 1) * size,
          lane: 0,
        })),
      getTotalSize: () => options.count * size,
      measureElement: () => {},
      scrollToIndex: () => {},
      scrollToOffset: () => {},
      options,
    };
  },
}));

describe("MemoryTable", () => {
  it("renders one row per memory returned by the API", async () => {
    const api = installApiStub(
      standardRoutes({ memories: makeMemories(3, "/projects") }),
    );

    renderWithProviders(<MemoryTable namespace="default" />);

    expect(await screen.findByText("/projects/000")).toBeInTheDocument();
    expect(screen.getByText("/projects/001")).toBeInTheDocument();
    expect(screen.getByText("/projects/002")).toBeInTheDocument();
    expect(api.requestsFor("/api/memories")).toHaveLength(1);
  });

  it("requests the first page with limit/offset and the active namespace", async () => {
    const api = installApiStub(
      standardRoutes({ memories: makeMemories(60, "/page") }),
    );

    renderWithProviders(<MemoryTable namespace="work" />);
    await screen.findByText("/page/000");

    const first = api.requestsFor("/api/memories")[0];
    expect(first.params.get("limit")).toBe("50");
    expect(first.params.get("offset")).toBe("0");
    expect(first.params.get("namespace")).toBe("work");
    expect(first.url).toContain("/api/memories?");
  });

  it("requests the next page with offset=nextOffset when Load More is clicked", async () => {
    const user = userEvent.setup();
    const api = installApiStub(
      standardRoutes({ memories: makeMemories(60, "/page") }),
    );

    renderWithProviders(<MemoryTable namespace="default" />);
    await screen.findByText("/page/000");

    // 60 items, page size 50 -> a next page exists
    await user.click(await screen.findByRole("button", { name: /load more/i }));

    expect(await screen.findByText("/page/050")).toBeInTheDocument();

    await waitFor(() => {
      const offsets = api
        .requestsFor("/api/memories")
        .map((req) => req.params.get("offset"));
      expect(offsets).toContain("50");
    });

    // the second page keeps the same namespace scope
    const second = api
      .requestsFor("/api/memories")
      .find((req) => req.params.get("offset") === "50");
    expect(second?.params.get("namespace")).toBe("default");
    // and page size never changes mid-session
    expect(second?.params.get("limit")).toBe("50");
  });

  it("does not offer Load More when the API reports a single page", async () => {
    installApiStub(standardRoutes({ memories: makeMemories(3, "/small") }));

    renderWithProviders(<MemoryTable namespace="default" />);
    await screen.findByText("/small/000");

    expect(
      screen.queryByRole("button", { name: /load more/i }),
    ).not.toBeInTheDocument();
  });

  it("sends the omnibar search term with the list request", async () => {
    const api = installApiStub(
      standardRoutes({ memories: makeMemories(1, "/search") }),
    );
    useUIStore.setState({ searchQuery: "alpha" });

    renderWithProviders(<MemoryTable namespace="default" />);
    await screen.findByText("/search/000");

    // GAP: the term goes out as ?query= while the backend route reads ?q=
    // (see src/lib/api-client.test.ts). This pins the UI's current contract.
    const params = api.requestsFor("/api/memories")[0].params;
    expect(params.get("query")).toBe("alpha");
    expect(params.get("limit")).toBe("50");
    expect(params.get("offset")).toBe("0");
  });

  it("renders the empty state when the API returns no memories", async () => {
    installApiStub(standardRoutes({ memories: [] }));

    renderWithProviders(<MemoryTable namespace="default" />);

    expect(await screen.findByText("No memories yet")).toBeInTheDocument();
  });

  it("renders a retryable error state when the API fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    installApiStub([
      (req) =>
        req.path === "/api/memories" && req.method === "GET"
          ? { status: 500, body: { error: "boom" } }
          : undefined,
    ]);

    try {
      renderWithProviders(<MemoryTable namespace="default" />);

      expect(
        await screen.findByText("Failed to load memories"),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
      expect(screen.getByText("boom")).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });
});
