/**
 * Timeline page test — the namespace switch end-to-end through the UI.
 *
 * This is the wiring test the feature needs: the sidebar's switcher is the
 * only place a user can change namespace, and the page must then issue its
 * subsequent reads (memories list, key tree, vitals) against the namespace the
 * server confirmed. Everything is asserted through the requests the page
 * actually made; fetch is stubbed, so there is no network and no server.
 */

import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TimelinePage from "./Timeline";
import {
  installApiStub,
  makeKeyTree,
  makeMemories,
  standardRoutes,
} from "../test/api-stub";
import { renderWithProviders } from "../test/harness";
import { useUIStore } from "../stores/ui-store";

// See memory-table.test.tsx: jsdom has no layout, so stub only the virtual
// measurement layer and let every row render.
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

describe("Timeline — namespace switch drives subsequent fetches", () => {
  it("re-scopes memories and keys to the newly selected namespace", async () => {
    const user = userEvent.setup();
    const api = installApiStub(
      standardRoutes({
        memories: makeMemories(4, "/int"),
        tree: makeKeyTree(),
        namespaces: ["default", "work"],
        currentNamespace: "default",
      }),
    );

    renderWithProviders(<TimelinePage />, { route: "/timeline" });

    // initial load: rows rendered, reads scoped to the store's namespace
    expect(await screen.findByText("/int/000")).toBeInTheDocument();
    expect(api.namespacesFor("/api/memories")).toContain("default");

    // the only combobox on the page is the sidebar's namespace switcher
    const namespaceSelect = screen.getByRole("combobox");
    await user.selectOptions(namespaceSelect, "work");

    // the switch is announced to the server and adopted client-side
    const switchRequest = api.lastFor("/api/namespaces/switch", "POST");
    expect(switchRequest?.body).toEqual({ name: "work" });
    await waitFor(() =>
      expect(useUIStore.getState().currentNamespace).toBe("work"),
    );

    // ... and subsequent reads follow the new namespace
    await waitFor(() => {
      expect(api.namespacesFor("/api/memories")).toContain("work");
    });
    await waitFor(() => {
      expect(api.namespacesFor("/api/keys")).toContain("work");
    });
  });

  it("never reads a namespace the user did not select", async () => {
    const api = installApiStub(
      standardRoutes({
        memories: makeMemories(2, "/int"),
        tree: makeKeyTree(),
        namespaces: ["default", "work", "archive"],
      }),
    );

    renderWithProviders(<TimelinePage />, { route: "/timeline" });
    await screen.findByText("/int/000");

    const namespacesRead = new Set(
      api.requests
        .map((req) => req.params.get("namespace"))
        .filter((value): value is string => value !== null),
    );

    expect([...namespacesRead]).toEqual(["default"]);
  });
});
