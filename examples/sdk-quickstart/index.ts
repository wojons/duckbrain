/**
 * SDK-PARITY-001 AC-3: one runnable example that talks to DuckBrain ONLY
 * through the generated client — no fetch, no raw URL building, no hand-rolled
 * auth headers, no hand-parsed errors.
 *
 * Run it against a scratch daemon (never :3000):
 *
 *   DUCKBRAIN_NAMESPACES_PATH=/tmp/sdk-demo-ns \
 *     node bin/duckbrain.js http --port 28811 --auth=none &
 *   npx tsx examples/sdk-quickstart/index.ts http://127.0.0.1:28811 sdk_demo
 */
import {
  DuckBrainApiError,
  NamespaceClient,
} from "../../packages/sdk/src/index.js";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:28811";
const namespace = process.argv[3] ?? "sdk_demo";
const client = new NamespaceClient({ baseUrl, namespace });

async function main(): Promise<void> {
  console.log(`client → ${baseUrl} namespace=${namespace}`);

  // 1. Declare a table (schema is the caller's; the SDK only carries it).
  const declared = await client.declare_table({
    path: { table: "notes" },
    body: {
      columns: [
        { name: "id", type: "varchar" },
        { name: "title", type: "varchar" },
        { name: "score", type: "double" },
      ],
      primary: "id",
      force: true,
    },
  });
  console.log("declare_table →", declared);
  const tables = await client.list_tables();
  console.log("list_tables →", tables.tables.map((table) => table.name));

  // 2. Insert two rows, then read them back through the filter vocabulary.
  const inserted = await client.insert_notes({
    body: [
      { id: "a", title: "first", score: 1.5 },
      { id: "b", title: "second", score: 2.5 },
    ],
  });
  console.log("insert_notes →", inserted);
  const rows = await client.list_notes({
    query: { order: "score.desc", limit: 10, score: "gte.1" },
  });
  console.log("list_notes (order=score.desc, score=gte.1) →", rows);

  // 3. Upsert one row by primary key, then read the total count header.
  const upserted = await client.upsert_notes({
    path: { pk: "a" },
    body: { id: "a", title: "first (upserted)", score: 3.5 },
  });
  console.log("upsert_notes →", upserted);
  // count=exact asks the server for the row total; the SDK exposes the header
  // of the last response, so `X-Total-Count` needs no second implementation.
  await client.list_notes({ query: { count: "exact", limit: 1 } });
  console.log(
    "X-Total-Count (count=exact) →",
    client.lastMeta?.headers.get("x-total-count"),
  );

  // 4. Memories: create → get by key → list → update → delete.
  const created = await client.createMemory({
    body: {
      key: "/sdk/quickstart/hello",
      domain: "concept",
      content: "written through the generated client",
      attributes: { source: "examples/sdk-quickstart" },
    },
  });
  console.log("createMemory →", { id: created.id, key: created.key });
  const byKey = await client.getMemoryByKey({
    path: { key: "sdk/quickstart/hello" },
  });
  console.log("getMemoryByKey →", byKey.content);
  const listed = await client.listMemories({
    query: { prefix: "/sdk/quickstart/", limit: 5 },
  });
  console.log("listMemories →", { total: listed.total, keys: listed.memories.map((m) => m.key) });
  const updated = await client.updateMemory({
    path: { id: created.id },
    body: { content: "updated through the generated client" },
  });
  console.log("updateMemory →", { id: updated.id, content: updated.content });
  const deleted = await client.deleteMemory({ path: { id: updated.id } });
  console.log("deleteMemory →", deleted === undefined ? "204 no content" : deleted);

  // 5. The SSE feed, read through the client (first frame closes the demo).
  const feed = client.streamEvents({ path: { namespace } });
  try {
    const first = await feed.next();
    console.log("streamEvents →", first.value);
  } finally {
    await feed.return(undefined);
  }

  // 6. Errors: the SDK raises the SERVER's reason verbatim, not a generic 400.
  try {
    await client.list_notes({ query: { missing_column: "eq.1" } });
  } catch (error) {
    if (!(error instanceof DuckBrainApiError)) throw error;
    console.log("DuckBrainApiError →", {
      status: error.status,
      code: error.code,
      reason: error.reason,
      message: error.message,
    });
  }
}

main().catch((error: unknown) => {
  console.error("example failed:", error);
  process.exitCode = 1;
});
