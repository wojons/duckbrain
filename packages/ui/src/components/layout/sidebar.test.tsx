/**
 * Sidebar namespace switcher tests.
 *
 * The switcher is the entry point for multi-namespace work: it lists what the
 * server reports, POSTs the switch, and adopts the namespace the server
 * confirms back into shared UI state.
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./sidebar";
import {
  installApiStub,
  makeKeyTree,
  standardRoutes,
} from "../../test/api-stub";
import { renderWithProviders } from "../../test/harness";
import { useUIStore } from "../../stores/ui-store";

function optionValues(select: HTMLElement): (string | null)[] {
  return within(select)
    .getAllByRole("option")
    .map((option) => option.getAttribute("value"));
}

describe("Sidebar namespace switcher", () => {
  it("lists the namespaces reported by the API and marks the active one", async () => {
    installApiStub(
      standardRoutes({
        namespaces: ["default", "work"],
        tree: makeKeyTree(),
        currentNamespace: "default",
      }),
    );

    renderWithProviders(<Sidebar namespace="default" />);

    const select = await screen.findByRole("combobox");
    await waitFor(() =>
      expect(optionValues(select)).toEqual(["default", "work"]),
    );
    expect((select as HTMLSelectElement).value).toBe("default");
  });

  it("POSTs the switch and adopts the namespace the server confirms", async () => {
    const user = userEvent.setup();
    const api = installApiStub(
      standardRoutes({ namespaces: ["default", "work"], tree: makeKeyTree() }),
    );

    renderWithProviders(<Sidebar namespace="default" />);
    const select = await screen.findByRole("combobox");
    await waitFor(() => expect(optionValues(select)).toHaveLength(2));

    await user.selectOptions(select, "work");

    await waitFor(() =>
      expect(useUIStore.getState().currentNamespace).toBe("work"),
    );
    const switchRequest = api.lastFor("/api/namespaces/switch", "POST");
    expect(switchRequest?.body).toEqual({ name: "work" });
    expect(api.requestsFor("/api/namespaces/switch", "POST")).toHaveLength(1);
  });

  it("loads the memory tree for the namespace it was handed", async () => {
    const user = userEvent.setup();
    const api = installApiStub(
      standardRoutes({ namespaces: ["default", "work"], tree: makeKeyTree() }),
    );

    renderWithProviders(<Sidebar namespace="work" />);

    // root folder from the API, requested for the right namespace
    expect(await screen.findByText("projects")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // memoryCount badge
    expect(api.lastFor("/api/keys")?.params.get("namespace")).toBe("work");

    // children are collapsed until the user expands the folder
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    await user.click(screen.getByTitle("Expand folder"));
    expect(await screen.findByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
  });
});
