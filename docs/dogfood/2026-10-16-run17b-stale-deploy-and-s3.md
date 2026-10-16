# Run 17b — stale deploy A/B + S3 CLI end-to-end + second install leg (2026-10-16, tick duckbrain-dogfood-2026-10-16-12-40-48)

Second sibling run of the same tick (run 17 = a854f01c/5f9475e0: re-proofs + CLI sweep +
first install leg). This continuation covers the surfaces run 17 did not touch. Workdir
rig: scratch HEAD daemon on :3907 built from HEAD a9350b94 (`pnpm build:cli`, 1.1s), data
root isolated via DUCKBRAIN_CONFIG_PATH=/tmp/df17-rerun/df17.config.json with a 145MB copy
of the prod default namespace (3477 rows). Embedding stack identical to prod (OpenRouter
qwen3-embedding-8b, 4096 dims).

## Finding 1 (P1): the prod service is a stale deploy — merged fixes are not what the fleet runs

The fleet's memory backend (systemd --user duckbrain-http.service on :3000) booted
2026-10-10 16:45 and serves the prebuilt `dist/` tree whose newest code is Oct 6/7. The
DF-1013 fix family merged 10-14/15 (c2b75c89 anonymous author, 83b3e0f2 warmup grading,
c95dd5e0 ?debug=search, 2038d9fb single-flight rebuilds, cf59f630 S3 sha256 sync) exists
only in src + HEAD dist builds — not in the running binary.

A/B evidence (same corpus copy, same embedding env):

| probe | prod :3000 (Oct-6 dist) | scratch :3907 (HEAD dist) |
|---|---|---|
| `GET /api/memories?debug=search` (no q) | 400 `Unknown query parameter(s): 'debug'` | 400 `?debug=search requires ?q=` (exact documented contract) |
| `?q=scheduler&debug=search` | 400 (strict validator, no debug surface) | 200 + full `searchDebug` object |
| `?q=scheduler` warm | 1.8–2.0s | 1.6–2.5s |
| 8xx-namespace `contains&allNamespaces=true` | **47.9s** (813 ns) | n/a (3 ns: 0.20s) |

`grep debug dist/src/http/routes/memories.js` → 0 hits; every DF-1013-affected src file is
newer than its dist counterpart; the running argv still carries `--bind-all`, which the
current unit file dropped — the process predates even the current unit definition.

Filed as **DF-2026-3** with the exact verify ladder (build → restart → check process
start time vs dist mtime → `/health` embedding.provider=openai → `?debug=search` returns
searchDebug). Until the restart lands, every consumer of :3000 (scheduler sync lanes,
MCP-over-HTTP agents) runs pre-fix code.

## Finding 2 (P2): `duckbrain s3` resolves its root from CWD, not from the config path

`bin/duckbrain.js s3 status <ns>` with `DUCKBRAIN_CONFIG_PATH` pointing at a scratch root
reports `local=0` / `Namespace not found` when run from the repo cwd, and works when run
with the scratch root as cwd — while a direct probe of the same env walks the files.
Mechanism: `s3Command(args, configDir = ".")` and its private
`namespacesPath(configDir) = path.resolve(configDir, cfg.namespacesPath)` (src/s3/cli.ts)
— cwd-anchored, unlike every other verb, which resolves through
`DUCKBRAIN_CONFIG_PATH`/`DUCKBRAIN_HOME_ROOT` (src/config/index.ts `resolveDuckbrainRoot`,
built exactly to stop cwd-derived stray trees, per its own doc comment).

Live consequence during the run: with leaked `DUCKBRAIN_*` session vars present, the S3
CLI silently walked a stale /tmp tree (walk=0, no error), and cross-instance invocations
collided on `.s3state/.lock` (`another sync is in progress`) from a *different* root's
lock. Filed as **DF-2026-4** (fix: route through resolveDuckbrainRoot + print the
resolved root). Workaround until fixed: run `s3` verbs with the config's directory as
cwd (the file must be named `duckbrain.config.json`).

