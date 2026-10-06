#!/usr/bin/env node
/**
 * start-ui shim (QA-DUCKBRAIN-008).
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
 * Supported invocations (both verified live on :3111 / :3113):
 *   pnpm start:ui -- --port 3111
 *   pnpm start:ui --port 3111        (pnpm >=8 forwards unknown flags)
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();

const result = spawnSync('pnpm', ['--dir', 'packages/ui', 'run', 'dev', ...args], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
