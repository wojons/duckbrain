/**
 * Zero-network REST stub for UI tests.
 *
 * `installApiStub(routes)` replaces global `fetch` with a recording dispatcher.
 * Tests then assert on the *request URLs the UI builds* (pagination, filters,
 * namespace, temporal params) and never open a socket:
 *
 *   const api = installApiStub(standardRoutes({ memories: makeMemories(60) }));
 *   renderWithProviders(<MemoryTable namespace="work" />);
 *   await screen.findByText("/mem/000");
 *   expect(api.requestsFor("/api/memories")[0].params.get("limit")).toBe("50");
 *
 * Any request without a matching route throws, so a UI change that starts
 * calling a new endpoint fails the test instead of hitting the network.
 */

import { vi } from "vitest";
import type {
  KeyNode,
  MemoryResponse,
  NamespaceResponse,
} from "../../../../src/http/types/api";

export interface RecordedRequest {
  /** Path + query string exactly as requested (e.g. "/api/memories?limit=50") */
  url: string;
  /** Path only */
  path: string;
  /** Parsed query params — use these for assertions */
  params: URLSearchParams;
  method: string;
  /** Parsed JSON body when one was sent */
  body: unknown;
  /** Request headers as sent by the client (e.g. X-API-Key assertions) */
  headers: Headers;
}

export interface StubResult {
  status?: number;
  body?: unknown;
}

/** Return a result to answer the request, or undefined to try the next route. */
export type StubRoute = (req: RecordedRequest) => StubResult | undefined;

export interface ApiStub {
  requests: RecordedRequest[];
  routes: StubRoute[];
  /** All request URLs, in order */
  urls(): string[];
  requestsFor(path: string, method?: string): RecordedRequest[];
  /** Most recent request for a path (usually the one under assertion) */
  lastFor(path: string, method?: string): RecordedRequest | undefined;
  /** Most recent request URL for a path */
  urlFor(path: string, method?: string): string | undefined;
  /** Distinct namespace values seen for a path, in request order */
  namespacesFor(path: string, method?: string): (string | null)[];
}

function record(input: RequestInfo | URL, init?: RequestInit): RecordedRequest {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
  const parsed = new URL(raw, "http://duckbrain.test");
  let body: unknown;
  if (typeof init?.body === "string" && init.body.length > 0) {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }
  return {
    url: raw,
    path: parsed.pathname,
    params: parsed.searchParams,
    method: (init?.method ?? "GET").toUpperCase(),
    body,
    headers: new Headers(init?.headers),
  };
}

export function installApiStub(routes: StubRoute[] = []): ApiStub {
  const requests: RecordedRequest[] = [];

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = record(input, init);
      requests.push(req);
      for (const route of routes) {
        const result = route(req);
        if (!result) continue;
        const status = result.status ?? 200;
        if (status === 204) return new Response(null, { status });
        return new Response(JSON.stringify(result.body ?? null), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(
        `Unstubbed request in UI test: ${req.method} ${req.url} — add a route to installApiStub()`,
      );
    },
  );

  vi.stubGlobal("fetch", fetchMock);

  const api: ApiStub = {
    requests,
    routes,
    urls: () => requests.map((r) => r.url),
    requestsFor: (path, method) =>
      requests.filter(
        (r) => r.path === path && (method === undefined || r.method === method),
      ),
    lastFor: (path, method) => {
      const list = api.requestsFor(path, method);
      return list[list.length - 1];
    },
    urlFor: (path, method) => api.lastFor(path, method)?.url,
    namespacesFor: (path, method) =>
      api.requestsFor(path, method).map((r) => r.params.get("namespace")),
  };

  return api;
}

/* ------------------------------------------------------------------ *
 * Route factories — one per DuckBrain endpoint the UI reads
 * ------------------------------------------------------------------ */

