# Carter S3 Re-Review — CARTER-S3-REVERIFY-001

Date: 2026-10-20
HEAD reviewed: `84644cc2b0b566f611626a6279d96b62637a6d0f` (base origin/main, branch `wt/CARTER-S3-REVERIFY-001`)

This is an independent re-review of DuckBrain native S3, run after the linked
Carter findings closed. Every claim below carries the exact command, its exit
code, and its observed output tail. Verdicts are PROVEN / UNVERIFIED / SUSPECT;
nothing is upgraded by inference.

## Store used (S3-compatible, disposable)

- Container arm (MinIO): **UNVERIFIED** — `docker pull minio/minio` failed with
  `pull access denied for minio/minio, repository does not exist or may require
  'docker login'` (rc 0, but no image); `docker pull quay.io/minio/minio`
  failed with `401 UNAUTHORIZED` on the manifest HEAD. No local MinIO image was
  present (`docker images` grep). No MinIO digest/tag was obtainable.
- Fallback arm (used): **`moto` 5.2.4** (Python S3 mock server, flask 3.1.3),
  installed into an isolated venv at `/tmp/s3mock-venv` via `uv pip install
  "moto[server]"`. Started as `moto_server -H 127.0.0.1 -p 9100` (PID written
  to `/tmp/moto-server.pid`). It is a plain `http://` S3-compatible store on a
  loopback port — no network access, no production contact. Tear-down by
  explicit PID (`kill 1301930`, the actual listener pid from `ss -ltnp`) at the
  end; verified `no listener on 9100` afterwards.

Isolated config (`/tmp/carter-s3test/duckbrain.config.json`) pointed at the
moto store: `endpoint=http://127.0.0.1:9100`, `bucket=cartertest`,
`prefix=duckbrain`, `forcePathStyle=true`, `enabled=true`. Credentials came from
a scratch profile (`AWS_SHARED_CREDENTIALS_FILE=/tmp/carter-s3test/aws-credentials`,
profile `carter-mock`), never from any real credential.

---

## Results table

| Step | Command (abridged) | rc | Verdict |
|------|--------------------|----|---------|
| S1 HEAD | `git rev-parse HEAD` | 0 | PROVEN — `84644cc2b0b566f611626a6279d96b62637a6d0f` |
| S1 log | `git log --oneline -12` | 0 | PROVEN — 12 commits, tip `84644cc2 board: keep DOC-19 open …` |
| S1 prod probe | `node bin/duckbrain.js s3 status` | 0 | PROVEN — `S3 config: disabled` (zero S3 network contact) |
| S1 CI | `gh run list --repo wojons/duckbrain --limit 5 …` | 0 | PROVEN — HEAD run `39514638322`, conclusion `failure` |
| S1 CI jobs | `gh run view 39514638322 --json jobs` | 0 | PROVEN — `test => failure`, `docker => skipped` |
| S1 CI suites | run log "Run tests" | — | PROVEN — `Tests 1934 passed (1934)` |
| S1 CI red step | run log "Assert AGENTS.md test counts match live suite" | 1 | PROVEN — `GAP-012 drift: AGENTS.md Tech Stack count != live (232 suites, 1934 tests)` |
| S2 unit | `CI=true timeout 900 npx vitest run` | 0 | PROVEN — `Test Files 232 passed (232)`, `Tests 1934 passed (1934)` |
| S2 harness | `bash scripts/s3/test-alert-gate.sh` | 0 | PROVEN — `47 passed, 0 failed` |
| S2 harness | `bash scripts/s3/test-component-completeness.sh` | 0 | PROVEN — `19 passed, 0 failed` |
| S2 harness | `bash scripts/s3/test-duplicate-bundle-repair.sh` | 0 | PROVEN — `roster: 7/7 cases, 51/51 assertions` |
| S2 harness | `bash scripts/s3/test-fd-inheritance.sh` | 0 | PROVEN — `14 passed, 0 failed` |
| S2 harness | `bash scripts/s3/test-push-backoff.sh` | 0 | PROVEN — `85 passed, 0 failed` |
| S3 container | `docker pull minio/minio` / `quay.io/minio/minio` | fail | UNVERIFIED — image unobtainable (no network pull); see "Store used" |
| S3 (a) push | `node bin/duckbrain.js s3 sync carterns push` | 0 | PROVEN — `uploaded=1 …`; `aws s3 ls` shows 1 object (325 B) |
| S3 (b) edit+push | append line, re-`sync … push` | 0 | PROVEN — local 432 B → remote 432 B; manifest moved (sha256+etag) |
| S3 (c) fresh pull | `env DUCKBRAIN_NAMESPACES_PATH=… s3 sync carterns pull` | 0 | PROVEN — `downloaded=1`; `diff` of pulled vs source: identical |
| S3 (d) corruption | `sed -i '0,/second/s//SECOND/'`, re-`sync … pull` | 0 | PROVEN — same-length (432 B) corruption detected, `downloaded=1`, sha256 restored to `b62751…` |
| S3 (e) live lock | lock w/ live pid 1394977 → `s3 sync … push` | 1 | PROVEN — `Error: [S3] another sync is in progress (lock held)` |
| S3 (e) stale lock | lock w/ dead pid 999999 → `s3 sync … push` | 0 | PROVEN — broken + `skipped=1`; lock file gone after |
| S3 (e) SIGINT | `timeout -s INT 5 … sync carterslow push` | (killed) | PROVEN — stale `.lock` left (dead pid 1507126); next push broke it: `uploaded=1176 skipped=1624` |
| S3 (f) query | `node bin/duckbrain.js s3 query "SELECT count(*) … read_json_auto('s3://cartertest/duckbrain/carterns/memories.jsonl')"` | 0 | PROVEN — `rows: 1`, `{"n":4}` over plain `http://` |
| S4 manifest | `cat .s3state/carterns.json` | 0 | PROVEN — size 432, sha256 `b62751…`, etag `"209c5ffc…"` |
| S4 objects | `aws s3 ls --recursive` + `aws s3api head-object` | 0 | PROVEN — 1 object, 432 B, ETag `"209c5ffc…"` |
| S4 hash match | `sha256sum` + `md5sum` of local file | 0 | PROVEN — local sha256 `b62751…` == manifest; local md5 `209c5ffc…` == remote ETag |
| S5 discipline | command review (see below) | — | PROVEN — no `s3 sync` against production |
| S6 boundary | `git show --stat a12164fd`; read `src/mcp/custom-runtime.ts` | 0 | PROVEN — commit present; boundary re-derived |
| S6 tests | `npx vitest run src/mcp/custom-runtime.test.ts` | 0 | PROVEN — `26 passed (26)`, escape probes blocked |

