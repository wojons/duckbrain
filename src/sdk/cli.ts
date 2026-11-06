/**
 * SDK-PARITY-001: `pnpm sdk:gen` / `pnpm sdk:check`.
 *
 * No arguments  → regenerate both artefacts and print what was written.
 * `--check`     → regenerate in memory; exit 1 (listing the files) on drift.
 */
import { driftedFiles, writeGenerated } from "./generate.js";

export function runSdkCli(argv: string[], repoRoot = process.cwd()): number {
  if (argv.includes("--check")) {
    const drifted = driftedFiles(repoRoot);
    if (drifted.length === 0) {
      console.log("sdk:check — generated client and OpenAPI document agree");
      return 0;
    }
    console.error(
      `sdk:check — DRIFT: ${drifted.join(", ")} no longer match the document. Run \`pnpm sdk:gen\`.`,
    );
    return 1;
  }
  const written = writeGenerated(repoRoot);
  console.log(`sdk:gen — wrote ${written.join(", ")}`);
  return 0;
}
