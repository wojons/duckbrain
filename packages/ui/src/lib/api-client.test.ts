/**
 * API client contract tests.
 *
 * These pin the UI's side of DuckBrain's rich REST query surface: the exact
 * query params the app puts on the wire for pagination, prefix/domain/author
 * filters, search and namespace scoping. Zero network — fetch is stubbed.
 *
 * Two tests are explicitly marked GAP: they document backend capabilities the
 * UI cannot request yet (they are the to-do list for wiring the newer REST
 * params into the web interface).
 */

import { describe, expect, it } from "vitest";
import {
  createNamespaceRoute,
  installApiStub,
  keysRoute,
  makeKeyTree,
  makeMemory,
  memoriesRoute,
  namespacesRoute,
  switchNamespaceRoute,
} from "../test/api-stub";
import { keysApi, memoriesApi, namespacesApi } from "./api-client";
import type {
  CreateMemoryRequest,
  UpdateMemoryRequest,
} from "../../../../src/http/types/api";

describe("memoriesApi.list — REST query params", () => {
  it("sends limit/offset pagination params", async () => {
    const api = installApiStub([memoriesRoute({ items: [] })]);

    await memoriesApi.list({ limit: 50, offset: 100 });

    expect(api.urlFor("/api/memories")).toBe("/api/memories?limit=50&offset=100");
    const req = api.lastFor("/api/memories");
    expect(req?.method).toBe("GET");
    expect(req?.params.get("limit")).toBe("50");
    expect(req?.params.get("offset")).toBe("100");
  });

  it("sends prefix, domain and author filters", async () => {
    const api = installApiStub([memoriesRoute({ items: [] })]);

    await memoriesApi.list({
      prefix: "/projects",
      domain: "config",
      author: "wojonstech@gmail.com",
    });

    const params = api.lastFor("/api/memories")!.params;
    expect(params.get("prefix")).toBe("/projects");
    expect(params.get("domain")).toBe("config");
    expect(params.get("author")).toBe("wojonstech@gmail.com");
  });

  it("scopes the request with an explicit namespace param", async () => {
    const api = installApiStub([memoriesRoute({ items: [] })]);

    await memoriesApi.list({ namespace: "work", limit: 10, offset: 0 });
    expect(api.lastFor("/api/memories")!.params.get("namespace")).toBe("work");

    await memoriesApi.list({ limit: 10 });
    expect(api.lastFor("/api/memories")!.params.has("namespace")).toBe(false);
  });

  it("omits undefined and empty filters instead of sending blank params", async () => {
    const api = installApiStub([memoriesRoute({ items: [] })]);

    await memoriesApi.list();
    expect(api.urlFor("/api/memories")).toBe("/api/memories");

    await memoriesApi.list({ limit: 5, offset: 0, domain: "", prefix: "" });
    expect(api.urlFor("/api/memories")).toBe("/api/memories?limit=5&offset=0");
  });

  it("sends the omnibar search term as `q` (the param the backend reads)", async () => {
    // FIXED: the client previously sent ?query=, which the backend ignores
    // (src/http/routes/memories.ts maps `query: req.query.q`) — UI search
    // never reached the engine. The term now rides as ?q=.
    const api = installApiStub([memoriesRoute({ items: [] })]);

    await memoriesApi.list({ query: "alpha" });

    const params = api.lastFor("/api/memories")!.params;
    expect(params.get("q")).toBe("alpha");
    expect(params.get("query")).toBeNull();
  });

  it("forwards temporal / multi-namespace params verbatim when a caller supplies them", async () => {
    // The backend supports ?after, ?before, ?between, ?as_of, ?historical,
    // ?contains, ?allNamespaces (src/http/routes/memories.ts). The request
    // builder appends every key it is given, so the client is already
    // temporal-ready — what is missing is a UI control that supplies them
    // (see the GAP test in src/components/layout/header.test.tsx).
    const api = installApiStub([memoriesRoute({ items: [] })]);

    const temporal = {
      after: "2026-01-01T00:00:00.000Z",
      before: "2026-09-01T00:00:00.000Z",
      between: "2026-01-01,2026-09-01",
      as_of: "HEAD",
      historical: true,
      contains: "token",
      allNamespaces: true,
    };
    await memoriesApi.list(
      temporal as unknown as Parameters<typeof memoriesApi.list>[0],
    );

    const params = api.lastFor("/api/memories")!.params;
    for (const [key, value] of Object.entries(temporal)) {
      expect(params.get(key)).toBe(String(value));
    }
    // ... and they compose with pagination/filter params
    await memoriesApi.list({
      limit: 10,
      offset: 20,
      namespace: "work",
      after: "2026-01-01T00:00:00.000Z",
    } as unknown as Parameters<typeof memoriesApi.list>[0]);

    const composed = api.lastFor("/api/memories")!.params;
    expect(composed.get("limit")).toBe("10");
    expect(composed.get("offset")).toBe("20");
    expect(composed.get("namespace")).toBe("work");
    expect(composed.get("after")).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("memoriesApi — single-memory endpoints", () => {
  it("fetches one memory by id with namespace scoping", async () => {
    const api = installApiStub([
      (req) =>
        req.path.startsWith("/api/memories/") && req.method === "GET"
          ? { body: makeMemory({ key: "/projects/alpha" }) }
          : undefined,
    ]);

    await memoriesApi.get("11111111-1111-4111-8111-111111111111", "work");

    const req = api.lastFor("/api/memories/11111111-1111-4111-8111-111111111111");
    expect(req?.params.get("namespace")).toBe("work");
  });

  it("fetches by key path, stripping the leading slash and escaping it", async () => {
    const api = installApiStub([
      (req) =>
        req.path.startsWith("/api/memories/key/") && req.method === "GET"
          ? { body: makeMemory({ key: "/projects/alpha" }) }
          : undefined,
    ]);

    await memoriesApi.getByKey("/projects/alpha", "work");

    const req = api.lastFor("/api/memories/key/projects%2Falpha");
    expect(req).toBeDefined();
    expect(req?.url).toBe("/api/memories/key/projects%2Falpha?namespace=work");
  });

  it("creates, updates and deletes with the right verb and namespace param", async () => {
    const api = installApiStub([
      (req) =>
        req.path === "/api/memories" && req.method === "POST"
          ? { status: 201, body: makeMemory({ key: "/new" }) }
          : undefined,
      (req) =>
        req.path.startsWith("/api/memories/") && req.method === "PUT"
          ? { body: makeMemory({ key: "/new" }) }
          : undefined,
      (req) =>
        req.path.startsWith("/api/memories/") && req.method === "DELETE"
          ? { status: 204 }
          : undefined,
    ]);

    await memoriesApi.create(
      { key: "/new", domain: "config", content: "hi" } as CreateMemoryRequest,
      "work",
    );
    const created = api.lastFor("/api/memories", "POST");
    expect(created?.params.get("namespace")).toBe("work");
    expect(created?.body).toEqual({
      key: "/new",
      domain: "config",
      content: "hi",
    });

    await memoriesApi.update(
      "id-1",
      { content: "updated" } as UpdateMemoryRequest,
      "work",
    );
    const updated = api.lastFor("/api/memories/id-1", "PUT");
    expect(updated?.params.get("namespace")).toBe("work");
    expect(updated?.body).toEqual({ content: "updated" });

    await memoriesApi.delete("id-1", "work");
    expect(api.lastFor("/api/memories/id-1", "DELETE")?.params.get("namespace")).toBe(
      "work",
    );
  });
});

describe("keysApi", () => {
  it("requests the key tree with prefix, depth, limit and namespace", async () => {
    const api = installApiStub([keysRoute(makeKeyTree())]);

    await keysApi.list({
      prefix: "/projects",
      depth: 2,
      limit: 10,
      namespace: "work",
    });

    const url = api.urlFor("/api/keys");
    expect(url).toBe(
      "/api/keys?prefix=%2Fprojects&depth=2&limit=10&namespace=work",
    );
  });

  it("requests the flat key list with limit/offset pagination", async () => {
    const api = installApiStub([
      (req) =>
        req.path === "/api/keys/flat" && req.method === "GET"
          ? {
              body: {
                keys: ["/a"],
                total: 1,
                hasMore: false,
                nextOffset: null,
                prefixes: ["/"],
              },
            }
          : undefined,
    ]);

    await keysApi.listFlat({
      prefix: "/projects",
      limit: 25,
      offset: 50,
      namespace: "work",
    });

    const url = api.urlFor("/api/keys/flat");
    expect(url).toBe(
      "/api/keys/flat?prefix=%2Fprojects&limit=25&offset=50&namespace=work",
    );
  });
});

describe("namespacesApi", () => {
  it("lists namespaces", async () => {
    const api = installApiStub([namespacesRoute(["default", "work"])]);

    const result = await namespacesApi.list();

    expect(api.urlFor("/api/namespaces")).toBe("/api/namespaces");
    expect(result.namespaces.map((ns) => ns.name)).toEqual(["default", "work"]);
  });

  it("switches namespace with POST /api/namespaces/switch", async () => {
    const api = installApiStub([switchNamespaceRoute()]);

    const result = await namespacesApi.switch("work");

    const req = api.lastFor("/api/namespaces/switch", "POST");
    expect(req?.body).toEqual({ name: "work" });
    expect(result).toEqual({ success: true, namespace: "work" });
  });

  it("creates a namespace with POST /api/namespaces", async () => {
    const api = installApiStub([createNamespaceRoute()]);

    await namespacesApi.create("research", true);

    const req = api.lastFor("/api/namespaces", "POST");
    expect(req?.body).toEqual({ name: "research", setDefault: true });
  });
});
