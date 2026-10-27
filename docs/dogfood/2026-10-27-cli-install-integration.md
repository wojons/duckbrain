# DuckBrain dogfood integration — 2026-10-27

Tick: `duckbrain-dogfood-2026-10-27-20-29-19`
Target HEAD: `db695496bbfc68fd24e24940f095f951b64a2bea`

## Promise

DuckBrain claims that an agent or operator can run a local HTTP daemon and CLI, create an isolated namespace, store a memory, retrieve it by key, search it, and consolidate daily deltas while preserving namespace-local Git history.

## Real-use workflow

All product probes used an isolated HOME, config, namespaces root, and port 3137 under `/tmp/df-dkb-1027/own`; the production daemon and production auth store were not used for writes.

The HTTP workflow completed:

- `/health`: HTTP 200, `status=healthy`, embedding provider `none` reported healthy for keyword-only mode.
- `POST /api/namespaces` for `dogfood1027`: HTTP 200 with the created path.
- `POST /api/memories?namespace=dogfood1027`: HTTP 201.
- `GET /api/memories/key/dogfood/hello?namespace=dogfood1027`: HTTP 200 with exact content `DuckBrain real-use probe`.
- `GET /api/memories?namespace=dogfood1027&contains=DuckBrain`: HTTP 200, one result, highlighted match, score `0.12493873660829992`.
- Missing-key read: HTTP 404 with `NOT_FOUND`, not a silent empty result.

The CLI workflow also completed. `remember /dogfood/cli --namespace=dogfood1027 --domain=concept --content='CLI real-use probe' --wait` returned rc 0 and committed to Git; a subsequent exact `recall` returned the stored record.

`consolidate --date=2026-10-27` returned rc 0 in `0.36s`, scanning 2 namespaces and 10 delta rows (9 unique, 1 duplicate). The dry-run digest clearly identified the namespace counts and preview rows.

## Finding: space-form namespace flag

`status --namespace=dogfood1027` printed `Namespace: dogfood1027` and the configured scratch path. The equivalent space form, `status --namespace dogfood1027`, exited 0 but printed `Namespace: true` and fell back to `./memory/default`. This is silent wrong-state behavior, not a harmless formatting difference. It is filed as `DF-2026-9`.

The equals form is the current workaround. The acceptance criteria require the space form to consume its value and invalid/missing values to fail loudly.

## Performance

The meaningful CLI search operation was measured against the isolated one-memory namespace:

- Cold one-shot: `time -p ... node bin/duckbrain.js search DuckBrain --namespace=dogfood1027 --limit=10` — `real 0.81s`, rc 0.
- Warm: `hyperfine --warmup 2 --runs 10 ...` — mean `380.0 ms ± 33.1 ms`, range `341.5–445.6 ms`.

This is dominated by the Node process startup floor for a tiny corpus. It is not a user-noticeable performance finding, so no PERF row was filed. The product's prior large-corpus performance rows remain the relevant performance record.

## Fresh-machine install leg

The required bunker leg ran on `bunker-mvp`, agent `0908094c`, against the recorded target HEAD. The harness installed pnpm 12.4.2 dependencies from a clean store and recorded `fresh-install` as rc 0 in 6.3s. However, the evidence journal stopped at build/toolchain cells and explicitly said `build-only install ... no standalone artifact expected`; it did not record the README health → namespace → write → exact-read smoke. Therefore this is PARTIAL/UNPROVEN install evidence. This corroborates the same-tick install/collision evidence already recorded under `DF-2026-7`; no duplicate install row was retained.

A separate isolated smoke on the same product HEAD exercised the missing product-owned steps: namespace creation 201, memory write 201, exact read 200. The smoke also showed that a providerless daemon may answer `/health` with 503 degraded until its configured provider state is healthy; the README explicitly allows degraded health during setup. The bunker agent was destroyed with `bunker destroy --purge`; `bunker info 0908094c` returned `not_found`, and the post-destroy list contained only the unrelated `crier-lab` agent.

## Scope and residue

No product source, visibility, permissions, credentials, or scheduler state were changed. Scratch state and captured evidence remain under `/tmp/df-dkb-1027/`; the bunker agent and its key were removed. The only repository write-back is this report, the diagnostics/run-history/usage documentation, and the two board rows `DF-2026-9` and `DF-2026-10`.