---

## S1 — Landed source + exact-HEAD CI (read-only)

`git rev-parse HEAD` → `84644cc2b0b566f611626a6279d96b62637a6d0f` (rc 0).
`git log --oneline -12` shows the tip is `84644cc2 board: keep DOC-19 open
pending live read-ledger probe`; the branch is `wt/CARTER-S3-REVERIFY-001`
based on origin/main.

Read-only production probe: `node bin/duckbrain.js s3 status` → rc 0, output
`S3 config: disabled`. Because the resolved config (`/home/kara/duckbrain.config.json`,
found by the config-root walk from the worktree cwd) has `s3.enabled=false`,
`s3Status` returns before building any S3 client — this command made **zero**
S3 network contact.

Hosted CI for the exact HEAD:

```
gh run list --repo wojons/duckbrain --limit 5 --json databaseId,headSha,conclusion,status,displayTitle
→ run 39514638322 headSha=84644cc2b0b566f611626a6279d96b62637a6d0f conclusion="failure" status="completed"
  (a newer run 39516958276 at headSha 9709d746 is in_progress: "ci: sync AGENTS.md test counts to live suite")
```

`gh run view 39514638322 --json jobs` → `test => failure`, `docker => skipped`.
So the failure is in the single `test` job; there is no separate docker leg.

KNOWN CONTEXT — **CONFIRMED** (not assumed). The `test` job's "Run tests" step
passes its suites: the log line is `Tests 1934 passed (1934)`. The job then
fails at exactly one step, "Assert AGENTS.md test counts match live suite":

```
test  Assert AGENTS.md test counts match live suite  GAP-012 drift: AGENTS.md Tech Stack count != live (232 suites, 1934 tests)
test  Assert AGENTS.md test counts match live suite  ##[error]Process completed with exit code 1.
```

