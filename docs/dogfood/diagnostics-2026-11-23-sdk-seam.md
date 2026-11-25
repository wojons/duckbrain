# Diagnostic trail

*This is the "not raw diagnostics, but explanation" record: how DuckBrain is built, why,
what errors were hit along the way (this lane's AND the project's own history), and the
right way to do things. Raw log dumps live in .coding-hermes/evidence/; lessons live here.*

## 2026-11-23 — the SDK seam is the product for a tarball consumer (tick duckbrain-dogfood-2026-11-23-22-14-19)

The 2026-11-17 run walked recall/prefix surfaces; since then the product grew a
declared-tables REST contract, an SDK quickstart example, and an SDK tarball spec
(35 product files). This fire walked the seam a NEW consumer actually meets.

How the SDK is built and why the fixture shape exists: the generated client is
generated from `generateOpenApi()` (src/http/routes/tables.ts) captured once for a fixed
fixture namespace (`sdk_fixture`, src/sdk/fixture.ts) so builds are reproducible on a
machine with no data. The client then rewrites the namespace prefix onto the target
(namespaces re-declare their own tables over HTTP); table names are NOT rewritten, so
row ops exist literally only for the fixture table names. Declares and mutations escape
the fixture via path-param/op-envelope design (`declare_table`, `run_table_transaction`),
select reads do not — that asymmetry is DOGFOOD-034.

Two rig lessons from this fire, in case the next fire meets them:

1. The HTTP `/tables/:table/declare` endpoint takes the BARE declaration body
   (columns/primary/format/etc); the CLI example's `{"tables": {…}}` wrapper is a
   different document. The endpoint's 400 `INVALID_DECLARATION` message states exactly
   which fields it expects (columns, primary, format, policy, legacy, force), which
   turned a wrong-shaped request into a one-line fix with no source reading — the
   error-first UX is the right way and products should keep it.
2. A daemon relaunch without `DUCKBRAIN_NAMESPACES_PATH` silently boots on the DEFAULT
   (production) store — an env-var miss reads as "my table vanished after restart" and
   invites false durability findings. The launch log's namespace warm-up line names the
   root it warmed; quote that line before grading a restart, and never relaunch a
   scratch daemon without the env var set (this lane's daemon was killed; the only
   request it served was a GET of a namespace that does not exist there).

Step-2b numbers and the honest no-finding verdict are in
docs/dogfood/2026-11-23-sdk-tarball-and-tables-rest.md.

---
