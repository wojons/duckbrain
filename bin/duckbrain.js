#!/usr/bin/env node
/**
 * DuckBrain CLI Executable
 *
 * PERF-004 — prefer the precompiled dist/ entry when it exists (no tsx
 * on-the-fly TS compilation on the hot path: measured recall 4.19s via tsx
 * vs 3.10s via precompiled dist/). Falls back to tsx for dev mode / fresh
 * clones without a build, with a stderr hint to run `pnpm build`.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// Precompiled CLI entry (tsc -p tsconfig.build.json → dist/bin/duckbrain.js).
const distEntry = path.join(__dirname, '..', 'dist', 'bin', 'duckbrain.js');

/**
 * S3-QUERY-CREDENTIALS-001 follow-up: a stale dist/ is silent, and it is worse
 * than no build at all - `bin/duckbrain.js` prefers dist/ (PERF-004), so every
 * fix landed in src/ AFTER the last `pnpm build:cli` is invisible to the
 * documented command while `git log` says it shipped. That is exactly how
 * `s3 query` kept answering 403 "no credentials" on a host whose source had
 * already been fixed: dist/src/s3/query.js was three hours older than the patch.
 *
 * Comparing the newest source mtime against the newest build artifact costs one
 * directory walk (a few ms against a 1-3s startup) and turns a silent wrong
 * answer into a named one.
 */
function newestMtime(dir, extensions, options = {}) {
  const skipTests = options.skipTests === true;
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') stack.push(full);
        continue;
      }
      if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
      if (skipTests && entry.name.endsWith('.test.ts')) continue;
      try {
        const { mtimeMs } = fs.statSync(full);
        if (mtimeMs > newest) newest = mtimeMs;
      } catch {
        // an unreadable file cannot be the newest one that matters
      }
    }
  }
  return newest;
}

function warnIfStale() {
  const repoRoot = path.join(__dirname, '..');
  // Tests are not part of the shipped program, so touching one must not warn.
  const sourceNewest = newestMtime(path.join(repoRoot, 'src'), ['.ts'], { skipTests: true });
  const buildNewest = newestMtime(path.join(repoRoot, 'dist'), ['.js']);
  if (sourceNewest > 0 && sourceNewest > buildNewest + 2000) {
    const behindSeconds = Math.round((sourceNewest - buildNewest) / 1000);
    process.stderr.write(
      `[duckbrain] STALE BUILD: dist/ is ${behindSeconds}s older than src/ — you are running ` +
        'code that predates the current source. Run `pnpm build:cli` (source newer than the ' +
        'build is not in this binary).\n',
    );
  }
}

if (fs.existsSync(distEntry)) {
  // A stale build must announce itself rather than answer confidently wrong.
  if (process.env.DUCKBRAIN_SKIP_BUILD_CHECK !== '1') warnIfStale();
  require(distEntry);
} else {
  process.stderr.write(
    '[duckbrain] no precompiled build found — falling back to on-the-fly tsx compilation (slower startup; run `pnpm build:cli` to fix)\n',
  );

  // Register tsx to handle TypeScript files
  require('tsx/cjs');

  // INT-CI-022: the PERF-004 lazy loaders (src/cli/human.ts loadS3Cli /
  // loadLifecycleS3, src/s3/sync.ts loadClient, src/namespaces/lifecycle.ts
  // loadS3Client, src/serialization/audit.ts namespaceWriter) use dynamic
  // import() with .js specifiers — correct for the compiled dist/ CJS tree,
  // but under this fallback the sources exist only as .ts. tsx's CJS hook
  // maps .js -> .ts for require() and static imports, NOT for dynamic
  // import(): that runs on the native ESM loader, which has no hooks here,
  // so Node throws ERR_MODULE_NOT_FOUND for e.g. src/s3/cli.js (CI run
  // 2026-10-06T23:51 on 7a84609 — ci.yml has no build step before
  // `pnpm test:run`, so CI always takes this branch). Register tsx's ESM
  // loader too — the same dual registration `tsx bin/duckbrain.ts` (CLI +
  // Dockerfile entrypoint) uses — so dynamic imports resolve both spellings
  // before the TypeScript entry loads.
  import('tsx/esm/api')
    .then(({ register }) => register())
    .then(() => import(pathToFileURL(path.join(__dirname, 'duckbrain.ts')).href))
    .catch((err) => {
      process.stderr.write(
        `[duckbrain] tsx fallback failed: ${err && err.stack ? err.stack : String(err)}\n`,
      );
      process.exit(1);
    });
}
