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

  // Run the TypeScript CLI
  require(path.join(__dirname, 'duckbrain.ts'));
}
