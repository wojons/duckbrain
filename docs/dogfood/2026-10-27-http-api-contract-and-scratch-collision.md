# DuckBrain dogfood — 2026-10-27: HTTP API contract pass + a cross-lane scratch/agent collision

Run: tick `duckbrain-dogfood-2026-10-27-20-29-19` · target `/home/kara/duckbrain` ·
HEAD `db695496bbfc68fd24e24940f095f951b64a2bea` (tracked tree clean; only the
untracked instance artifact `duckbrain.db` was present) · executor: skill-driven
(the `dogfood-scheduler-tick.sh` driver is retired) · lane: read-only + the Step-5
knowledge write-back.

**Verdict: 🟡 PROMISING-BUT-ROUGH.** The documented HTTP surface is real, fast and
mostly faithful to its own reference — every documented endpoint I drove answered,
the error taxonomy is precise where it matters (`?key=`/`?query=` refusals,
`as_of`'s five failure modes, the `?debug=search` guard), same-key multi-version
is genuinely append-only, `as_of` time-travel and the validity window behave as
written, keyword + semantic search both work offline/online — but two malformed
*client* inputs get a **500**, and this tick lost its own evidence and its
fresh-machine agent to a **concurrent lane using the same scratch path and port**.
The first is a small, well-localised wire-contract defect; the second is a fleet
hazard that will bite every dogfood tick until scratch paths and install agents
are lane-unique.

## 1. What it promises (Step 1)

From `README.md`, `AGENTS.md`, `docs/guide/getting-started.md` and
`docs/api/http-api.md`: a user can give an agent persistent, versioned memory —
store a memory over HTTP/CLI/MCP, read it back by key, search it semantically or
by keyword, time-travel it (`as_of`), compact it, and inspect the git history of
the namespace that holds it. The primary entry points are the CLI
(`node bin/duckbrain.js`), the HTTP daemon (`--auth=apikey` **by default**), and
the MCP stdio/HTTP transport.

*Null hypothesis:* "a fresh user can follow the quickstart, store and read back a
memory, and the HTTP reference's documented contract holds as written."

## 2. How it was driven (Step 2)

Isolated scratch, never production state:

```bash
# scratch root (per-run unique — see §5 for why this matters)
SB=/home/kara/dfdkb-tick-20261027-2029
export DUCKBRAIN_CONFIG_PATH=$SB/root/duckbrain.config.json   # own defaultNamespace, own namespacesPath
export DUCKBRAIN_EMBEDDING_API_KEY=<the operator's existing OpenRouter key, read from the live systemd drop-in>
export DUCKBRAIN_SEARCH_TIMING=1
cd /home/kara/duckbrain
node bin/duckbrain.js http --port=3199 --auth=apikey \
  --auth-file=$SB/root/scratch-auth.json --rate-limit=600     # apikey = the documented default
```

Everything below was driven against that daemon; the whole run is reproducible
from `evidence/confirm.sh` + `evidence/perf2.sh` in the run's evidence dir.

`docs/guide/getting-started.md` "Step 2: Verify Installation" was run as its own
five-command chain (port 3199 + `-H 'X-API-Key: …'` instead of
`--port=3000 --auth=none`, because 3000 is the live fleet daemon): health → create
namespace → write → read back. Result: **the docs' own success condition held** —
the final read returned `{"key":"/quickstart/hello","content":"first memory from
the quickstart"}`.

## 3. What held up (evidence in the run's evidence dir)

| Promise | Probe | Result |
|---|---|---|
| Same-key writes are append-only multi-version | 3 × POST `/api/memories` on `/quickstart/multiversion` | 3 distinct ids; list `total=3` ordered timestamp DESC (`v3 \| v2 \| v1`); key route returns v3 |
| Unknown query params are refused by name | `?key=`, `?query=`, `?bogus=1` | 400 `VALIDATION_ERROR`, message names the offender and lists the valid set |
| `?debug=search` needs `?q=` | `?debug=search`, `?q=…&debug=bogus`, `?q=…&debug=search` | 400 / 400 / 200 with `searchDebug`; `searchDebug` absent without the flag |
| `as_of` cannot combine with search | `as_of=<date>&q=…`, `&contains=…` | 400 "as_of cannot be combined with 'query' or 'contains' — …" (exact doc string) |
| `as_of` failure modes | unresolvable ref / date before first commit / empty / valid date / commit sha | 400 "Invalid --as-of value 'deadbeef'…" / 400 "No commit found at or before 2020-01-01" / 400 "--as-of requires a date or a git commit reference" / 200 rows / 200 rows |
| Validity window (RETR-011) | expired + future-only rows | current view hides both (`total=0`), `historical=true` returns both |
| Namespace git versioning | writes → wait for batching | `chore: auto-commit namespace data` commit lands ~30 s after the last write (`gitBatching.maxSeconds`), worktree clean afterwards |
| Offline keyword search | `?contains=pgbouncer` (200-row namespace) | 200 with `score`/`snippet`/`highlightedSnippet` |
| MCP transport | `POST /mcp` without/with `Accept`; `tools/list` | 406 / 200; 16 tools advertised (`recall`, `remember`, `list_keys`, `forget`, `squash`, …) |
| Legacy redirects | `/api/tree`, `/api/timeline`, `/api/search` | 301 → `/api/keys?prefix=/`, `/api/memories?limit=50`, `/api/memories?q=hello` |
| Documented endpoints answer | `/health`, `/stats`, `/namespaces`, `/users`, `/activity`, `/api/keys`, `/api/namespaces`, `/api/compaction/stats`, `/api/reads`, `/api/ns/:ns/tables`, `/api/ns/:ns/openapi.json`, `POST /cli` | all 200/400 as documented — no 404/500 on the documented paths (except the two findings below) |

## 4. What did not hold up (rows filed)

**DF-2026-5 (P3) — `DELETE /api/memories/:id` 500s on a non-UUID id.**
Same malformed id, three sibling operations in one route family:

```
DELETE /api/memories/not-a-uuid?namespace=quickstart   -> 500 {"error":"Invalid input: Invalid UUID"}   (no `code`)
GET    /api/memories/not-a-uuid?namespace=quickstart   -> 404 {"error":"Memory 'not-a-uuid' not found","code":"NOT_FOUND"}
PUT    /api/memories/not-a-uuid?namespace=quickstart   -> 404 NOT_FOUND
controls: DELETE <valid-but-unknown-uuid> -> 404 NOT_FOUND · DELETE <real id> -> 204
```

`docs/api/http-api.md` "Error Handling" reserves 500 for "Internal server error"
and states every error carries a `code`. Mechanism: the MCP `forget` tool returns
its zod failure as `{success:false, error:"Invalid input: …"}` **without a
`code`**, and the DELETE handler maps only `"not found"` to a 404 and sends the
rest to a classifier that defaults to 500
(`src/mcp/tools/forget.ts` validation branch; `src/http/routes/memories.ts:942-960`
+ the `throwWriteError` ladder at `:85-110`).

**DF-2026-6 (P3) — `POST /api/memories` with no body 500s.** Body-shape battery:

```
no body, no Content-Type            -> 500 {"error":"Internal server error","code":"INTERNAL_ERROR"}
-H 'Content-Type: application/json' -d '{}'   -> 400 VALIDATION_ERROR ("Missing required fields: key, domain, content")
-H 'Content-Type: application/json' -d '{not json' -> 400 INVALID_JSON ("Invalid JSON in request body")
```

A client mistake becomes a server error; the documented `INVALID_JSON` code
exists but is not reached. Same 500 independently observed on a second scratch
daemon at the same HEAD (see §5).

**DF-2026-8 (P5) — docs/reality drift on two documented claims.**
(a) A deleted version is invisible in *every* list view: after `DELETE`
(204, tombstone row present in the namespace JSONL with `action:"tombstone"`),
`/api/memories?prefix=/quickstart/victim&historical=true` returns `total=0` —
while the reference says the list route "returns all of them" and `historical=true`
"includ[es] ALL rows". (b) `GET /mcp` is documented as part of the MCP transport
but answers `405 "Method Not Allowed: this endpoint does not offer a GET SSE
stream"` (the POST legs, including the 406-without-`Accept` rule, match exactly).

## 5. The collision that shaped this tick (row DF-2026-7)

This tick's first scratch was `/tmp/df-dkb-1027/{root,evidence,logs}` (the
project+date convention). At ~15:40 local the directory was **replaced** by
another Hermes session's duckbrain scratch — `config.json`
(`namespacesPath=/tmp/df-dkb-1027/namespaces`), `auth.json {"apiKeys":[]}`,
`home/`, `namespaces/`, later `own/{config.json,home,namespaces,server.log}`,
`health-1..5.json`, `cli-remember.txt`, `cli-recall.txt`, `remember-help.txt`,
`search-help.txt`, `status-help.txt`, `consolidate.txt`, `prod-health.json`,
`install-agent-capture.txt`. Consequences, in order:

