# @duckbrain/sdk

A typed TypeScript client for the DuckBrain HTTP API, generated from the
server's own OpenAPI 3.1 document. In-repo artifact only — it is **not**
published to npm (SDK-PARITY-001 AC-5; `private: true`).

## Why it is generated

The document (`spec/duckbrain.openapi.json`) is produced by the server
(`generateOpenApi()` in `src/http/routes/tables.ts`), not maintained by hand.
`src/generated.ts` is a mechanical projection of that document: types, the
operation map and one method per `operationId`. A route that gains, renames or
reshapes an operation therefore cannot leave a stale client behind —
`pnpm sdk:check` and `src/sdk/drift.test.ts` fail until the client is
regenerated.

## One command

```bash
pnpm sdk:gen      # regenerate spec/ + src/generated.ts from the server
pnpm sdk:check    # fail (exit 1) if either artefact is stale
```

The document is generated for a fixed fixture namespace (`sdk_fixture`, see
`src/sdk/fixture.ts`), so it is reproducible on a machine with no data
directory and no running daemon. `NamespaceClient` rewrites that prefix onto
its `namespace` option, so one client serves every namespace.

## Use

```ts
import { DuckBrainApiError, NamespaceClient } from "../../packages/sdk/src/index.js";

const client = new NamespaceClient({
  baseUrl: "http://127.0.0.1:28811",
  namespace: "sdk_demo",
  apiKey: process.env.DUCKBRAIN_API_KEY, // sent as x-api-key
});

const { memories } = await client.listMemories({ query: { prefix: "/x/", limit: 5 } });
await client.insert_notes({ body: [{ id: "a", title: "first", score: 1.5 }] });
const rows = await client.list_notes({ query: { order: "score.desc", score: "gte.1" } });
```

Errors are the server's, verbatim — `DuckBrainApiError.reason` and
`.code` carry `VALIDATION_ERROR`, `table_grant`, `policy`, `INVALID_JSON`, so a
caller can branch on the reason instead of parsing a string:

```ts
try {
  await client.delete_notes({ query: { pk: "eq.a" } });
} catch (error) {
  if (error instanceof DuckBrainApiError && error.code === "FORBIDDEN") {
    console.log(error.reason); // e.g. "... (reason: table_grant)"
  }
}
```

The SSE feed is a client method, not a second HTTP implementation:

```ts
for await (const frame of client.streamEvents({ path: { namespace: "sdk_demo" } })) {
  console.log(frame); // { type: "connected", ... }, then activity frames
}
```

## Coverage

Every path in the document: memories (list/create/get by id/get by key/update/
delete), the declared-table registry (`list_tables`), declaration
(`declare_table`), table rows (select/insert/update/delete/upsert, plus the
`_transaction` envelope) with the documented filter/order/limit/count
vocabulary, and the namespace SSE feed.

## Runnable example

`examples/sdk-quickstart/index.ts` — declares a table, inserts and selects rows,
runs a memory create → read → update → delete cycle, reads the SSE feed and
prints a server refusal, all through the client:

```bash
DUCKBRAIN_NAMESPACES_PATH=/tmp/sdk-demo-ns \
  node bin/duckbrain.js http --port 28811 --auth=none &
npx tsx examples/sdk-quickstart/index.ts http://127.0.0.1:28811 sdk_demo
```
