/**
 * SDK-PARITY-001: the hand-written half of the client.
 *
 * `generated.ts` says WHAT the operations are (typed from the OpenAPI
 * document); this file says HOW a call travels — URL building, the
 * PostgREST-style query vocabulary, auth header, body encoding, SSE — and it
 * exists exactly once, so the generated file stays a mechanical projection of
 * the document instead of a second implementation with its own bugs.
 */
import { DuckBrainApiError } from "./errors.js";
import { parseEventStream } from "./events.js";

export type Method = "get" | "post" | "put" | "patch" | "delete";

/** Shape every generated operation entry has. */
export interface OpShape {
  method: string;
  path: string;
  args?: unknown;
  response: unknown;
}

export interface ClientOptions {
  /** e.g. http://127.0.0.1:28800 — no trailing slash required. */
  baseUrl: string;
  /** Sent as `x-api-key` (DuckBrain's header; Bearer is NOT accepted). */
  apiKey?: string;
  /**
   * Namespace this client talks to.
   *
   * The generated document was captured for ONE namespace, so its table paths
   * embed that name. Setting `namespace` rewrites that prefix onto the target
   * namespace, and (for the global memory routes, which take a query
   * parameter) supplies `?namespace=` when the call does not set one.
   */
  namespace?: string;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Replaceable for tests/proxies. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Called with the status/headers of every successful response. */
  onResponse?: (info: {
    operationId: string;
    status: number;
    headers: Headers;
  }) => void;
}

export interface CallArgs {
  path?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
}

type OpsMap<Specs extends Record<string, OpShape>> = {
  [K in keyof Specs]: { method: string; path: string };
};

export abstract class DuckBrainClientBase<
  Specs extends Record<string, OpShape>,
> {
  protected abstract readonly ops: OpsMap<Specs>;

  protected readonly baseUrl: string;
  protected readonly apiKey?: string;
  protected readonly namespace?: string;
  protected readonly documentNamespace?: string;
  protected readonly extraHeaders: Record<string, string>;
  protected readonly fetchImpl: typeof globalThis.fetch;
  protected readonly onResponse?: ClientOptions["onResponse"];
  /** Status + headers of the most recent response (X-Durability, X-Total-Count). */
  lastMeta?: { operationId: string; status: number; headers: Headers };

  constructor(options: ClientOptions, documentNamespace?: string) {
    if (!options.baseUrl) throw new Error("baseUrl is required");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.namespace = options.namespace;
    this.documentNamespace = documentNamespace;
    this.extraHeaders = options.headers ?? {};
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.onResponse = options.onResponse;
  }

  /** One request, typed by the generated Specs map. */
  protected async call<K extends keyof Specs & string>(
    id: K,
    args?: Specs[K]["args"],
  ): Promise<Specs[K]["response"]> {
    const response = await this.send(id, args);
    const parsed = await this.parse(id, response);
    return parsed as Specs[K]["response"];
  }

  /** One SSE request, yielding every frame as the server sent it. */
  protected async *stream<K extends keyof Specs & string>(
    id: K,
    args?: Specs[K]["args"],
  ): AsyncGenerator<Record<string, unknown>> {
    const response = await this.send(id, args, { accept: "text/event-stream" });
    if (!response.ok) await this.raise(id, response);
    if (!response.body) {
      throw new Error(`${String(id)}: the server answered without a body stream`);
    }
    yield* parseEventStream(response.body);
  }

  private async send<K extends keyof Specs & string>(
    id: K,
    args: unknown,
    options: { accept?: string } = {},
  ): Promise<Response> {
    const definition = this.ops[id];
    if (!definition) {
      throw new Error(`Unknown operation '${String(id)}'`);
    }
    const call = (args ?? {}) as CallArgs;
    const url = this.buildUrl(String(id), definition.path, call);
    const headers: Record<string, string> = {
      accept: options.accept ?? "application/json",
     ...this.extraHeaders,
    };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;

    let body: string | undefined;
    if (call.body !== undefined) {
      if (typeof call.body === "string") {
        body = call.body;
        headers["content-type"] = "application/x-ndjson";
      } else {
        body = JSON.stringify(call.body);
        headers["content-type"] = "application/json";
      }
    }

    const response = await this.fetchImpl(url, {
      method: definition.method.toUpperCase(),
      headers,
      ...(body === undefined ? {} : { body }),
    });
    this.lastMeta = { operationId: String(id), status: response.status, headers: response.headers };
    this.onResponse?.({ operationId: String(id), status: response.status, headers: response.headers });
    return response;
  }

  private buildUrl(id: string, template: string, call: CallArgs): string {
    let path = template;
    if (this.namespace && this.documentNamespace) {
      path = path.replace(
        `/api/ns/${this.documentNamespace}/`,
        `/api/ns/${encodeURIComponent(this.namespace)}/`,
      );
    }
    for (const [name, value] of Object.entries(call.path ?? {})) {
      if (value === undefined || value === null) continue;
      path = path.split(`{${name}}`).join(encodePathValue(String(value)));
    }
    const unresolved = /\{([^}]+)\}/.exec(path);
    if (unresolved) {
      throw new Error(
        `${id}: missing path parameter '${unresolved[1]}' (template ${template})`,
      );
    }
    const url = new URL(this.baseUrl + path);
    const query: Record<string, unknown> = { ...(call.query ?? {}) };
    // Memory routes take the namespace as a query parameter; the ns-scoped
    // table paths already carry it in the path.
    if (this.namespace && !path.includes("/api/ns/") && query.namespace === undefined) {
      query.namespace = this.namespace;
    }
    for (const [name, value] of Object.entries(query)) {
      appendQuery(url.searchParams, name, value);
    }
    return url.toString();
  }

  private async parse(id: string, response: Response): Promise<unknown> {
    if (!response.ok) return this.raise(id, response);
    const contentType = response.headers.get("content-type") ?? "";
    if (response.status === 204) return undefined;
    if (contentType.includes("application/json")) {
      const text = await response.text();
      return text.length === 0 ? undefined : JSON.parse(text);
    }
    if (contentType.includes("text/csv")) return response.text();
    const text = await response.text();
    return text.length === 0 ? undefined : text;
  }

  private async raise(id: string, response: Response): Promise<never> {
    const raw = await response.text().catch(() => "");
    let body: unknown = raw;
    if (raw.length > 0 && (response.headers.get("content-type") ?? "").includes("json")) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const record =
      body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
    throw new DuckBrainApiError({
      operationId: id,
      method: (this.ops[id as keyof Specs]?.method ?? "get").toString(),
      url: response.url,
      status: response.status,
      // The server's strings, verbatim — never re-worded here.
      reason:
        typeof record?.error === "string"
          ? record.error
          : typeof body === "string" && body.length > 0
            ? body
            : response.statusText,
      ...(typeof record?.code === "string" ? { code: record.code } : {}),
      ...(record?.fields && typeof record.fields === "object"
        ? { fields: record.fields as Record<string, string> }
        : {}),
      body,
    });
  }
}

/** Path values may be slash-separated keys (memory keys): encode segments. */
function encodePathValue(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function appendQuery(
  params: URLSearchParams,
  name: string,
  value: unknown,
): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const entry of value) appendQuery(params, name, entry);
    return;
  }
  if (value instanceof Date) {
    params.append(name, value.toISOString());
    return;
  }
  if (typeof value === "object") {
    params.append(name, JSON.stringify(value));
    return;
  }
  params.append(name, String(value));
}
