# DuckBrain dogfood — 2026-10-16 — re-proof of landed fixes (Run 17)

**Run:** 17 (tick `duckbrain-dogfood-2026-10-16-12-40-48`) · **HEAD:** `a9350b94`
(local + published origin, in sync) · **Angle:** re-proof of the two fixes that
landed after run 16 — DF-1013-04 (FTS sidecar rebuild serialization) and
S3-GIT-008 (sha256 content-identity sync deltas) — driven through the product's
own CLI/HTTP surfaces, plus the ephemeral-bunker install leg.

**Promise under test:** "a user can store memories in a namespace, search them
with a keyword index that survives concurrent rebuilds, and mirror a namespace
to any S3-compatible endpoint with incremental, content-verified sync."

**Verdict: SHIPPABLE-ON-RE-PROOFED-SURFACES** (see `.coding-hermes/dogfood-log.md`).

## 1. S3-GIT-008 re-proof — FIX HOLDS (all four probes)

Backend: `rclone serve s3` (v1.75.1, `--auth-key`, path-style), a scratch
userspace S3 endpoint on 127.0.0.1:19099 — provider-agnostic claim exercised
for real (the docs promise "any S3-compatible endpoint"; rclone is not MinIO,
not AWS). Scratch namespace `s3repro8`, scratch config via
`DUCKBRAIN_CONFIG_PATH`/`DUCKBRAIN_NAMESPACES_PATH`; prod daemon untouched.

| Probe | Expected (fixed) | Observed | Verdict |
|---|---|---|---|
| P1 same-size content swap (`alpha`→`omega`, 5→5 chars) + mtime restored | push re-uploads (uploaded=1) | `uploaded=1 downloaded=0 skipped=2 in 29ms`; remote object contains `omega` | HOLDS |
| P2 push during backend outage | rc≠0, manifest does NOT record the file | rc=1 `ECONNREFUSED`; manifest sha unchanged; recovery push `uploaded=2` and remote has the content | HOLDS (no skip-forever) |
| P2b no-op push after recovery | skips everything | `uploaded=0 downloaded=0 skipped=3` | HOLDS |
| P3 same-size local corruption (`omega`→`alpha` back) | pull repairs from remote | `downloaded=1 skipped=2`; local has `gamma` again | HOLDS |
| Identity persisted | manifest carries sha256 of local bytes | manifest sha256 == `sha256sum` of the partition, full-hash match | HOLDS |

