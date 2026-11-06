#!/usr/bin/env node
/**
 * SURFACE-PARITY-001 — write the generated surface section into
 * docs/api/surface-parity.md from src/surface/capabilities.ts.
 *
 * Usage:
 *   pnpm docs:surface            rewrite the block in place
 *   pnpm docs:surface --check    exit 1 if the block is stale (CI-friendly)
 *
 * Reads only the matrix: no daemon, no database, no Express app.
 */

import fs from "fs";
import path from "path";
import { renderSurfaceMarkdown, applyGeneratedBlock } from "../src/surface/render.js";
import { findRepoRoot } from "../src/surface/repoRoot.js";

const DOC_PATH = path.join("docs", "api", "surface-parity.md");

function main(): void {
  const check = process.argv.includes("--check");
  const root = findRepoRoot(__dirname);
  const docPath = path.join(root, DOC_PATH);
  if (!fs.existsSync(docPath)) {
    console.error(`missing ${DOC_PATH} — the generated section has nowhere to live`);
    process.exit(1);
  }
  const doc = fs.readFileSync(docPath, "utf-8");
  const generated = renderSurfaceMarkdown();
  let next: string;
  try {
    next = applyGeneratedBlock(doc, generated);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
    return;
  }
  if (next === doc) {
    console.log(`${DOC_PATH}: generated block is up to date`);
    return;
  }
  if (check) {
    console.error(
      `${DOC_PATH}: generated block is STALE — run \`pnpm docs:surface\``,
    );
    process.exit(1);
  }
  fs.writeFileSync(docPath, next, "utf-8");
  console.log(`${DOC_PATH}: generated block refreshed`);
}

main();