So at HEAD 84644cc2, the ONLY red is the test-count drift assert, and the test
suites themselves are green (1934/1934). The in-progress run `9709d746` is the
sync-AGENTS.md-counts fix, consistent with this being a known, already-tracked
drift (the worktree's `AGENTS.md` still says "1932 tests" while live is 1934).

## S2 — Full unit suite + S3 shell harnesses

`CI=true timeout 900 npx vitest run` → rc 0:

```
Test Files  232 passed (232)
      Tests  1934 passed (1934)
   Duration  119.51s
```

Shell harnesses (each `bash "$f"`, rc captured):

```
test-alert-gate.sh            rc=0  47 passed, 0 failed
test-component-completeness.sh rc=0  19 passed, 0 failed
test-duplicate-bundle-repair.sh rc=0  roster: 7/7 cases, 51/51 assertions
test-fd-inheritance.sh        rc=0  14 passed, 0 failed
test-push-backoff.sh          rc=0  85 passed, 0 failed
```

All five hermetic harnesses are green.

## S3 — Behaviour against the disposable store

Every invocation was pointed explicitly at the moto store on
`127.0.0.1:9100` via `DUCKBRAIN_HOME_ROOT=/tmp/carter-s3test` (and, for the
fresh-root pull, `DUCKBRAIN_NAMESPACES_PATH=/tmp/carter-s3test/pull-target`).
No production endpoint was contacted (see S5).

(a) **Fresh push.** `node bin/duckbrain.js s3 sync carterns push` → rc 0,
`[S3] push carterns: uploaded=1 downloaded=0 skipped=0 in 40ms`.
`aws s3 ls s3://cartertest/duckbrain/carterns/ --recursive --endpoint-url http://127.0.0.1:9100`
→ `2026-10-20 … 325 duckbrain/carterns/memories.jsonl`. Object exists.

(b) **Edit + re-push.** Appended a 4th JSONL line (local size 325 → 432 B),
re-pushed → rc 0, `uploaded=1`. Remote object now 432 B. Local sync manifest
moved: `lastSyncAt` updated, and `memories.jsonl` recorded
`size:432, sha256:b62751…, etag:"209c5ffc…"`.

(c) **Fresh-root pull.** `env DUCKBRAIN_NAMESPACES_PATH=/tmp/carter-s3test/pull-target
node bin/duckbrain.js s3 sync carterns pull` → rc 0, `downloaded=1`. Pulled tree
contains `carterns/memories.jsonl`; `diff` against the source tree → identical
(diff rc 0, no output).

(d) **Same-length corruption repair.** Flipped bytes inside the one segment
keeping length identical (`sed -i '0,/second/s//SECOND/'` → "second"→"SECOND",
432 B before and after; sha256 changed `b62751…` → `9e8ebb…`). Re-sync via pull:
`[S3] pull carterns: uploaded=0 downloaded=1 … in 389ms` → rc 0. After pull the
file sha256 is back to `b62751…`, `grep -c SECOND` = 0, `grep -c 'second memory'` = 1.
The same-length corruption is detected and repaired, not silently equated.

(e) **Interrupted-request / lock overlap.**
- Live-pid lock: wrote `.s3state/.lock` with a live `sleep` pid (1394977), ran
  sync → rc 1, `Error: [S3] another sync is in progress (lock held)`. Blocks.
- Dead-pid lock: wrote `.lock` with pid 999999, ran sync → rc 0,
  `[S3] push carterns: uploaded=0 … skipped=1`; lock broken, then released
  (file gone).
- SIGINT mid-push: `timeout -s INT 5 node bin/duckbrain.js s3 sync carterslow push`
  (800→2800 files, push ~2.5 s) left a stale `.lock` (`{"pid":1507126,…}`) after
  the kill. The immediately-following push broke the dead-pid lock and completed:
  `[S3] push carterslow: uploaded=1176 downloaded=0 skipped=1624 in 5219ms` → rc 0.
  Conclusion: an interrupted sync leaves a stale lock, and the next sync breaks
  it (dead-pid check) and proceeds — it blocks, never queues silently, never
  corrupts.

(f) **S3 query over plain http:// (S3-QUERY-SCHEME-001).**

```
node bin/duckbrain.js s3 query "SELECT count(*) AS n FROM read_json_auto('s3://cartertest/duckbrain/carterns/memories.jsonl')"
→ rc 0
columns: n
rows: 1
{"n":4}
```

The query succeeds over the plain `http://` store (count 4 == the 4 memory
lines), proving the `s3_use_ssl=false` scheme carry-out works end to end.

## S4 — Object bytes + manifest inspection

Local sync manifest (`/tmp/carter-s3test/namespaces/.s3state/carterns.json`):

```json
{ "version": 1, "ns": "carterns", "lastSyncAt": "2026-10-20T23:56:43.951Z",
  "files": { "memories.jsonl": { "size": 432, "sha256": "b62751bcfc6827a7b363bd5bb192c772cda8579bc7d60f6a0e47d740b150ca6e",
                                 "etag": "\"209c5ffc3d0566d51401eb7ef7df1a33\"" } } }
```

Remote object (`aws s3 ls --recursive` + `aws s3api head-object`):

```
2026-10-20 18:55:17  432  duckbrain/carterns/memories.jsonl
ETag: "209c5ffc3d0566d51401eb7ef7df1a33"   ContentLength: 432
```

Local file: `sha256sum` → `b62751bcfc6827a7b363bd5bb192c772cda8579bc7d60f6a0e47d740b150ca6e`,
`wc -c` → 432, `md5sum` → `209c5ffc3d0566d51401eb7ef7df1a33`.

Every recorded value matches the actual object: manifest size == remote
ContentLength == local size (432); manifest sha256 == local sha256; manifest
etag == remote ETag == local md5 (single-part ETag is the object md5, exactly as
S3-GIT-008's tier-1 checksum claim describes).

## S5 — Production read-only discipline

The only production-context command was `node bin/duckbrain.js s3 status`
(S1), and it resolved a config with `s3.enabled=false`
(`/home/kara/duckbrain.config.json`), so `s3Status` returned `S3 config:
disabled` before constructing any S3 client — **zero S3 network contact**.

Every sync/query/config invocation carried `DUCKBRAIN_HOME_ROOT=/tmp/carter-s3test`
(or `DUCKBRAIN_NAMESPACES_PATH=/tmp/carter-s3test/pull-target`), pointing the
product at the disposable moto store on `127.0.0.1:9100`. The production
endpoint config (s3 `enabled=true`, `endpoint=https://hel1.your-objectstorage.com`,
in `/home/kara/duckbrain/duckbrain.config.json`) was never the resolved root of
any command in this review. The command list contains no `duckbrain s3 sync`
(and no `s3 query`) against the production endpoint. The only `s3 sync`
invocations were against `s3://cartertest` on the loopback store.

## S6 — Custom-code trust boundary re-check (MCP-CUSTOM-RUNTIME-002)

`git show --stat a12164fd` confirms the commit exists at HEAD (files
`src/mcp/custom-runtime.ts` +138/-… and `src/mcp/custom-runtime.test.ts` +122),
subject "fix(mcp): assert constructor-escape probe outcome and document trust
boundary (MCP-CUSTOM-RUNTIME-002)".

Re-derived from source (`src/mcp/custom-runtime.ts`), what the boundary actually
enforces:

- JS realm is `Object.create(null)` with exactly one own value, a primitive
  string (`__args_json`), then `vm.createContext(sandbox, { codeGeneration:
  { strings:false, wasm:true } })` (lines 511-513). The args are parsed *inside*
  the realm (`PRELUDE` line 519), so `args` is a realm object. `strings:false`
  gates the realm's `Function`/`eval`; `wasm:true` keeps the realm's own
  WebAssembly.
- WASM runtime instantiates with an empty import namespace
  (`new WebAssembly.Instance(mod, {})`, lines 449-450), so host imports trap.
- Capabilities fail closed: `if (def.capabilities.length > 0) return
  CAPABILITY_DECLARED` (lines 927-933) — before execution; this build grants none.
- Resource limits: vm `timeout` + parent `worker.terminate()` at `timeoutMs+25`
  (line 716-721); V8 `resourceLimits` (lines 655-660). Result hygiene: JSON
  round-trip (lines 558-567); worker stdout/stderr drained (lines 675-676).
- The source's own TRUST BOUNDARY block (lines 77-98) is explicit that there is
  NO OS-level isolation and the threat model is operator-authored code.

The source's claims are consistent with its implementation. The trust-boundary
tests pass at this HEAD: `npx vitest run src/mcp/custom-runtime.test.ts` →
`26 passed (26)`, including the 10-arm escape probe (this/globalThis/args/
Object/[]/''/console.log/Function/eval/require-via-constructor) all asserted
blocked with "Code generation from strings disallowed for this context".

**Divergences found between docs and source** (recorded, not fixed — see
FINDINGS): the docs' JS-realm surface list contradicts the source on `console`
and overstates the "ONLY" globals list.

---

## Findings

F1 — **docs vs source: `console` is present, not absent. Severity: Low.**
`docs/api/custom-tools.md:18` lists `console` under "Notably absent" from the JS
realm. `src/mcp/custom-runtime.ts:61-63` states the opposite: "`console` does
(Node provides it per vm context) but writes to the worker's stdout, which the
parent drains to nothing." The test requires `console` to be reachable —
`src/mcp/custom-runtime.test.ts:637` reads `console.log.constructor(...)` and
line 685 asserts that arm is blocked with the code-generation message (which it
can only produce if `console.log` exists; a missing `console` would yield a
`TypeError`, not the asserted message). No security impact observed:
`console.log.constructor` resolves to the realm's *gated* `Function` (the arm
is blocked), and its output is drained — but the doc is factually wrong about
the surface an auditor would expect to find.

F2 — **docs overstate the realm's global surface. Severity: Low / informational.**
`docs/api/custom-tools.md:15-17` says the JS realm's global surface "contains
ONLY: the call arguments, JSON, Math, Date, the primitive constructors, Promise,
the Error family, parse/format helpers and WebAssembly." In fact the `node:vm`
realm contains the full ECMAScript intrinsic set (Object, Array, Map, Set,
RegExp, String, Number, Boolean, Symbol, …) plus `console` (F1) and
`globalThis`/`global`. All are realm-fresh and code-generation-gated, so this is
not a security finding — but "contains ONLY" is a false precision claim that a
later auditor would read as an exhaustive allow-list.

No higher-severity divergence was found: the sandbox's own trust-boundary
documentation (source lines 33-99) matches the implementation, and the escape
probes hold.

## UNTESTED PATHS / PROVIDERS

- **MinIO (real S3-compatible container)** — UNVERIFIED. The image could not be
  pulled (`docker pull minio/minio` → "pull access denied"; `quay.io/minio/minio`
  → 401 on the manifest HEAD). No digest/tag was recorded. The container arm of
  S3 is therefore unexercised; the behaviour arm was covered by `moto` instead.
- **AWS S3 proper / Hetzner production endpoint** — UNVERIFIED by design. This
  review is read-only against production and made zero production contact; the
  production endpoint (`https://hel1.your-objectstorage.com`) was never probed.
  `s3_use_ssl=true` (https) is the code path exercised only by the existing unit
  suite, not by a live https store here.
- **`s3 sync all` (aggregate multi-namespace push/pull) and `s3 clear` / `s3
  ghosts`** — not exercised live. Single-namespace push/pull and `s3 query` were
  the live arms; the aggregate and lifecycle verbs are covered by the unit suite
  only.
- **git-history layer (git-remote-s3 bundle push)** — not exercised live; the
  hermetic `test-duplicate-bundle-repair.sh` and `test-push-backoff.sh`
  harnesses cover it, but no live git-remote-s3 push against the store was run.

## BOTTOM LINE

Independently confirmed as closed / correct at HEAD 84644cc2:

- **S3-QUERY-SCHEME-001** — confirmed closed. `duckbrain s3 query` succeeds over
  a plain `http://` store (`count=4`, rc 0), the `s3_use_ssl=false` carry-out
  works end to end.
- **S3-GIT-008 (content identity / same-length corruption)** — confirmed. A
  same-length (432-byte) corruption is detected and repaired by pull, and the
  manifest's recorded sha256 + ETag match the actual objects byte-for-byte.
- **S3-GIT-006 (stale-lock recovery) / S3-GIT-007 (deadline bounds)** — lock
  semantics confirmed: a live-pid lock blocks (rc 1), a dead-pid lock is broken
  and the sync proceeds, and a SIGINT-interrupted push leaves a stale lock that
  the next sync recovers from without corruption.
- **S3 native push/pull + manifest integrity** — confirmed (fresh push, edit +
  re-push, fresh-root pull with identical diff, manifest/object byte + hash
  parity).
- **MCP-CUSTOM-RUNTIME-002 trust boundary** — confirmed at source level: the
  prototype-less realm + `codeGeneration.strings:false` + empty wasm imports +
  fail-closed capabilities hold, and the 26-test suite (10 escape arms) passes.

Cannot independently speak to (UNVERIFIED, with reason): the MinIO container
arm (image unobtainable), and anything requiring the real production endpoint
(https) or AWS S3 proper — both out of scope for this read-only review by design.

Two low-severity documentation findings (F1, F2) remain open and are recorded,
not fixed, per the frozen-code rule for this verification row.
