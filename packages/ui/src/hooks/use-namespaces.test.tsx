/**
 * Namespace boot-adoption tests.
 *
 * The store used to hardcode currentNamespace: "default", which does not
 * exist on normal installs (every panel then 404s against a namespace that
 * was never created). These tests pin the boot contract: on app boot the
 * server-reported currentNamespace from GET /api/namespaces is adopted into
 * the Zustand store; the hardcoded value survives only as the fallback when
 * the fetch fails; and a persisted (localStorage) namespace never masks the
 * server value on boot.
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { useNamespaceBoot, useCurrentNamespace } from "./use-namespaces";
import { installApiStub, namespacesRoute } from "../test/api-stub";
import { renderWithProviders } from "../test/harness";
import { useUIStore } from "../stores/ui-store";

/** Mounts the boot hook and renders the store's namespace for assertions. */
function BootProbe() {
  useNamespaceBoot();
  const current = useCurrentNamespace();
  return <div data-testid="current-namespace">{current}</div>;
}

describe("namespace boot adoption", () => {
  it("adopts the server-reported currentNamespace on boot", async () => {
    installApiStub([namespacesRoute(["default", "work"], "work")]);

    renderWithProviders(<BootProbe />);

    await waitFor(() => {
      expect(screen.getByTestId("current-namespace")).toHaveTextContent("work");
    });
    expect(useUIStore.getState().currentNamespace).toBe("work");
  });

  it("keeps the hardcoded fallback only when the namespaces fetch fails", async () => {
    installApiStub([
      (req) =>
        req.path === "/api/namespaces"
          ? { status: 500, body: { error: "boom" } }
          : undefined,
    ]);

    renderWithProviders(<BootProbe />);

    await waitFor(() => {
      expect(useUIStore.getState().currentNamespace).toBe("default");
    });
    expect(screen.getByTestId("current-namespace")).toHaveTextContent(
      "default",
    );
  });

  it("server value wins over a persisted namespace on boot", async () => {
    // simulate what zustand persist restored from localStorage before boot
    useUIStore.setState({ currentNamespace: "stale-persisted" });
    installApiStub([namespacesRoute(["default", "work"], "work")]);

    renderWithProviders(<BootProbe />);

    await waitFor(() => {
      expect(screen.getByTestId("current-namespace")).toHaveTextContent("work");
    });
    expect(useUIStore.getState().currentNamespace).toBe("work");
  });
});
