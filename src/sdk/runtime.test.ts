/**
 * SDK-PARITY-001: the generated types say what is callable; these tests pin
 * the transport behaviour a caller depends on — path/query encoding, the auth
 * header, the namespace rewrite, verbatim server refusals, and SSE parsing.
 * No daemon: `fetch` is injected, so this runs in the unit suite.
 */
import { describe, expect, it } from "vitest";
import {
  DuckBrainApiError,
  NamespaceClient,
} from "../../packages/sdk/src/index.js";

type Call = { url: string; init: RequestInit | undefined };

function stubClient(
  respond: (call: Call) => Response,
  options: { namespace?: string; apiKey?: string } = {},
): { client: NamespaceClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new NamespaceClient({
    baseUrl: "http://127.0.0.1:1/",
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.namespace ? { namespace: options.namespace } : {}),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(input), init };
      calls.push(call);
      return respond(call);
    }) as typeof globalThis.fetch,
  });
  return { client, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("SDK-PARITY-001 transport", () => {
  it("rewrites the fixture namespace onto the target namespace and keeps the filters", async () => {
    const { client, calls } = stubClient(() => json([]), { namespace: "demo" });
    await client.list_notes({
      query: { score: "gte.1", order: "score.desc", count: "exact", limit: 5 },
    });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/ns/demo/tables/notes");
    expect(url.searchParams.get("score")).toBe("gte.1");
    expect(url.searchParams.get("order")).toBe("score.desc");
    expect(url.searchParams.get("count")).toBe("exact");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("sends x-api-key and defaults the memory namespace to the client's", async () => {
    const { client, calls } = stubClient(() => json({ memories: [], total: 0 }), {
      namespace: "demo",
      apiKey: "scratch-key",
    });
    await client.listMemories({ query: { prefix: "/x/" } });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/memories");
    expect(url.searchParams.get("namespace")).toBe("demo");
    expect(url.searchParams.get("prefix")).toBe("/x/");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("scratch-key");
  });

  it("encodes a slash-separated memory key segment by segment", async () => {
    const { client, calls } = stubClient(() =>
      json({ id: "1", key: "/a/b c" }),
    );
    await client.getMemoryByKey({ path: { key: "a/b c" } });
    expect(new URL(calls[0].url).pathname).toBe("/api/memories/key/a/b%20c");
  });

  it("raises the server's refusal verbatim (code + reason + fields)", async () => {
    const { client } = stubClient(() =>
      json(
        {
          error: "Table grant missing for table 'notes' (reason: table_grant)",
          code: "FORBIDDEN",
          fields: { table: "notes" },
        },
        403,
      ),
    );
    await expect(client.list_notes()).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(DuckBrainApiError);
      const apiError = error as DuckBrainApiError;
      expect(apiError.status).toBe(403);
      expect(apiError.code).toBe("FORBIDDEN");
      expect(apiError.reason).toBe(
        "Table grant missing for table 'notes' (reason: table_grant)",
      );
      expect(apiError.fields).toEqual({ table: "notes" });
      expect(apiError.message).toContain("table_grant");
      return true;
    });
  });

  it("parses the SSE feed frame by frame", async () => {
    const frames = [
      { type: "connected", namespace: "demo" },
      { type: "memory", key: "/x/y" },
    ];
    const payload = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
    const { client } = stubClient(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(payload));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const received: Record<string, unknown>[] = [];
    for await (const frame of client.streamEvents({ path: { namespace: "demo" } })) {
      received.push(frame);
    }
    expect(received).toEqual(frames);
  });
});