1. this lane's evidence dir and its daemon's namespace root were deleted (the
   daemon stayed up but answered `503` degraded because its root was gone);
2. the replacement session's daemon bound **port 3137**, so this lane's next
   daemon died at startup — `errno: -98, syscall: 'listen', port: 3137` — and one
   confirmation pass was silently answered by *that* daemon (its
   `/proc/<pid>/environ` shows `HOME=/tmp/df-dkb-1027/own/home`,
   `HERMES_SESSION_CHAT_ID=b8f5c876-366a-4732-b540-05d8236dc5a5`), which is why
   that pass reported `author: anonymous@duckbrain.local` and a namespace path
   under `/tmp/df-dkb-1027/own/`;
3. the install agent this lane had spawned (`0908094c @ bunker-mvp`, launched
   20:40:31Z, cells `repo-head`/`toolchain-bootstrap`/`fresh-install` all OK — the
   other session captured its evidence to
   `/tmp/df-dkb-1027/install-agent-capture.txt` at 15:45) was **destroyed before
   Phase-B collection**; by 15:53 `bunker info --server bunker-mvp 0908094c`
   returned `not_found` and it was gone from `bunker list --status all`. This lane
   did not destroy it.

Recovery applied, and the reason the numbers in this report are trustworthy:
scratch moved to a **per-run unique** root (`/home/kara/dfdkb-tick-20261027-2029`,
not `/tmp`), a new daemon on **port 3199**, and the whole contract battery was
re-driven there (`evidence/confirm.txt`) — the two 500 findings reproduced
identically on both daemons, at the same HEAD.

