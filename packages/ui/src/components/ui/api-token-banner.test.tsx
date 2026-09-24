/**
 * API token entry tests — the UI side of hardened (--auth=apikey) deployments.
 *
 * Pins: the header control persists a pasted token to localStorage and
 * refreshes the app's queries; the banner appears only while the boot-time
 * namespaces fetch fails with 401, and disappears once a working token is
 * saved (the refetched boot query clears the flag); non-auth failures do not
 * summon the token banner.
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiAuthBanner, ApiTokenControl } from "./api-token-banner";
import { useNamespaceBoot } from "../../hooks/use-namespaces";
import { installApiStub, namespacesRoute } from "../../test/api-stub";
import { renderWithProviders } from "../../test/harness";

/**
 * The real app mounts useNamespaceBoot above the banner (AppShell); mirror
 * that wiring so the banner's store flag is driven by live query results.
 */
function BootAndBanner() {
  useNamespaceBoot();
  return <ApiAuthBanner />;
}

describe("ApiTokenControl", () => {
  it("saves a pasted token to localStorage and shows it as set", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ApiTokenControl />);

    await user.click(screen.getByRole("button", { name: /api token/i }));
    await user.type(
      screen.getByLabelText("DuckBrain API token"),
      "secret-token-123",
    );
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(window.localStorage.getItem("duckbrain-api-token")).toBe(
      "secret-token-123",
    );
    expect(screen.getByText(/token set/i)).toBeInTheDocument();
  });

  it("clears the stored token", async () => {
    window.localStorage.setItem("duckbrain-api-token", "secret-token-123");
    const user = userEvent.setup();
    renderWithProviders(<ApiTokenControl />);

    await user.click(screen.getByRole("button", { name: /api token/i }));
    await user.click(screen.getByRole("button", { name: /^clear$/i }));

    expect(window.localStorage.getItem("duckbrain-api-token")).toBeNull();
    expect(screen.getByText(/no token set/i)).toBeInTheDocument();
  });
});

describe("ApiAuthBanner", () => {
  it("is hidden while the API answers normally", async () => {
    installApiStub([namespacesRoute(["default"], "default")]);
    renderWithProviders(<BootAndBanner />);

    await waitFor(() => {
      expect(screen.queryByText(/not authorized/i)).not.toBeInTheDocument();
    });
    // boot adoption ran as a side effect
    await waitFor(() => {
      expect(screen.queryByText(/not authorized/i)).not.toBeInTheDocument();
    });
  });

  it("appears on a boot 401 and disappears once a working token is saved", async () => {
    const user = userEvent.setup();
    let calls = 0;
    installApiStub([
      (req) => {
        if (req.path !== "/api/namespaces") return undefined;
        calls += 1;
        if (calls === 1) {
          return { status: 401, body: { error: "Unauthorized" } };
        }
        return namespacesRoute(["work"], "work")(req);
      },
    ]);

    renderWithProviders(<BootAndBanner />);

    // first boot call is rejected -> banner with the plain-text message
    expect(await screen.findByText(/not authorized/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText("DuckBrain API token"), "good-token");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    // saving invalidates: exactly one refetch (no retries) with the token,
    // the boot query succeeds, the flag clears, the banner disappears
    await waitFor(() => {
      expect(screen.queryByText(/not authorized/i)).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem("duckbrain-api-token")).toBe(
      "good-token",
    );
    expect(calls).toBe(2);
  });

  it("does not appear for non-auth failures (500s are not a token problem)", async () => {
    installApiStub([
      (req) =>
        req.path === "/api/namespaces"
          ? { status: 500, body: { error: "boom" } }
          : undefined,
    ]);
    renderWithProviders(<BootAndBanner />);

    await waitFor(() => {
      expect(screen.queryByText(/not authorized/i)).not.toBeInTheDocument();
    });
  });
});