## S3-GIT-008 — full battery through the product's own CLI (new surface)

Local minio scratch (throwaway keys, container removed after), namespace df17s3:

1. push: `uploaded=3` — objects landed under `df17/df17s3/...`
2. manifest `.s3state/df17s3.json` carries per-file `sha256` (content identity), verified
   against local bytes
3. re-push: `uploaded=0 skipped=3` — idempotent via content identity
4. same-length local corruption (8 bytes flipped at offset 8, sha256 changed) →
   `s3 pull`: `downloaded=1`, local sha256 == original (byte-exact repair)
5. push with minio stopped: loud `ECONNREFUSED`, nothing recorded; push after recovery:
   `uploaded=2` — the failed PUT retried instead of being trusted as synced
6. `s3 query` (DuckDB httpfs over `s3://df17bucket/...`): `{"n": 6}` — SQL over the
   remote copy works

All six documented legs green at HEAD a9350b94.

## Re-proof events appended (dated events, no second rows)

- **DF-1013-03** — REST `?debug=search` at HEAD: full searchDebug object (indexFreshness
  stale / row-bound skip reason on the >5000-row ns / keyword+semantic candidates /
  cache hits / embed ms), plus both 400 validation legs verbatim. Contrast: prod's
  unknown-parameter 400 = DF-2026-3.
- **DF-1013-01** — fresh bunker agent (df17-install @ bunker-mvp), README quickstart
  VERBATIM with no git identity anywhere: write 200, read-back verbatim, namespace git
  commit authored `Anonymous <anonymous@duckbrain.local>` (checked in the namespace's own
  git log). Control-host contrast: same write stamps the repo's identity — precedence
  works. All steps rc=0, TOTAL 37s (nvm 2s / node 7s / corepack 3s / clone 5s /
  pnpm install 7s / curl chain <1s each).
- **DF-1013-04** — 8 concurrent readers after sidecar deletion on a 30-row ns: all 200,
  count=30, 281–317ms cluster (single-flight signature), sidecar intact. >bound arm:
  fast 500s with the documented escape-hatch message while a cross-process CLI rebuild
  won cleanly (rc=0, 14.4MB sidecar, post-rebuild count 284 vs pre-deletion 264 — the
  stale sidecar had missed 20 later writes; refresh, not corruption).
- **PERF-013** — warm ?q= 1.91/2.53/1.60s on the 3477-row corpus (was ~6s p50 at run 16);
  searchDebug shows cacheHits 68/70, queryEmbedMs 0.6–1.1s (provider RTT floor); cold
  20.1s (18.6s candidate embeds). Union on stale prod: 47.9s / 813 ns — unchanged from
  run 16's 40.9s. Row stays pending on the union leg; single-ns is inside the documented
  <5s envelope at HEAD.

## Environment traps for the next runner

1. **Leaked session env**: this shell carried `DUCKBRAIN_NAMESPACES_PATH`,
   `DUCKBRAIN_CONFIG_PATH`, `DUCKBRAIN_GIT_AUTHOR_*` from an older session. CLI legs must
   `unset` them first — they silently redirect every root resolution.
2. **stray-duckbrain-reaper** killed two scratch daemons (session-abandoned clause: quiet
   log + non-protected port + age>600s). Redirect scratch-daemon stdout to a growing log
   file, or keep legs under ~9 minutes between writes.
3. **pkill self-match**: killing the scratch daemon via `pkill -f "port 3907"` trips the
   agent's self-termination guard (the pattern is in your own argv) — kill via the
   tracked background session instead.
4. **S3 bootstrap litter**: `s3 sync <ns> pull` bootstraps a missing local namespace dir
   BEFORE the lock/registry checks — an invocation with a wrong root creates empty dirs in
   whatever tree it resolved. Removed here (verified 0 files).
