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

if (fs.existsSync(distEntry)) {
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
