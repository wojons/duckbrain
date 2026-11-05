/**
 * DuckBrain table client — the app's ONLY persistence path.
 *
 * Every function here is a thin, explicit wrapper over the generic table→REST
 * layer (DB-SUPA-3):
 *
 *   GET    /api/ns/:ns/tables                     list declared tables
 *   GET    /api/ns/:ns/tables/:table?col=eq.val   select (filters/order/limit)
 *   POST   /api/ns/:ns/tables/:table              insert (object or array)
 *   PATCH  /api/ns/:ns/tables/:table?pk=eq.val    update by primary key
 *   DELETE /api/ns/:ns/tables/:table?pk=eq.val    delete by primary key
 *   GET    /api/ns/:ns/changes                    SSE change feed
 *
 * There is no local storage, no cache and no fallback: if the daemon is not
 * answering, the app has no data. That is the point of the example.
 *
 * The module is plain ESM with no imports so the SAME file is loaded by the
 * browser (public/app.mjs) and by the Node transcript script (verify.mjs).
 */

export class DuckBrainError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = "DuckBrainError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** PostgREST-style filter value: `eq.x` by default, or an explicit operator. */
function filterToQuery(key, value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && value.op) {
    return `${key}=${value.op}.${value.value}`;
  }
  return `${key}=eq.${value}`;
}

export class TableClient {
  /**
   * @param {{baseUrl: string, apiKey: string, namespace: string}} config
   */
  constructor({ baseUrl, apiKey, namespace }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.namespace = namespace;
  }

  /** A clone bound to a different credential (the demo's reader token). */
  withKey(apiKey) {
    return new TableClient({
      baseUrl: this.baseUrl,
      apiKey,
      namespace: this.namespace,
    });
  }

  nsUrl(suffix = "") {
    return `${this.baseUrl}/api/ns/${encodeURIComponent(this.namespace)}${suffix}`;
  }

  async request(method, path, { query, body, signal, apiKey } = {}) {
    const url = new URL(this.nsUrl(path));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        for (const entry of value) url.searchParams.append(key, String(entry));
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    const headers = { Accept: "application/json" };
    const key = apiKey ?? this.apiKey;
    if (key) headers["X-API-Key"] = key;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });

    const text = await response.text();
    const payload = text === "" ? null : safeJson(text);
    if (!response.ok) {
      throw new DuckBrainError(
        payload?.error ?? `${method} ${url.pathname} failed (${response.status})`,
        {
          status: response.status,
          code: payload?.code,
          body: payload,
        },
      );
    }
    return {
      status: response.status,
      data: payload,
      durability: response.headers.get("x-durability"),
      totalCount: response.headers.get("x-total-count"),
    };
  }

  async health() {
    const response = await fetch(`${this.baseUrl}/health`, {
      headers: { Accept: "application/json" },
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  async listTables() {
    const reply = await this.request("GET", "/tables");
    return reply.data?.tables ?? [];
  }

  /** SELECT with `col=eq.value` filters, ordering and pagination. */
  async select(table, { filters = {}, order, limit, offset, count } = {}) {
    const query = {};
    for (const [key, value] of Object.entries(filters)) {
      const encoded = filterToQuery(key, value);
      if (encoded === null) continue;
      const [param, paramValue] = encoded.split(/=(.*)/s);
      query[param] = paramValue;
    }
    if (order) query.order = order;
    if (limit !== undefined) query.limit = limit;
    if (offset !== undefined) query.offset = offset;
    if (count) query.count = "exact";

    const reply = await this.request("GET", `/tables/${encodeURIComponent(table)}`, {
      query,
    });
    return reply.data ?? [];
  }

  async insert(table, rows) {
    const reply = await this.request(
      "POST",
      `/tables/${encodeURIComponent(table)}`,
      { body: Array.isArray(rows) ? rows : [rows] },
    );
    return reply;
  }

  async update(table, pk, patch) {
    return this.request("PATCH", `/tables/${encodeURIComponent(table)}`, {
      query: { pk: `eq.${pk}` },
      body: patch,
    });
  }

  async remove(table, pk) {
    return this.request("DELETE", `/tables/${encodeURIComponent(table)}`, {
      query: { pk: `eq.${pk}` },
    });
  }

  /**
   * Live change feed.
   *
   * `fromNow` resolves the namespace's current head cursor first (the feed's
   * `duckbrain.ready.v1` frame carries it) and then re-subscribes FROM that
   * cursor, so the caller sees committed changes made after it connected —
   * not the namespace's whole history. Pass `cursor` to resume a known point.
   *
   * Delivery is at-least-once (see src/http/realtime/hub.ts); consumers
   * deduplicate by cursor and apply rows by declared key.
   */
  subscribe({ tables = [], cursor = null, fromNow = false, onEvent, onReady, onError, signal }) {
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener("abort", onOuterAbort, { once: true });
    const done = (async () => {
      try {
        let startCursor = cursor;
        if (fromNow && !startCursor) {
          startCursor = await this.#readHead(tables, controller.signal);
        }
        await this.#readStream({
          tables,
          cursor: startCursor,
          onEvent,
          onReady,
          onError,
          signal: controller.signal,
        });
      } finally {
        signal?.removeEventListener("abort", onOuterAbort);
      }
    })();
    return { abort: () => controller.abort(), done };
  }

  async #readHead(tables, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      for await (const frame of this.#frames({ tables, cursor: null, signal: controller.signal })) {
        if (frame.event === "duckbrain.ready.v1") {
          return frame.data?.head ?? null;
        }
      }
      return null;
    } finally {
      controller.abort();
      signal?.removeEventListener("abort", abort);
    }
  }

  async #readStream({ tables, cursor, onEvent, onReady, onError, signal }) {
    try {
      for await (const frame of this.#frames({ tables, cursor, signal })) {
        if (frame.event === "duckbrain.change.v1") onEvent?.(frame.data, frame.id);
        else if (frame.event === "duckbrain.ready.v1") onReady?.(frame.data);
        else if (frame.event === "duckbrain.overflow.v1") onError?.(new Error("change feed overflow"));
        else if (frame.event === "duckbrain.revoked.v1") onError?.(new Error("subscription revoked"));
      }
    } catch (error) {
      if (signal?.aborted) return;
      onError?.(error);
    }
  }

  async *#frames({ tables, cursor, signal }) {
    const url = new URL(this.nsUrl("/changes"));
    if (tables.length > 0) url.searchParams.set("tables", tables.join(","));
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url, {
      headers: {
        Accept: "text/event-stream",
        ...(this.apiKey ? { "X-API-Key": this.apiKey } : {}),
      },
      signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      const payload = safeJson(text);
      throw new DuckBrainError(
        payload?.error ?? `change feed refused (${response.status})`,
        { status: response.status, code: payload?.code, body: payload },
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
    }
  }
}

function parseFrame(raw) {
  let event = "message";
  let id = null;
  const dataLines = [];
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, id, data: safeJson(dataLines.join("\n")) };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A stable, readable id for demo rows (no crypto dependency in the browser). */
export function makeId(prefix) {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${random}`;
}
