# Dogfood 2026-11-23 — SDK tarball consumer + real tables-REST workflow

Tick `duckbrain-dogfood-2026-11-23-22-14-19` (delivery 1). Scope: the surfaces
that changed since the 2026-11-17 walk (35 product files), driven as a real
user: the shipped SDK tarball, the declared-tables REST contract beyond the
quickstart's shapes, daemon-restart durability, and Step-2b timings.

## The real user journey (what worked)

Install and run the documented quickstart verbatim, then go past it:

1. `npm run sdk:build` (0.48 s, incremental) → `npm install --prefix
   examples/sdk-quickstart` (2.06 s) → scratch daemon via
   `ops/lane-scratch.sh` allocation (port 20000, namespaces in a per-run
   `/tmp` root) → `node examples/sdk-quickstart/index.ts …` — **end-to-end
   1.62 s, rc=0**. Declares, inserts, ordered+filtered list, upsert,
   `X-Total-Count`, memory create/get/list/update/delete, SSE
   `streamEvents` connect, and a deliberate 400 surfaced as
   `DuckBrainApiError` with the server's own `code`/`reason`. Nothing to fix,
   nothing to read source for. Time-to-first-success ≈ 15 s from a warm
   checkout.

2. The **tarball** claim (quickstart resolves `file:` locally; real consumers
   get the tarball). `npm pack packages/sdk` →
   `duckbrain-sdk-0.1.0.tgz` → fresh consumer tree, `npm install` (0.30 s),
   `import { DuckBrainApiError, NamespaceClient } from '@duckbrain/sdk'`:
   createMemory/listMemories/declare_table/list_tables/run_table_transaction
   all verified against the scratch daemon, and a wrong-namespace table call
   surfaced as typed `DuckBrainApiError` 404. Tarball parity is real.

3. The tables-REST contract, driven past the quickstart via HTTP (scratch
   namespace `tables_df_20261123`): declare (201) with mixed column types,
   single JSON insert and NDJSON batch (201), duplicate PK single and
   in-batch (409 `DUPLICATE_KEY` with `fields.pk`; the colliding batch is
   all-or-nothing — the batch's unique row was verified NOT written), PATCH
   by pk (200), PATCH unknown column (400), DELETE without pk (400), DELETE
   by pk (200), filter+order+limit with `Prefer: count=exact` →
   `X-Total-Count: 2` correct, CSV accept with proper quoting, unknown table
   404, generated OpenAPI 3.1 (9 paths, one per declared table + the
   `_transaction` + declare + `{pk}` sub-resources). Every arm matched
   `docs/api/http-api.md` verbatim, including the error messages.

4. **Durability**: killed the daemon, restarted on the same namespace dir —
   the table read back with every mutation intact (qty=99, patched meta,
   non-scalar `meta.tags`/`meta.nested`), and the namespace's git repo had
   auto-committed (`chore: auto-commit namespace data` ×2). The JSONL on
   disk matched the API byte-for-row.

5. **Data-survival trap** (the flattened-type write path): a row whose
   `meta` holds a list + nested object survived an unrelated PATCH of
   `qty` (read back `{"tags":["x","y"],"nested":{"a":1}}` byte-identical).
   The DB-HTTP-001 class of bug did NOT reproduce on this surface.

## What did not work / friction (rows filed)

- **DOGFOOD-034 (P3)** — the tarball SDK can declare and mutate any table
  (generic path-param declare; `run_table_transaction` with a `table` per
  action) but **cannot read rows of a non-fixture table**: row-select ops
  exist only for the fixture tables (`list_notes`, `list_lane_scores`), and
  `DuckBrainClientBase.call` is `protected`
  (`packages/sdk/dist/runtime.d.ts:62`). A tarball consumer must hand-roll
  fetch — the exact thing the SDK exists to prevent.
- **DOGFOOD-035 (P3)** — `createMemory`'s required-field contract
  (`key`, `domain`, `content`) is learnable only from the quickstart example
  body or a live 400; `packages/sdk/README.md`'s Coverage section never
  states it. The typed error names the missing fields precisely, so this is
  polish, not a blocker.
- Two rig notes (ours, not the product's): the HTTP declare endpoint takes
  the BARE declaration body (columns/primary/format), not the CLI's
  `{"tables": …}` wrapper — the 400 error message states exactly what is
  expected, which is good UX. And `npm pack packages/sdk` from the repo root
  fails with a bogus git ls-remote (`ssh://git@github.com/packages/sdk.git`);
  run `npm pack` from inside `packages/sdk`, which works.

## Step 2b — measurements

Scratch daemon on an idle lane host (`--auth=none`, per-run namespaces dir):

| Operation | Cold | Warm (5 runs) |
|---|---|---|
| memory create (first call after boot) | 31 ms | 1.9–4.0 ms |
| memory list (`limit=10`) | — | 5.3–15.7 ms (converging ~6.5) |
| tables row read (3 rows) | — | 45–59 ms |

Daemon cold boot → `/health` 200 within ~7–8 s of `node bin/duckbrain.js`
launch; first call after boot needs no warm-up that a user would feel
(the AUG-096-era 3.5 s cold semantic query was measured on the embedded
runtime, not this HTTP path, and did not reproduce here).

**Verdict: no perf row.** Nothing here is slow enough that a user would
notice; the fixtures are small, and the worst number (59 ms) is an order of
magnitude below anything felt.

## Install leg

Launched per the transient-bunker procedure: `bunker-qa.sh launch
/home/kara/duckbrain --server bunker-mvp --keep` → agent `8f7ea54e`,
evidence `/tmp/bunker-qa-evidence-20261123T224157Z-507728.jsonl`
(SHA256 d4c04a5e…). Result graded in `.coding-hermes/dogfood-log.md` at
collect time.

## Unverified this fire

- `search` at production scale stays unmeasured (the honest arm is a query
  against the live production namespaces; DOGFOOD-010 records the crash
  class for that mode).
- Auth/token/role surfaces stay owned by SEC-AUTHZ-001 (pending, P1); the
  scratch daemons ran `--auth=none`, which is the correct scoping, not a
  pass on auth.
- The battery cell's fresh-install verdict binds to the tree synced at
  launch time (HEAD 6b3d6d1f at launch), not to any later tip.