## 6. Install leg — PARTIAL, not PASS

* Battery launched by this lane on `bunker-mvp` (host preflight: ONLINE, disk 32%,
  CPU 5%, 1 agent of 50) → agent `0908094c`, tarball payload `git archive HEAD`
  (`repository-identity` cell: `tested HEAD=db695496…`).
* Harvested before the agent vanished: `repo-head OK`, `toolchain-bootstrap OK`
  (go 1.27.3, node v22.22.3, gcc/g++, make, jq, compose+buildx), `fresh-install OK`
  — "build-only install (rc=0) … Done in 6.3s using pnpm v12.4.2", with the
  agent-side `inst.log` showing `pnpm@12.4.2` installing the committed lockfile
  (563 packages, supply-chain policy check passed). A raw (non-JSONL) fresh-install
  capture survived on the agent at the time of harvest and is quoted in
  `evidence/agent-evidence-raw.txt` and, for the same agent, in the other lane's
  `/tmp/df-dkb-1027/install-agent-capture.txt`.
* **Not** obtained: `ci-pass`, `native`, `ui-probe`, and the chaos cells — the
  agent was destroyed mid-battery by the concurrent lane before `collect`, so
  those cells are unrecoverable and installability is proven only to the
  pnpm-install/build step.
* A fresh-machine quickstart driven by *this* lane on that agent
  (`evidence/agent-quickstart.txt`) failed on a **rig** defect of mine: the
  battery's node lives in `~/tools/node/bin`, which my non-interactive script did
  not have on `PATH`, so `node bin/duckbrain.js help` never ran and the HTTP chain
  got `HTTP 000`; the ssh stream then dropped. That is harness evidence, not a
  product result, and it is reported as such.

