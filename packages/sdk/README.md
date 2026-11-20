# @duckbrain/sdk

A typed TypeScript client for the DuckBrain HTTP API, generated from the
server's own OpenAPI 3.1 document.

The package is **built, not source-linked**: the build emits `dist/index.js`
plus `dist/index.d.ts`, and `main` / `types` / `exports` point at `dist`. Any
consumer — an in-repo example, a sibling project, a tarball install — imports
the compiled JavaScript with plain `node`; no TypeScript toolchain is needed on
their side (Node >= 22, ESM only; there is no CommonJS build).

## Distribution

**Decision: vendored tarball (`npm pack`), not a registry publish.** The
package stays `private: true`. The repo's publish credentials are owner-gated
(`NPM_TOKEN`), and this SDK's version tracks the exact server commit it was
generated from — shipping it from that same commit is what guarantees the
client describes the API the daemon actually serves. A registry publish is a
documented future path, not the current one.

Consumer install, exactly:

```bash
# 1. In a DuckBrain checkout — pack the built package.
#    `prepack` runs the build, so dist/ is always fresh in the tarball.
npm pack ./packages/sdk --pack-destination /tmp   # → /tmp/duckbrain-sdk-0.1.0.tgz

# 2. In the consuming project:
npm install /tmp/duckbrain-sdk-0.1.0.tgz
```

Then, in plain ESM JavaScript — no TypeScript, and no path into DuckBrain's
`src`:

```js
import { NamespaceClient } from "@duckbrain/sdk";
```

The tarball contains `dist/`, `spec/duckbrain.openapi.json` (the contract the
client was generated from) and this README. `files` in `package.json` is the
allowlist, so nothing else can ride along.

**Future path — npm publish under the `@duckbrain` scope.** Needs an owner
decision plus an `NPM_TOKEN`; then remove `"private": true`, add
`"publishConfig": { "access": "public" }`, run `npm publish` from
`packages/sdk`, and the consumer command becomes
`npm install @duckbrain/sdk@0.1.0`. Nothing else changes: the built layout is
already the publishable layout.

## Why it is generated

The document (`spec/duckbrain.openapi.json`) is produced by the server
(`generateOpenApi()` in `src/http/routes/tables.ts`), not maintained by hand.
`src/generated.ts` is a mechanical projection of that document: types, the
operation map and one method per `operationId`. A route that gains, renames or
reshapes an operation therefore cannot leave a stale client behind —
`pnpm sdk:check` and `src/sdk/drift.test.ts` fail until the client is
regenerated.

## Commands

```bash
pnpm sdk:gen      # regenerate spec/ + src/generated.ts from the server
pnpm sdk:check    # fail (exit 1) if either artefact is stale
pnpm sdk:build    # compile src/ → dist/index.js + dist/index.d.ts
```

`pnpm build` (the repo build) runs `sdk:build` before the UI build, and CI
builds the SDK and asserts both `dist/index.js` and `dist/index.d.ts` exist — so
a manifest that drifts back to TypeScript source, or a change that breaks the
emit, fails the pipeline rather than a consumer's install.

The document is generated for a fixed fixture namespace (`sdk_fixture`, see
`src/sdk/fixture.ts`), so it is reproducible on a machine with no data
directory and no running daemon. `NamespaceClient` rewrites that prefix onto
its `namespace` option, so one client serves every namespace.

## Use

```ts
import { DuckBrainApiError, NamespaceClient } from "@duckbrain/sdk";

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
prints a server refusal, all through the installed package (it imports
`@duckbrain/sdk` by name, resolved from its own `package.json`, with no path
into `packages/sdk/src`):

```bash
# build + install the package into the example, once
npm run sdk:build
npm install --prefix examples/sdk-quickstart

# scratch daemon (never :3000), then the example
DUCKBRAIN_NAMESPACES_PATH=/tmp/sdk-demo-ns \
  node bin/duckbrain.js http --port 28811 --auth=none &
npx tsx examples/sdk-quickstart/index.ts http://127.0.0.1:28811 sdk_demo
```