/** GET /api/memories — pagination-aware, so offset/limit assertions are real. */
export function memoriesRoute(state: { items: MemoryResponse[] }): StubRoute {
  return (req) => {
    if (req.path !== "/api/memories" || req.method !== "GET") return undefined;
    const limit = req.params.has("limit")
      ? Number(req.params.get("limit"))
      : 50;
    const offset = req.params.has("offset")
      ? Number(req.params.get("offset"))
      : 0;
    const page = state.items.slice(offset, offset + limit);
    const nextOffset =
      offset + limit < state.items.length ? offset + limit : null;
    return {
      body: {
        items: page,
        total: state.items.length,
        offset,
        limit,
        hasMore: nextOffset !== null,
        nextOffset,
      },
    };
  };
}

/** GET /api/keys — hierarchical tree. */
export function keysRoute(tree: KeyNode[] = []): StubRoute {
  return (req) => {
    if (req.path !== "/api/keys" || req.method !== "GET") return undefined;
    return { body: { tree, total: tree.length } };
  };
}

/** GET /api/namespaces */
export function namespacesRoute(
  names: string[],
  currentNamespace = "default",
): StubRoute {
  return (req) => {
    if (req.path !== "/api/namespaces" || req.method !== "GET")
      return undefined;
    return {
      body: {
        namespaces: names.map((name) => toNamespace(name, currentNamespace)),
        currentNamespace,
      },
    };
  };
}

/** POST /api/namespaces/switch — echoes the requested namespace back. */
export function switchNamespaceRoute(): StubRoute {
  return (req) => {
    if (req.path !== "/api/namespaces/switch" || req.method !== "POST") {
      return undefined;
    }
    const name =
      typeof req.body === "object" && req.body !== null
        ? String((req.body as { name?: unknown }).name ?? "")
        : "";
    return { body: { success: true, namespace: name } };
  };
}

/** POST /api/namespaces — create. */
export function createNamespaceRoute(): StubRoute {
  return (req) => {
    if (req.path !== "/api/namespaces" || req.method !== "POST")
      return undefined;
    const name =
      typeof req.body === "object" && req.body !== null
        ? String((req.body as { name?: unknown }).name ?? "")
        : "";
    return { status: 201, body: toNamespace(name, "default") };
  };
}

/**
 * The route bundle most UI tests need: memories + keys + namespaces.
 * Pass any subset of fixtures; anything omitted answers with an empty payload.
 */
export function standardRoutes(
  options: {
    memories?: MemoryResponse[];
    tree?: KeyNode[];
    namespaces?: string[];
    currentNamespace?: string;
  } = {},
): StubRoute[] {
  return [
    memoriesRoute({ items: options.memories ?? [] }),
    keysRoute(options.tree ?? []),
    namespacesRoute(
      options.namespaces ?? ["default"],
      options.currentNamespace,
    ),
    switchNamespaceRoute(),
    createNamespaceRoute(),
  ];
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function toNamespace(name: string, current: string): NamespaceResponse {
  return {
    name,
    path: `/namespaces/${name}`,
    isDefault: name === current,
    memoryCount: 0,
  };
}

export function makeMemory(
  overrides: Partial<MemoryResponse> & { key: string },
): MemoryResponse {
  const { key } = overrides;
  const base: MemoryResponse = {
    id: `id-${key.replace(/[^a-zA-Z0-9]+/g, "-")}`,
    key,
    domain: "config",
    content: `content for ${key}`,
    attributes: {},
    timestamp: "2026-09-12T00:00:00.000Z",
    author: "wojonstech@gmail.com",
    isTombstone: false,
    action: "add",
  };
  return { ...base, ...overrides };
}

/** N memories with predictable, assertable key paths: /mem/000, /mem/001, ... */
export function makeMemories(count: number, prefix = "/mem"): MemoryResponse[] {
  return Array.from({ length: count }, (_, index) =>
    makeMemory({ key: `${prefix}/${String(index).padStart(3, "0")}` }),
  );
}

export function makeKeyTree(): KeyNode[] {
  return [
    {
      id: "/projects",
      name: "projects",
      path: "/projects",
      type: "folder",
      memoryCount: 2,
      children: [
        {
          id: "/projects/alpha",
          name: "alpha",
          path: "/projects/alpha",
          type: "memory",
        },
        {
          id: "/projects/beta",
          name: "beta",
          path: "/projects/beta",
          type: "memory",
        },
      ],
    },
  ];
}
