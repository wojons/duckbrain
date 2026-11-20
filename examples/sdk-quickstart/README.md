# sdk-quickstart — consume `@duckbrain/sdk` by name

Runs one flow end to end against a scratch DuckBrain daemon, using only the
installed SDK (no `fetch`, no URL building, no hand-rolled auth headers):

1. `declare_table` → `insert_notes` → `list_notes` (ordered + filtered) → `upsert_notes`
2. memory `create` → `get by key` → `list` → `update` → `delete`
3. the namespace SSE feed (`streamEvents`)
4. one deliberate server refusal, surfaced as `DuckBrainApiError` with the
   server's own `code` / `reason`

`index.ts` imports **`@duckbrain/sdk` by name**. The name resolves through this
directory's `package.json`, which depends on the local package
(`file:../../packages/sdk`) — the same shape a real consumer gets from the
tarball (see `packages/sdk/README.md` → Distribution).

## Run it

```bash
# from the repo root
npm run sdk:build                       # packages/sdk/dist/index.js + index.d.ts
npm install --prefix examples/sdk-quickstart

# scratch daemon: temp data dir, never port 3000
DUCKBRAIN_NAMESPACES_PATH=/tmp/sdk-demo-ns \
  node bin/duckbrain.js http --port 28811 --auth=none &

# the example (Node >= 22 runs the .ts directly via type stripping)
node examples/sdk-quickstart/index.ts http://127.0.0.1:28811 sdk_demo
```

Stop the daemon when done (it holds the scratch data dir under
`/tmp/sdk-demo-ns`).
