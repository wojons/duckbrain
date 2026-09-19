/**
 * Header filter-control tests.
 *
 * Two behaviours matter here:
 *  1. the omnibar writes into the shared search state that the memories table
 *     turns into a `q` param;
 *  2. every filter control (domain / author / date-range / prefix / temporal /
 *     all-namespaces) writes into the shared filter state, and the memories
 *     table composes it into GET /api/memories — the wired behaviour is
 *     asserted end-to-end in the last test (UI-GAP-001 flipped the old
 *     local-state-only GAP test).
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Header } from "./header";
import { MemoryTable } from "../memory-table";
import { installApiStub, memoriesRoute } from "../../test/api-stub";
import { renderWithProviders } from "../../test/harness";
import { useUIStore } from "../../stores/ui-store";

// jsdom has no layout engine — same shim as memory-table.test.tsx: every
// row of the dataset is "visible", the real rendering path is exercised.
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

/** Opens the collapsible filter row and returns [domainSelect, dateSelect]. */
async function openFilters(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^filter/i }));
  const combos = screen.getAllByRole("combobox");
  return { domainSelect: combos[0], dateSelect: combos[1] };
}

describe("Header filters", () => {
  it("writes the omnibar search term into shared UI state", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Header />);

    await user.type(screen.getByPlaceholderText("Search memories..."), "alpha");

    expect(useUIStore.getState().searchQuery).toBe("alpha");
  });

  it("exposes the domain and date-range vocabularies behind the Filter toggle", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Header />);

    expect(screen.queryAllByRole("combobox")).toHaveLength(0);

    const { domainSelect, dateSelect } = await openFilters(user);

    expect(
      within(domainSelect)
        .getAllByRole("option")
        .map((option) => option.getAttribute("value")),
    ).toEqual([
      "",
      "config",
      "message",
      "concept",
      "person",
      "project",
      "system",
    ]);

    expect(
      within(dateSelect)
        .getAllByRole("option")
        .map((option) => option.getAttribute("value")),
    ).toEqual(["", "24h", "7d", "30d"]);
  });

  it("shows an active-filter chip for a selected domain and date range", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Header />);
    const { domainSelect, dateSelect } = await openFilters(user);

    await user.selectOptions(domainSelect, "config");
    expect(screen.getByText("Domain: Config")).toBeInTheDocument();

    // "Last 7 Days" renders once as an <option> and once as the active chip
    await user.selectOptions(dateSelect, "7d");
    expect(screen.getAllByText("Last 7 Days")).toHaveLength(2);

    // clearing restores the empty state
    await user.click(screen.getByRole("button", { name: /clear/i }));
    expect(screen.queryByText("Domain: Config")).not.toBeInTheDocument();
    expect(screen.getAllByText("Last 7 Days")).toHaveLength(1);
    expect((domainSelect as HTMLSelectElement).value).toBe("");
    expect((dateSelect as HTMLSelectElement).value).toBe("");
  });

  it("GAP-FIXED: domain / date-range / author / temporal / prefix / all-namespaces selections compose into the list request", async () => {
    const user = userEvent.setup();
    const api = installApiStub([
      memoriesRoute({
        items: [
          {
            id: "m-1",
            key: "/filtered/one",
            domain: "config",
            content: "matched",
            attributes: {},
            timestamp: "2026-09-12T00:00:00.000Z",
            author: "wojonstech@gmail.com",
            isTombstone: false,
            action: "add",
          },
        ],
      }),
    ]);

    // The header owns the controls; the table is what talks to the API.
    renderWithProviders(
      <div>
        <Header />
        <MemoryTable />
      </div>,
    );

    // initial list request fires with no filter params
    await screen.findByText("/filtered/one");
    const first = api.requestsFor("/api/memories")[0];
    for (const key of [
      "domain",
      "author",
      "after",
      "prefix",
      "as_of",
      "allNamespaces",
    ]) {
      expect(first.params.has(key)).toBe(false);
    }

    const { domainSelect, dateSelect } = await openFilters(user);

    // each control change re-issues the list request with the new params
    await user.selectOptions(domainSelect, "config");
    await waitFor(() => {
      expect(api.lastFor("/api/memories")!.params.get("domain")).toBe("config");
    });

    await user.selectOptions(dateSelect, "24h");
    await waitFor(() => {
      const after = api.lastFor("/api/memories")!.params.get("after");
      expect(after).toBeTruthy();
      // "Last 24 Hours" = an ISO instant ~24h ago
      const parsed = new Date(after!).getTime();
      expect(parsed).toBeGreaterThan(Date.now() - 25 * 60 * 60 * 1000);
      expect(parsed).toBeLessThanOrEqual(Date.now());
    });

    await user.type(
      screen.getByPlaceholderText("Filter by author..."),
      "wojonstech@gmail.com",
    );
    await waitFor(() => {
      expect(api.lastFor("/api/memories")!.params.get("author")).toBe(
        "wojonstech@gmail.com",
      );
    });

    await user.type(
      screen.getByPlaceholderText("Filter by prefix..."),
      "/projects",
    );
    await waitFor(() => {
      expect(api.lastFor("/api/memories")!.params.get("prefix")).toBe(
        "/projects",
      );
    });

    // datetime-local inputs fire change events on blur under userEvent
    const afterInput = screen.getByLabelText("Created after");
    fireEvent.change(afterInput, { target: { value: "2026-01-01T08:30" } });
    await waitFor(() => {
      expect(api.lastFor("/api/memories")!.params.get("after")).toBe(
        "2026-01-01T08:30",
      );
    });

    await user.type(screen.getByLabelText("As of"), "HEAD");
    await waitFor(() => {
      expect(api.lastFor("/api/memories")!.params.get("as_of")).toBe("HEAD");
    });

    await user.click(screen.getByRole("checkbox", { name: /all namespaces/i }));
    await waitFor(() => {
      expect(api.lastFor("/api/memories")!.params.get("allNamespaces")).toBe(
        "true",
      );
    });

    // the composed request carries every filter at once
    const composed = api.lastFor("/api/memories")!.params;
    expect(composed.get("domain")).toBe("config");
    expect(composed.get("author")).toBe("wojonstech@gmail.com");
    expect(composed.get("after")).toBe("2026-01-01T08:30");
    expect(composed.get("prefix")).toBe("/projects");
    expect(composed.get("as_of")).toBe("HEAD");
    expect(composed.get("allNamespaces")).toBe("true");
    expect(composed.get("limit")).toBe("50");

    // clearing resets the wire params too
    await user.click(screen.getByRole("button", { name: /clear/i }));
    await waitFor(() => {
      const cleared = api.lastFor("/api/memories")!.params;
      expect(cleared.get("domain")).toBeNull();
      expect(cleared.get("author")).toBeNull();
      expect(cleared.get("after")).toBeNull();
      expect(cleared.get("prefix")).toBeNull();
      expect(cleared.get("as_of")).toBeNull();
      expect(cleared.get("allNamespaces")).toBeNull();
    });
  });
});
