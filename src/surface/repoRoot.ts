/**
 * SURFACE-PARITY-001 — locate the repo root from any module depth.
 *
 * Separate from `inventory.ts` because the doc generator must not import that
 * module (it builds the Express app and loads native DuckDB); this file has no
 * imports at all.
 */

import fs from "fs";
import path from "path";

export function findRepoRoot(startDir = __dirname): string {
  let probe = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(probe, "bin", "duckbrain.ts"))) return probe;
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  throw new Error(
    `could not locate the repo root (no bin/duckbrain.ts above ${startDir})`,
  );
}
