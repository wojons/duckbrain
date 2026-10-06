# Dogfood Run 9 — DuckBrain Web UI (packages/ui) — 2026-09-24

Tick: duckbrain-dogfood-2026-09-24-11-15-46. Angle: the Web UI, untouched
since run 08-16 ("boots"). Runs 1–8 all exercised CLI/REST/MCP/as-of; this run
drove the flagship "Beautiful Web UI" claim end-to-end as a user.

## Environment

- Scratch deployment, OPS-001 trio: `DUCKBRAIN_CONFIG_PATH=/tmp/dogfood-duckbrain-ui-0924/config.json`,
  `DUCKBRAIN_NAMESPACES_PATH=/tmp/dogfood-duckbrain-ui-0924/ns`,
  `--auth-file=/tmp/dogfood-duckbrain-ui-0924/auth.json`, port 3795. Production
  daemon (:3000) and its auth store untouched (verified after an accidental
  `http --help` boot attempt — see diagnostics).
- UI: dev server (`pnpm run dev`, DUCKBRAIN_UI_PORT=8995, proxy → :3795) AND
  production build (`pnpm --filter @duckbrain/ui build` → `vite preview` :8996).
- Seed data written over REST: 2 memories in ns `dogfood-ui` (+1 unauth probe
  write, itself a finding).

## What a user actually saw

1. **Dev server (:8995):** `--dump-dom` returned an EMPTY `<html><head></head><body></body></html>`
   for ~25 min of attempts; direct module fetches (main.tsx, all 11 imported
   chunks incl. the 1.1MB react-dom dev bundle) each returned 200 in <25ms.
   Never resolved by headless Chrome (virtual-time-budget interacts with the
   vite dev HMR socket; the cold FCP number in dev is unmeasurable headless).
2. **Production build (:8996):** page renders, but every data panel is a
   permanent skeleton: "Active Memories / Git Queue / Tombstone Ratio / Key
   Count → Loading...", Memory Timeline empty, "Select a memory to view details".
3. **Lighthouse (prod build, 3 runs, warm cache, headless, no throttling):**
   FCP 2.7s, LCP 3.0s, TBT 0ms, SI 4.4s, TTI 3.0s, 204KB total transfer —
   the shell is fine; the DATA never arrives.
4. **Why:** the UI hardcodes namespace `default` (ui-store.js:23) which does
   not exist on any normal install → every `/api/memories?namespace=default`
   and `/api/keys?namespace=default` 404s (12+ per load, retries fan out); and
   `apiFetch` sends no credentials at all, so on the documented hardened mode
   (`--auth=apikey`) everything 401s (Lighthouse saw 21 HTTP>=400 calls incl.
   429s from the retry loop). There is no token entry anywhere in the UI.

## Working vs broken (measured)

- Working: the built bundle loads (LCP 3.0s, TBT 0), `pnpm build` passes
  (4.2s, 481KB — DF-0919-02 FIXED), vite proxy correctly forwards /api.
- Broken: DF-0924-05 (P0 UI DOA: no auth, hardcoded ns, skeleton-forever),
  DF-0924-06 (P1 namespace list/switch vs on-disk dirs split-brain; phantom
  `default` with directoryMissing:true), DF-0924-07 (P1 `--auth-file` without
  `--auth=apikey` serves everything unauthenticated — no key 201, wrong key 200),
  DF-0924-08 (P2 README "Web UI Only" path incomplete; daemon serves 404 on /),
  DF-0924-09 (P3 /health leaks `keys_error:"Namespace 'undefined' does not exist"`).

## What held up

REST write/read lifecycle, SSE connected event, namespace create/switch for
MAPPED namespaces, scoped auth on the prod-style daemon, git auto-commit under
the scratch root, UI production build health. The engine underneath the UI is
sound — this run's defects are all in the UI→API contract layer.

## Verdict

PROMISING-BUT-ROUGH, same label as runs 1–8 but for a NEW reason: every prior
run validated the API/CLI/MCP surfaces; the Web UI — the README's second
headline feature — cannot complete a single real task as shipped.
