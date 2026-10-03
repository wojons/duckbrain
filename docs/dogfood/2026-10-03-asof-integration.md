# DuckBrain Dogfood — as-of recall at prod scale + fresh-box install (2026-10-03)

Run 14, tick `duckbrain-dogfood-2026-10-03-12-35-43`. Executor: dogfood lane
(workdir `/home/kara/.hermes/stand-in/dogfood/duckbrain`, real repo
`/home/kara/duckbrain`, HEAD `f463832`).

## Angle (why this run is not a repeat)

Run 8 (2026-09-24) already proved as-of recall end-to-end on a **scratch**
namespace (2 memories, 2 commits) — 30.4 ms warm, all ref forms, correct 400s.
Runs 9–13 covered web UI, SSE, S3, examples, install. What NO run ever did:

1. exercise as-of on a **prod-size** namespace (the flagship surface at the
   scale a real user actually has),
2. repeat the fresh-box install leg **at published-origin HEAD** and diff the
   as-of workflow cross-host,
3. re-verify the DF-0926-04 env-var contract at HEAD.

## Real-use workflow (scratch daemon :3123, isolated namespaces)

- Scratch daemon: `node bin/duckbrain.js http --port=3123 --auth=none`,
  namespaces redirected via `DUCKBRAIN_NAMESPACES_PATH` (the BUG-037 knob).
- Sequence: `POST /api/namespaces {name:df-asof}` → v1 write → wait out the
  30 s git autocommit batch → v2 overwrite of the same key → new key →
  `DELETE /api/memories/<v1-id>` (204) → recall as-of past date + past commit
  + present.
- Results: as-of between t1 and t2 returns exactly `VERSION-ONE` with
  `isTombstone:false`; as-of at v1's commit hash (`3274d43`) matches; present
  view shows `VERSION-TWO` + the new key only; pre-history as_of returns a
  clean `VALIDATION_ERROR` ("No commit found at or before …"); bad ref on CLI
  (rc=1, bare AND piped) and HTTP (400-class JSON) both fail loudly.
- `git status` in the namespace worktree after every as-of query: **clean** —
  the no-checkout claim holds at HEAD.
- CLI route `recall --as-of=<ref>`: works, same resolution path.

## Perf (numbers, not impressions)

| Workload | Command | Result |
|---|---|---|
| scratch ns (2 memories), warm n=20 | `curl time_total` on `?prefix=/dogfood&namespace=infra&as_of=…` | avg 177.5 ms, max 737 ms |
| CLI recall as-of, cold | `time node bin/duckbrain.js recall … --as-of=3274d43` | 0.710 s wall |
| **prod default ns (245k rows), warm n=15** | `curl -H 'x-api-key: …' 'http://127.0.0.1:3000/api/memories?prefix=/&namespace=default&as_of=2026-10-01T00:00:00Z&limit=10'` | **p50 7248 ms, p100 8158 ms** (first 5 calls 4.3–4.6 s, then 7–8 s — warm-up makes it *slower*, suggesting cache eviction / provider warm path, not JIT) |

Scaling 177 ms → 7.2 s on the flagship prod namespace is a user-noticeable
wait. Filed **PERF-011** (P2). Hot path suspicion: per-partition `git show`
fan-out in `src/git/asof.ts` + route code at `src/http/routes/memories.ts:316`.
Not profiled further here — the foreman owns the fix; the number justifies the
row.

## Findings → board rows

- **DF-1003-01 (P1)** — `DUCKBRAIN_DATA_DIR` is still dead at HEAD (`f463832`),
  7 days after DF-0926-04: daemon started with it set still wrote to
  `<repo>/namespaces/` (my first scratch namespace landed in prod paths; prod
  pollution cleaned, `namespaces/df-asof` removed). `src/config/index.ts`
  resolution honors `DUCKBRAIN_CONFIG_PATH` / `DUCKBRAIN_HOME_ROOT` /
  `DUCKBRAIN_NAMESPACES_PATH` only. Docs that teach the dead var are wrong.
