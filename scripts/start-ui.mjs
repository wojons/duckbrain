#!/usr/bin/env node
/**
 * start-ui shim (QA-DUCKBRAIN-008, QA-DUCKBRAIN-017).
 *
 * Root script: "start:ui": "node scripts/start-ui.mjs"
 *
 * Why a shim: `pnpm start:ui -- --port 3111` makes pnpm forward a literal
 * `--` into the child script argv, and vite does not strip it, so the port
 * never reached vite (it silently bound its default 8989). This shim drops
 * a leading literal `--` (and pnpm's own flag-looking tokens are avoided by
 * routing through `pnpm run` AFTER stripping, so `--port N` reaches vite)
 * and then execs the ui package's dev script.
 *
 * QA-DUCKBRAIN-017 (2026-10-25): a caller-named `--port N` now binds the UI
 * surface to N. vite.config.ts reads DUCKBRAIN_UI_PORT (default 8989), so
 * the shim lifts `--port N` into that env var instead of forwarding the raw
 * flag — the flag path already proved lossy once (the 008 `--` swallow), and
 * the QA battery probes the port it named, so a silently-ignored port reads
 * as a dead UI. Invalid/missing port values fail loud instead of falling
 * back to 8989.
 *
 * Supported invocations (verified live on :3111 / :3113):
 *   pnpm start:ui -- --port 3111
 *   pnpm start:ui --port 3111        (pnpm >=8 forwards unknown flags)
 *   npm run start:ui -- --port 3111
 *
 * NOTE: the composite dev launcher (`pnpm dev`, the QA battery's
 * `npm run dev -- --port 3111` path) goes through scripts/dev.mjs, which
 * lifts the port BEFORE concurrently starts — concurrently consumes trailing
 * argv itself and never forwards it to this script.
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();

const env = { ...process.env };
const port = takePort(args);
if (port === null) {
  console.error('start-ui: --port given without a numeric value (e.g. --port 3111)');
  process.exit(2);
}
if (port !== undefined) env.DUCKBRAIN_UI_PORT = port;

const result = spawnSync('pnpm', ['--dir', 'packages/ui', 'run', 'dev', ...args], {
  stdio: 'inherit',
  env,
});
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
