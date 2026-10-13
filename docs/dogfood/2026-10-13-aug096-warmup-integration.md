# AUG-096 namespace boot warm-up — real-use integration report (Run 15, 2026-10-13)

**Angle:** the brand-new AUG-096 surface (commits 07f5b3f8 + 32de0244, both
2026-10-13): per-namespace DuckDB connection warming + FTS sidecar warming at
daemon boot. No prior dogfood run touched it (surface was born today).

## What the feature promises

`startNamespaceWarmup()` runs fire-and-forget after the TCP bind: enumerates
every on-disk namespace (manifest-first, on-disk census fallback), creates the
per-namespace DuckDB singleton, and runs the SAME bounded single-flight
`ensureFreshIndex` the first `?q=` request would pay — so a fresh daemon's
first scoped search answers warm. Opt-out `DUCKBRAIN_WARM_NAMESPACES=0`;
budget `DUCKBRAIN_WARM_BUDGET_MS` (300s), per-ns timeout 30s, concurrency 4.

## How it was really used (scratch instance, never prod)

- Scratch namespaces root `/tmp/dfduck/namespaces`: read-only copies of the 8
  biggest prod namespaces (20 MB total) + one deliberately corrupt namespace
  (`broken-ns`, garbage manifest.json). Isolated auth file + config path.
- Two arms driven as a real client would: cold daemon (`WARM_NAMESPACES=0`)
  vs warmed daemon, first scoped search
  `GET /api/memories?namespace=coding-hermes&q=board+events&limit=5`.
- Both embedding configs measured: the daemon default (lmstudio local) and
  the prod daemon's config (openai/OpenRouter via /proc environ passthrough —
  values never printed).

## Numbers (headline)

| Config | Arm | First scoped search | Breakdown (search-timing) |
|---|---|---|---|
| prod-emb | cold (no sidecar, warmup off) | 5.72s | FTS rebuild 3511.7ms + q-embed 781ms + cand-embed 1324ms |
| prod-emb | warmed boot | 2.19s | keyword 131.5ms + q-embed 841ms + cand-embed 856ms |
| lmstudio | cold (sidecar present, warmup off) | 12.74s | provider-dominated |
| lmstudio | warmed boot | 9.15s | cand-embed 5635ms (local GPU loaded) |

Warm-up pass itself: 9 namespaces, 1.46s aggregate (prod-emb, indexes fresh
from prior run) / 44.4s (lmstudio, all rebuilt) — non-blocking, `HTTP server
ready` always preceded it. **AUG-096 delivers: the 3.5s inline FTS rebuild
left the request path (~62% cold reduction under the prod config).** The
residual 2.2s is embedding-provider round-trips (batch_supported=false on
this provider; single sequential embeds), not index state — filed as
PERF-012 with the batch-embedding direction.

## What a user should know (the "right way")

1. The feature is default-on and opt-out, not opt-in — a fresh daemon warms
   every namespace at boot whether you asked or not. On many-namespace hosts
   with a slow local embedding provider expect tens of seconds of background
   DuckDB+FTS work after "HTTP server ready" (harmless, budgeted, logged).
2. Warm/first-search verification: `DUCKBRAIN_SEARCH_TIMING=1` + grep
   `[search-timing]` in daemon stderr. `keyword_ms` ≈ 130 means the sidecar
   was warm; ≈ 3500 means the request paid the rebuild.
3. Corrupt namespace gotcha (filed DF-1013-02): a namespace with unparseable
   manifest.json is graded `warmed, connection-only idx=rebuilt` at boot —
   only the API's request-time 500 tells the truth. Trust `/health` + API
   probes over the warm-up summary line for namespace health.
4. The REST `?q=` response carries no index diagnostics (filed DF-1013-03).
   Clients cannot see freshness/rebuild state; stderr timing is the only
   observable.
5. A stale `dist/` (tsc build) silently benches the OLD code: `bin/duckbrain.js`
   prefers precompiled dist. After pulling new commits, run `pnpm build:cli`
   before benchmarking anything (this run rebuilt first — dist was Oct 7).

## Errors hit during the run (and what each proved)

- Scratch token printed once, truncated by my own `tail` → minted a fresh
  token capturing the full print. Product behavior correct (print-once).
- First cold-arm curl used the wrong key extraction (hash, not raw key) →
  401. Auth-store keyHash-only confirmed (memory + live).
- Bunker smoke script: `nohup node ...` failed "No such file or directory"
  — non-interactive ssh shell lacks nvm node. Fix: `. ~/.nvm/nvm.sh` in the
  script. The documented quickstart itself works because it sources nvm
  before use; scripted consumers must do the same.
- README verify snippet step 4 fails 500 without git identity on the fresh
  box while README line 93 claims identity is not required to write — filed
  DF-1013-01 (docs contradiction; the snippet's own 404 hint misattributes).

## Verdict on this surface

Works as designed, measured, and fast where it promised. The two defects
found sit at the edges (corrupt-namespace grading, missing request-time
diagnostics), plus one docs contradiction on the fresh-install path.