## 7. Step 2b — what it costs (nothing here is slow enough to file)

Isolated daemon, HEAD `db695496`, host load avg ≈ 10 on 16 cores, 200-row
namespace (`hyperfine --warmup 3 --runs 20`, evidence `evidence/perf2.txt`):

| Operation | Warm |
|---|---|
| `GET /health` | 7.1 ms |
| `GET /api/memories/key/:key` (exact recall) | 12.7 ms (mean 26.2 ms incl. one 148 ms outlier) |
| `GET /api/memories?limit=50` | 17.0–22.3 ms |
| `GET /api/memories?contains=…` (keyword, 200 rows) | 53.4–72.7 ms |
| `GET /api/memories?q=…` (semantic, OpenRouter embed) | 105.4–106.9 ms |
| `GET /api/keys` tree | 11.0 ms |
| `GET /activity` (every-namespace feed) | 12.4 ms |
| `POST /api/memories` (write) | 14.7–14.9 ms |
| seed 200 writes | 15–19 ms each |

Cold: daemon start → first `/health` 200 = **1.07 s**; first `q=` in a namespace
with no FTS sidecar = **0.57–1.21 s** (inline rebuild, `indexRebuilt:true`), then
0.108–0.125 s warm.

`docs/api/http-api.md`'s PERF-005 promise ("warm semantic requests … under 5
seconds") is met with two orders of magnitude to spare. **Nothing here is slow
enough for a user to notice, so no PERF row is filed** — the only user-noticeable
wait known on this product remains the pre-existing PERF-013 (cross-namespace
union on the 813-namespace production store, 40.9 s).

## 8. Trust checks

* **Persistence**: the namespace's git repo receives an auto-commit ~30 s after
  the last write (`gitBatching.maxSeconds`), and the tree is clean afterwards;
  `as_of` reads resolve that commit.
* **Recovery**: `DELETE` creates a tombstone row rather than dropping data; the
  JSONL row survives on disk (`action:"tombstone"`), and the list hides it (DF-2026-8).
* **Isolation**: with `DUCKBRAIN_CONFIG_PATH` pointed at a scratch file, nothing
  of this run touched the production store — the only production-adjacent act was
  reading the operator's existing embedding key out of the live systemd drop-in
  for the scratch daemon (no credential was minted, and the host's own daemons
  were never written to).
* **Continuity**: `GET /api/reads` (read ledger) and `_audit/current.jsonl`
  recorded this run's reads/writes, including the 4xx refusals — the audit trail
  is real and self-describing.

## 9. What a maintainer should fix first (1 hour)

1. `DELETE /api/memories/:id` + missing-body `POST` → 4xx with a `code`
   (DF-2026-5/6): one classification helper, two call sites, both already have
   sibling behaviour to copy.
2. Make dogfood scratch roots + ports lane-unique and never let a `collect`
   destroy another lane's agent (DF-2026-7): this is the difference between a
   tick that lands evidence and a tick that lands nothing.
3. Then the doc pass (DF-2026-8).

## 10. Left behind / cleanup

* Board rows: `DF-2026-5`, `DF-2026-6`, `DF-2026-7`, `DF-2026-8` (pending).
* This report + `docs/dogfood/diagnostics.md` + `.coding-hermes/dogfood-log.md`
  entry + the `skills/duckbrain-usage/SKILL.md` note (all tracked paths).
* No product code, board *policy*, scheduler state, visibility or permission was
  changed; no credentials were minted; the foreman was not woken (read-only lane).
* Scratch: `/home/kara/dfdkb-tick-20261027-2029/` (daemon stopped at close-out;
  evidence retained as the run's primary evidence dir).
* **Not mine, left untouched:** `/tmp/df-dkb-1027/` and the concurrent session's
  daemon on `:3137`; `bunker-mvp` agent `crier-lab`; production `:3000`.
