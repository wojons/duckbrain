# Dogfood Integration Report — DuckBrain as-of Time Travel (2026-09-24)

**Run:** cron tick `duckbrain-qa` · **Angle:** the surface runs 1–6 never touched —
git-native as-of time travel, the README's flagship differentiator.
**Isolation:** scratch daemon `:3793`, `DUCKBRAIN_CONFIG_PATH` +
`DUCKBRAIN_NAMESPACES_PATH` pointed at `/tmp/dogfood-duckbrain-0924/`, prod
`:3000` untouched (read-only health probe only).

## Promise under test

> "Read-only as-of recall at a date, commit, branch, or tag — no checkout —
> Available now" (README capability matrix, positioning.md).

## What a real user does (worked example)

```bash
# 1. scratch daemon
DUCKBRAIN_CONFIG_PATH=/tmp/df/config.json DUCKBRAIN_NAMESPACES_PATH=/tmp/df/ns \
  node bin/duckbrain.js http --port=3793 &

# 2. create the namespace FIRST (this is what git-inits it)
curl -X POST localhost:3793/api/namespaces -H 'Content-Type: application/json' \
  -d '{"name":"audit-ns"}'

# 3. write rev1, wait for the git batch flush (gitBatching.maxSeconds)
curl -X POST 'localhost:3793/api/memories?namespace=audit-ns' \
  -H 'Content-Type: application/json' \
  -d '{"key":"/proj/db-host","domain":"raw_note","content":"db on db-01","attributes":{"rev":"v1"}}'
sleep 4   # git batching: default maxSeconds=30, config used 3

# 4. the three as-of surfaces — all resolve the SAME ref forms
git -C namespaces/audit-ns tag v1-point            # tag the moment you care about
curl 'localhost:3793/api/memories?namespace=audit-ns&as_of=v1-point'          # HTTP
node bin/duckbrain.js recall --namespace audit-ns --as-of=v1-point            # CLI
# MCP: tools/call recall {"namespace":"audit-ns","asOf":"v1-point"}            # MCP (undocumented, works)

# 5. delete something, then read the world before the deletion (the killer use)
curl -X DELETE "localhost:3793/api/memories/<id>?namespace=audit-ns"          # 204
curl 'localhost:3793/api/memories?namespace=audit-ns&as_of=<pre-forget-sha>'  # deleted row is BACK
```

## Results — every arm, measured

| Arm | Result |
|---|---|
| `as_of=<first-commit-sha>` | ✅ exactly the rows at that ref (db-01 only) |
| `as_of=<HEAD-sha>` / branch | ✅ rows as of that ref |
| `as_of=<tag>` (`v1-point`) | ✅ |
| `as_of=2026-09-24` (date, same-day) | ✅ nearest commit at-or-before (end-of-day bound) |
| `as_of=<instant between commits>` | ✅ second-level precision: 10:04:41Z → pre-commit2 state |
| `as_of=<date before first commit>` | ✅ clean 400 `No commit found at or before …` |
| `as_of=zzz-nope` | ✅ clean 400 with explicit message |
| `as_of=<fresh ns, no commits>` | ✅ 400 (namespace git-inited but commitless) |
| `as_of=<nonexistent ns>` | ✅ 400 `not a git repository` |
| `as_of + q=` | ⚠️ rejected, but **500** not 400 (DF-0924-04) |
| `as_of + historical=true` | ✅ 200 |
| forget → tombstone → as-of pre-forget ref | ✅ deleted row fully recoverable; as-of at post-forget HEAD hides it |
| CLI space form `--as-of v1-point` | ✅ (RETR-008-era space-form normalization holds) |
| CLI equals form `--as-of=891aada` (short SHA) | ✅ |
| MCP `recall.asOf` via MCP-over-HTTP | ✅ but undocumented (DF-0924-03) |
| no-checkout claim (`git status` after queries) | ✅ worktree clean, zero mutation |
| git-level `git show <ref>:raw_note/2026-09/current.jsonl` | ✅ storage is genuinely inspectable |
| perf | as-of 30.4ms ± warm (n=20) vs 6.1ms current — 5× tax, imperceptible; no PERF row |

## Verdict on the promise: HOLDS (on current HEAD)

The feature works end-to-end on all three surfaces with correct edge semantics.
This is the strongest surface DuckBrain has — and it is invisible to a fresh
user, because the branch they clone (origin/main, Aug 07) predates it
entirely and **silently answers `?as_of=` with 200 + current-state** instead of
erroring. See DF-0924-02.

## Errors hit during integration (and their meaning)

1. `Invalid domain 'fact'` — domains are a fixed enum (`person, event, concept,
   message, config, raw_note`); the error message enumerates them, which is the
   right shape. Docs could lead with the enum.
2. CLI without env vars hit the REAL prod namespaces ("not a git repository"
   for a ns that exists in my scratch dir) — the isolation env vars are
   per-process, not ambient; root resolution (GAP-062) is config-relative.
   Not a defect; a footgun worth a note in the usage skill.
3. `/health` on a fresh scratch daemon shows `keys_error: "Namespace
   'undefined' does not exist"` — probeKeysStore() is called with no namespace
   (probe hits 'undefined'); prod daemon shows null. Cosmetic-on-fresh,
   confusing at first boot.
4. On stale-main (bunker): `EACCES /tmp/duckbrain-http.pid` (shared-host
   killer) and `ENOENT` when `DUCKBRAIN_DATA_DIR` points at a non-existent dir
   — both already fixed at HEAD (per-port pidfile + cleanupStalePidFile).

## What a new user needs that isn't written

- MCP `recall.asOf` exists (DF-0924-03).
- `?as_of=` requires the namespace to have git history — create the namespace
  via POST first, and don't point `as_of` before the first commit.
- as-of reads are O(history-at-ref): ~30ms on a tiny ns; budget accordingly on
  large ones (still fine).
