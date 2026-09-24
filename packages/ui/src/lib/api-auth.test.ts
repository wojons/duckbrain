/**
 * Auth contract tests for the API client.
 *
 * Pins the hardened-deployment contract (auth=apikey): a user-entered
 * DuckBrain API token is stored in localStorage and attached as X-API-Key on
 * every request; a 401 response surfaces as a DISTINCT ApiAuthError so the
 * UI can react without retry storms; and the shared query retry predicate
 * never retries auth errors and retries everything else at most once.
 *
 * Zero network — fetch is stubbed via installApiStub().
 */

import { describe, expect, it } from "vitest";
import {
  ApiAuthError,
  ApiError,
  clearApiToken,
  getApiToken,
  namespacesApi,
  setApiToken,
  shouldRetryQuery,
} from "./api-client";
import { installApiStub, namespacesRoute } from "../test/api-stub";

describe("api token storage", () => {
  it("persists the token to localStorage under duckbrain-api-token", () => {
    clearApiToken();
    expect(getApiToken()).toBeNull();

    setApiToken("secret-token-123");

    expect(window.localStorage.getItem("duckbrain-api-token")).toBe(
      "secret-token-123",
    );
    expect(getApiToken()).toBe("secret-token-123");
  });

  it("clears the token from localStorage", () => {
    setApiToken("secret-token-123");

    clearApiToken();

    expect(getApiToken()).toBeNull();
    expect(window.localStorage.getItem("duckbrain-api-token")).toBeNull();
  });
});

describe("apiFetch credentials", () => {
  it("attaches X-API-Key on every request when a token is set", async () => {
    setApiToken("secret-token-123");
    const api = installApiStub([namespacesRoute(["default"])]);

    await namespacesApi.list();

    expect(api.lastFor("/api/namespaces")?.headers.get("X-API-Key")).toBe(
      "secret-token-123",
    );
    clearApiToken();
  });

  it("sends no X-API-Key header when no token is set", async () => {
    clearApiToken();
    const api = installApiStub([namespacesRoute(["default"])]);

    await namespacesApi.list();

    expect(api.lastFor("/api/namespaces")?.headers.has("X-API-Key")).toBe(
      false,
    );
  });
});

describe("401 handling", () => {
  it("maps a 401 response to the distinct ApiAuthError with the status attached", async () => {
    installApiStub([
      (req) =>
        req.path === "/api/namespaces"
          ? { status: 401, body: { error: "Unauthorized" } }
          : undefined,
    ]);

    const error = await namespacesApi.list().catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiAuthError);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiAuthError).status).toBe(401);
  });

  it("does not map other error statuses to ApiAuthError", async () => {
    installApiStub([
      (req) =>
        req.path === "/api/namespaces"
          ? { status: 500, body: { error: "boom" } }
          : undefined,
    ]);

    const error = await namespacesApi.list().catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(ApiAuthError);
    expect((error as ApiError).status).toBe(500);
  });
});

describe("shouldRetryQuery (shared QueryClient retry predicate)", () => {
  it("retries other errors at most once", () => {
    expect(shouldRetryQuery(0, new Error("boom"))).toBe(true);
    expect(shouldRetryQuery(1, new Error("boom"))).toBe(false);
    expect(shouldRetryQuery(5, new Error("boom"))).toBe(false);
  });

  it("never retries auth errors", () => {
    const authError = new ApiAuthError(401);
    expect(shouldRetryQuery(0, authError)).toBe(false);
    expect(shouldRetryQuery(1, authError)).toBe(false);
    expect(shouldRetryQuery(9, authError)).toBe(false);
  });
});