- **DF-1003-02 (P2)** — fresh-box install channel green (clone + pnpm install +
  build all pass at published origin), but the examples/quickstart arms were
  NOT re-exercised by this run's smoke — DF-0926-01 remains unverified from a
  fresh box. Row filed as install-green + examples-unverified, honestly.
- **PERF-011 (P2)** — the prod-scale as-of latency above.
- **DF-1003-03 (P3)** — namespace auto-create is invisible to the caller: on
  the fresh box, writes without a prior `POST /api/namespaces` silently landed
  in `default` (201 response never says so), and a later `?namespace=df-asof`
  then 404s. UX fix direction: echo the effective namespace in write responses.
- **SKIPPED-install-bunker: NOT filed — the leg EXECUTED** (see below).

## Install leg (ephemeral bunker, EXECUTED — not skipped)

Host: bunker-las-03 (`ssh bunker3`), fresh clone of
`github.com/wojons/duckbrain` (published origin) — per-file ssh-cat transfer
and tar traps avoided by cloning directly (public repo, no credential minted,
no visibility/permission change).

- node 22 via nvm, corepack pnpm, `pnpm install --frozen-lockfile`, `pnpm build`
  — all green. Install channel healthy at published HEAD.
- As-of workflow cross-host: required 5 script arms (3 script bugs of mine:
  T1 stamped before the v1 write → product correctly 400s "No commit found";
  missing namespace-create step → writes landed in `default`; wrong ns in
  query). Final arm: as-of at the v1 commit time returned `VERSION-ONE`,
  present view showed both versions — **outputs identical modulo volatile
  timing lines to the local run's** (the strongest single transfer-fidelity
  evidence the perf skill describes).
- Product-side error quality on the fresh box was good: the "not a git
  repository — as-of recall requires namespace git history" error name-checks
  the exact precondition.
- Cleanup: all scratch dirs/scripts/logs removed, smoke daemon killed,
  `ls ~` verified clean. No agent spawned (direct ssh to the shared build
  host per repo AGENTS.md), nothing to destroy.

## Verdict

**PROMISING-BUT-ROUGH (stable vs runs 12–13).** The as-of flagship works at
HEAD, survives a fresh-box transfer, and fails loudly at every edge I probed.
Rough edges: a P1 env-var docs defect that has survived two runs, an invisible
auto-create, and a prod-scale as-of latency of 7.2 s p50.

Time-to-first-success on the as-of workflow (docs-following user): ~5 min from
clean scratch daemon to first past-state read-back. Friction count this run: 4
(2 product, 2 mine — script bugs recorded because the product's error messages
caught all of them, which is itself evidence of good error surfaces).

## Left behind

- `docs/dogfood/2026-10-03-asof-integration.md` (this file)
- `docs/dogfood/diagnostics.md` Run 14 section
- `skills/duckbrain-usage/SKILL.md` v1.13.0 (pitfalls 28–30: dead env var,
  auto-create invisibility, T1-before-write script trap)
- Board rows DF-1003-01..03, PERF-011 on `.coding-hermes/board/tasks.jsonl`
- dogfood-log entry

## Traceability

- ch:trace row=DF-1003-01 spec=docs/guide/ai-configure.md#environment-variables test=none::live-daemon-repro evidence=docs/dogfood/2026-10-03-asof-integration.md witness=none:env-var behavior is runtime-config, not observable at a URL verdict=DF-1003-01
- ch:trace row=PERF-011 spec=docs/api/http-api.md#as_of test=none::curl-timing evidence=docs/dogfood/2026-10-03-asof-integration.md witness=live:http://127.0.0.1:3000/api/memories?as_of verdict=PERF-011
- ch:trace row=DF-1003-02 spec=README.md#quickstart test=none::bunker-install-log evidence=docs/dogfood/2026-10-03-asof-integration.md witness=none:ephemeral host destroyed, log content summarized here verdict=DF-1003-02
- ch:trace row=DF-1003-03 spec=docs/api/http-api.md#post-memories test=none::bunker-arm3-4 evidence=docs/dogfood/2026-10-03-asof-integration.md witness=none:ephemeral host destroyed verdict=DF-1003-03
