# DuckBrain Integration Report — Dogfood 2026-09-23

Tick: `duckbrain-dogfood-2026-09-23-06-20-14` · HEAD `61d8ed3` · focus surface:
the **namespace deletion lifecycle** shipped 2026-09-22 (`e3a9852`:
delete-from-disk vs clear-from-S3 + ghost sweep) — untouched by runs 1–7.

## Promise tested

"A user can delete a namespace from disk (stopping scheduled S3 pushes while
keeping the S3 objects retrievable) and separately destroy the S3 copy, with
guards, idempotency, and a who/why audit trail — via CLI, REST, or MCP."

## What works (verified live on an isolated scratch daemon)

Isolation trio (prior-run recipe): `DUCKBRAIN_NAMESPACES_PATH` +
`DUCKBRAIN_CONFIG_PATH` env, scratch port 3923, no auth file → prod untouched
(checksummed unchanged).

### CLI — `duckbrain namespace delete-disk` ✅
- Usage/help correct when called with no args or missing `--force` (exit 1).
- Happy path: `namespace delete-disk <ns> --force --requested-by=<who>
  --reason=<why>` → dir + config mapping removed, exit 0.
- Idempotency: second delete on the SAME run errors "not found" (exit 1) —
  mapping is unregistered on first delete, so re-run is NOT idempotent
  (shared-core idempotency only covers mapping-present/dir-gone).
- Active-namespace guard: "Cannot delete currently active namespace" ✓.
- In-flight-push guard: with a valid live `.s3state/.lock`
  `{pid:<live pid>, ts:<now ms>}` held, delete refuses: "Push in flight for
  '<ns>' (native sync lock held by pid ...)"; dir untouched ✓.
  (Probe note: the lock ts must be CURRENT EPOCH MILLISECONDS. A garbage ts
  parses as stale-future and is silently ignored — first probe produced a
  false "guard broken" until the ts was fixed.)
- Audit: one JSONL line in `<namespaces>/.s3state/lifecycle.log`
  `{op:"delete-from-disk", ns, requestedBy, reason, localPath,
  manifestPruned, s3Preserved}` ✓.
- Daemon coherence: deleting via CLI behind a RUNNING daemon left the daemon
  correct — deleted ns → HTTP 404 on recall, list clean. The 08-16-era
  ghosting is not reproducible at HEAD.

### Ghost sweep — `duckbrain s3 ghosts [--sweep --yes]` ✅
- Seeded a ghost manifest + stale mapping → detected both, listed with names.
- `--sweep --yes --requested-by=<who>` pruned manifest + mapping, S3
  untouched, audit logged.
- Minor: each sweep appends TWO audit lines (`sweep-ghost-sync-state` and
  `s3-ghosts-sweep`) — duplicate record of one operation.

### clear-s3 gates ✅ (S3 never configured on the scratch box)
- `namespace clear-s3` with no args → usage + exit 1.
- `s3 clear <ns> --dry-run` with S3 disabled → "S3 is disabled. Set s3:
  {enabled:true,...}" — a fresh user is told exactly what to configure. Good
  error path.
- `s3 clear` without `--dry-run`/`--yes` refuses (two-step confirm) — not
  probed further without real S3 credentials (by design, destructive).

### REST — `DELETE /api/namespaces/:name` ⚠️ works, but weaker guarantees
- Happy path 200 `{success:true, path}`; confirm guard 400 without
  `confirm:true`; deleted ns 404s afterward ✓. Manifest pruned ✓.
- **DF-0923-01 (P1): no in-flight-push guard.** With the same live lock that
  the CLI refuses, REST DELETE returned 200 and removed the namespace
  (live-proven). The commit's headline guarantee is CLI-only.
- **DF-0923-02 (P2): no audit line.** REST deletion leaves no trace in
  lifecycle.log. MCP `delete_namespace` (same shared core, confirmed at
  `src/mcp/tools/namespace.ts:304`) inherits both gaps.

## Installability (ephemeral bunker, las-bunker-02, agent a5e78c5a, destroyed)

`bunker-qa.sh` full battery: fresh-install **OK in 17.6s** (pnpm 12.4.2,
frozen lockfile) — the 09-19 express blocker (DF-0919-01) is FIXED at HEAD.
README quickstart shape (daemon → health → create ns → write → read back)
verified live on the dev checkout: ~30s to first success including daemon boot.

Battery cells: fresh-install OK · toolchain bootstrap OK · act ci-pass
harness-limited (docker-in-act) · **docker-deploy compose up OK but health
probe 000 (DF-0923-04)** · chaos-shutdown FAIL (same compose stack won't
restart) · ui-probe FAIL is a HARNESS artifact (`npm run dev` here is the
backend, which started fine — "HTTP server ready"; the cell probes :3111 for
a UI server) · upgrade FAIL `duckbrain@1.0.0` npm E404 (DF-0923-05: no
published artifact) · chaos-errorpath INFO (missing-config behavior
UNVERIFIED — probe never ran the app).

## Performance (Step 2b — numbers, not vibes)

- REST namespace DELETE: **10.6 ms ± 2.5 ms** (hyperfine warm n=10, create+3
  memories in prepare, scratch daemon).
- CLI `namespace delete-disk` cold: **1.20s wall** (user 1.14 / sys 0.24 —
  Node + DuckDB startup dominates, not deletion logic).
- Daemon boot to serving health: ~4 s.
- Fresh-machine pnpm install: **17.6 s** (bunker, frozen lockfile).

Nothing here is slow enough that a real user would notice — deletion is not
the bottleneck anywhere; no PERF row filed (a win nobody can feel is not a
finding).

## Verdict

🟡 **PROMISING-BUT-ROUGH** — the new lifecycle works end-to-end on the CLI and
is the most disciplined deletion UX in the project's history (guards, audit,
S3-preserving semantics); but its headline safety guarantee and audit trail
stop at the CLI, while agents act primarily through REST/MCP. Docs for the
whole feature: zero. Compose path broken fresh. Time-to-first-success ~30s
(dev checkout) / install-blocked-free (17.6s bunker).

Rows filed: DF-0923-01..05 (board tasks.jsonl + events.jsonl, verified by
census 199→204 / 1176→1181).