Pre-fix behavior (per the row's failing tests): P1 would have been
`skipped=3` (size+mtime equal ⇒ silent stale remote); P2 would have recorded
the failed upload as synchronized.

Dogfood friction note: the first probe run hit two environment traps, not
product bugs — (a) the planned port 9099 was held by a foreign python
dashboard (`ss -tlnp` attribution before blaming the product), and (b) rclone's
inline `:s3,...:` connection strings mangle `endpoint=` URIs; env-based remote
config (`RCLONE_CONFIG_*`) works. Recording both here because the next person
probing S3 surfaces against rclone will hit the same wall.

## 2. DF-1013-04 re-proof — FIX HOLDS (concurrency arms A/B/C)

Scratch namespace with 8 memories (3 original + 5 probe writes), then:

- **Arm A — the fleet's own race shape:** two `--detached` rebuilds fired back
  to back exactly the way `search-index install-hooks` fires them
  (`hooks.ts:63`), plus a `remember` landing 350ms into the window.
- **Arm B — 3 concurrent `search-index rebuild` CLI invocations** (separate
  processes, simultaneous).
- **Arm C — search during the race.**

Observed: all rcs 0; exactly one consistent sidecar (`meta.rowCount=9` —
3 original + 5 probes + 1 midrace write, the exact right number);
`fts.duckdb` = 1,847,296 bytes with a populated `memories` table (9 rows) —
run 16's corruption signature (53× 12,288-byte sidecars with ZERO tables) is
absent; no `.search.rebuild.lock` lingering after the race; search returned
correct results during and after.

## 3. Install leg — EXECUTED PASS (bunker-mvp, not skipped)

bunker-las-01/02/03/04 all offline (tailscale, 3-15d); `bunker-mvp` active —
the leg ran there per the sibling-host rule. Agent `df-dkb-1016` (TTL 2h),
fresh Debian trixie user, git+curl only (no node — the README's toolchain
block was exercised, not assumed).

- toolchain (nvm + node 22 + corepack pnpm 12.4.2): **13s**
- `git clone https://github.com/wojons/duckbrain.git`: **4s** → HEAD a9350b9
- `pnpm install`: **7s**
- documented smoke (`--auth=none` daemon → `/health` → namespace create →
  POST memory → GET read-back): **green**, read-back returned the exact
  content; anonymous author stamp `anonymous@duckbrain.local` as documented.
- delta smoke (this run's fix surfaces, on the same fresh box):
  `search-index rebuild --namespace=quickstart` green (wallMs 649),
  `search quickstart` scored hit with `<mark>` rendering,
  `s3 status` on a default config prints "S3 config: disabled" rc=0 (clean
  documented refusal of the inert surface).
- destroy: `bunker destroy` OK; list verified empty (0 agents, no orphan).

Fresh-box frictions: none. Node/pnpm assumed-but-documented (the README has
the exact block a fresh user pastes, and it worked verbatim on a bare box).

## 4. Perf (Step 2b) — NO ROW, said plainly

Measured on the operations this run actually performed (scratch ns, 8-14
rows, warm ×3, `/usr/bin/time -f`):

- `s3 status`: 0.39-0.43s wall (0.39-0.44 user+sys — the Node startup floor)
- `s3 sync push` (no-op): 0.40-0.45s wall; the sync engine itself 32-51ms
- `search <token>` (warm sidecar): 0.38-0.42s wall
- `remember` (write + autocommit batching): 0.42-0.46s wall

Everything is dominated by Node process startup; nothing a user would notice
beyond the CLI floor, and nothing justified a profile. Per the perf law, a
win nobody can feel is not a finding — no PERF row filed. (Prod-scale search
latency is already PERF-013 territory.)

## 5. Findings → rows

- **DF-2026-1 (P3):** `remember` CLI rejection omits `--domain=` from its
  error text and refuses `--help` (sibling `search` accepts it). The flag is
  undiscoverable at the exact moment of failure. Fresh this run.
- **DF-2026-2 (P3):** zero-hit keyword search prints "No memories found" rc=0
  with no staleness hint even when the namespace is provably newer than the
  index's `indexedAt` (legal ~1s auto-build window, but silence is
  indistinguishable from a true empty answer). Fresh this run.
- **Resolved false alarm (not filed, recorded here per the skill):** a
  single-token `search zebra` returning 0 while "zebra1" hit 1 looked like an
  index defect; bisect showed content tokens are `zebra1..zebra5` (unicode61
  whole-token matching — correct), and the immediate-search miss was the
  auto-build racing my write (write→search in the same second DID hit). The
  residual UX gap is exactly DF-2026-2.

## 6. What this run did NOT do

- No code changes; no repo visibility/permission changes; no credentials
  minted (prod daemon auth keys untouched; the scratch backend used throwaway
  keys in a /tmp rig).
- Foreman not woken (family active; rows pending on its board).
- The prod daemon (`:3000`, 813 namespaces) was read-only this run; the
  cross-namespace durability surface is run 16's, not re-swept (no delta
  touches it).

## 7. Transcript evidence (key rc readings)

```
remember w/o --domain:
  ✗ Failed to remember: Invalid input: Invalid option: expected one of
    "person"|"event"|"concept"|"message"|"config"|"raw_note"
remember --help:
  Error: unknown flag '--help' for 'remember'.
  Valid flags: --domain=<d> --attr=<json> --namespace=<name> --wait ...
s3 push during outage:
  Error: connect ECONNREFUSED 127.0.0.1:19099   (rc=1)
s3 push after recovery:
  [S3] push s3repro8: uploaded=2 downloaded=0 skipped=1 in 110ms  (rc=0)
```

Scripts: /tmp/df-dkb-1016/{run-s3-reproof,run-s3-leg2,run-df-reproof,run-perf,run-freshness}.sh
(ephemeral, not committed — no credentials in repo).
