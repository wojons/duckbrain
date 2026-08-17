/**
 * INT-CI-003: integration-suite daemon pre-warm (globalSetup).
 *
 * Each http integration file spawns its OWN fresh daemon in beforeAll
 * (auth / rate-limit flags differ per file, so a shared daemon is not
 * viable). The 3rd CI flake (run 32071985468) showed a cold spawn taking
 * >30s on the Node 22 runner under load — the "HTTP server started" line
 * landed exactly at the timeout instant, i.e. a slow start, not a hang.
 *
 * This setup runs ONCE before the first test file and spawns one throwaway
 * daemon to full health, then kills it. That warms, for every later spawn in
 * the same job:
 *   - the OS page cache for node, node-duckdb's native .node, and the whole
 *     imported module graph (subsequent dlopen + reads are RAM-fast);
 *   - tsx/esbuild's on-disk transform cache (node_modules/.cache/tsx), so the
 *     per-file daemons skip most transpilation;
 *   - the git/DuckDB paths the daemon touches during startup.
 *
 * The warm-up itself carries a generous 180s cap (3x the per-file 60s) so a
 * hammered runner costs wall time but never a false failure; on failure the
 * stderr tail is surfaced by waitForUrl's diagnostics. The warm-up daemon is
 * killed before any test file spawns, on a port range (20000-24999) that
 * cannot collide with the tests' getRandomPort() range (30000-49999).
 */
import { startDuckbrainHttp, waitForUrl, killProcess } from "./helpers";

const PREWARM_TIMEOUT_MS = 180_000;

export default async function globalSetup(): Promise<void> {
  const port = 20000 + Math.floor(Math.random() * 5000);
  const child = await startDuckbrainHttp({ port });
  try {
    await waitForUrl(
      `http://127.0.0.1:${port}/health`,
      PREWARM_TIMEOUT_MS,
      child,
    );
  } finally {
    killProcess(child);
  }
}
