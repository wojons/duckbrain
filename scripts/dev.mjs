#!/usr/bin/env node
/**
 * Composite dev launcher (QA-DUCKBRAIN-017).
 *
 * Root script: "dev": "node scripts/dev.mjs"  (was: concurrently "pnpm dev:api" "pnpm start:ui")
 *
 * Why a wrapper: `npm run dev -- --port 3111` (the QA battery's launch line,
 * and the natural CLI form) appends `--port 3111` to concurrently's OWN argv.
 * concurrently consumes trailing flags and never forwards them to its child
 * commands, so vite kept its 8989 default while the caller probed :3111 —
 * ui-probe graded http=000 in two consecutive clean-machine batteries
 * (2026-10-24 + 2026-10-25) while the app was up the whole time (API on
 * :3000, vite on :8989). This wrapper lifts `--port N` into
 * DUCKBRAIN_UI_PORT — the variable vite.config.ts actually reads — BEFORE
 * concurrently starts, so the UI surface binds the port the caller named.
 * Invalid/missing port values fail loud instead of silently binding 8989.
 *
 * Supported invocations:
 *   pnpm dev                     (no port: API :3000, UI :8989 — unchanged)
 *   npm run dev -- --port 3111   (battery path; UI binds 3111)
 *   pnpm dev -- --port 3111      (pnpm forwards a literal `--`, stripped here)
 *
 * Spawned via npm/pnpm run only: `concurrently` resolves from
 * node_modules/.bin, which npm/pnpm put on PATH for script execution.
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();

const env = { ...process.env };
const port = takePort(args);
if (port === null) {
  console.error('dev: --port given without a numeric value (e.g. --port 3111)');
  process.exit(2);
}
if (port !== undefined) env.DUCKBRAIN_UI_PORT = port;

const result = spawnSync(
  'concurrently',
  ['"pnpm dev:api"', '"pnpm start:ui"', ...args],
  { stdio: 'inherit', env },
);
process.exit(result.status ?? 1);

/** Pull `--port N` / `--port=N` out of args (in place). Returns the port
 * string, undefined when no --port was given, or null on an invalid value. */
function takePort(args) {
  const i = args.indexOf('--port');
  if (i !== -1) {
    const raw = args[i + 1];
    if (raw === undefined || !/^\d+$/.test(raw)) return null;
    args.splice(i, 2);
    return raw;
  }
  const eq = args.findIndex((a) => a.startsWith('--port='));
  if (eq !== -1) {
    const raw = args[eq].slice('--port='.length);
    if (!/^\d+$/.test(raw)) return null;
    args.splice(eq, 1);
    return raw;
  }
  return undefined;
}
