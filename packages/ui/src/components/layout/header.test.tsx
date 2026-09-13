/**
 * Header filter-control tests.
 *
 * Two behaviours matter here:
 *  1. the omnibar writes into the shared search state that the memories table
 *     turns into a `query` param;
 *  2. the domain / author / date-range controls exist and reflect the user's
 *     choice.
 *
 * The last test is marked GAP: those three filter controls are local state
 * only — nothing wires them into a request yet, which is why the richer REST
 * params (domain, after/before, prefix) are not exercised from the UI today.
 */

import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Header } from "./header";
import { installApiStub } from "../../test/api-stub";
import { renderWithProviders } from "../../test/harness";
import { useUIStore } from "../../stores/ui-store";

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
    ).toEqual(["", "config", "message", "concept", "person", "project", "system"]);

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

  it("GAP: domain / date-range / author selections issue no request at all yet", async () => {
    const user = userEvent.setup();
    const api = installApiStub([]);

    renderWithProviders(<Header />);
    const { domainSelect, dateSelect } = await openFilters(user);

    await user.selectOptions(domainSelect, "config");
    await user.selectOptions(dateSelect, "24h");
    await user.type(
      screen.getByPlaceholderText("Filter by author..."),
      "wojonstech@gmail.com",
    );

    // Locked-in current behaviour: the controls are cosmetic until they are
    // wired into memoriesApi.list({ domain, after, before, author }).
    expect(api.requests).toHaveLength(0);
    expect(useUIStore.getState().searchQuery).toBe("");
  });
});
