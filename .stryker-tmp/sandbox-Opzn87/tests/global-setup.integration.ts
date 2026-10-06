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
 * cannot collide with the tests' getRandomPort() range (21000-29999).
 *
 * DB-GAP-059 adds two sweeps around that pre-warm: orphaned scratch daemons
 * from a previously hard-killed run are reaped at startup (so they cannot
 * squat a port or burn the box for the whole run), and the same sweep runs at
 * teardown and ASSERTS that everything it selected is dead — the suite's own
 * proof that it leaves no orphan behind. The reaper never touches the managed
 * `duckbrain-http.service` daemon (systemd's MainPID/ControlGroup), a daemon
 * with a live parent, or the runner's own process tree.
 */
// @ts-nocheck

import {
  startDuckbrainHttp,
  waitForUrl,
  killProcess,
  reapOrphanDaemons,
  formatReapReport,
} from "./helpers";

const PREWARM_TIMEOUT_MS = 180_000;

export default async function globalSetup(): Promise<() => Promise<void>> {
  // Startup sweep: reclaim process ORPHANS a previous run left behind. A
  // failure to kill one is reported, not thrown — a leftover from an earlier
  // run must not red THIS run's every test file.
  try {
    const report = reapOrphanDaemons();
    if (report.victims.length > 0 || report.errors.length > 0) {
      console.error(formatReapReport(report));
    }
  } catch (err) {
    console.error(`[orphan-reaper] startup sweep failed: ${String(err)}`);
  }

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

  return async () => {
    // Teardown sweep (DB-GAP-059). Everything after this point is the
    // suite's own contract: it must not leave an orphaned daemon or its
    // scratch files behind. An orphan that survives SIGTERM+SIGKILL is the
    // incident this row exists for, so it fails the run.
    const report = reapOrphanDaemons();
    if (report.victims.length > 0 || report.errors.length > 0) {
      console.error(formatReapReport(report));
    }
    const survivors = report.victims.filter(
      (pid) => !report.killed.includes(pid),
    );
    if (survivors.length > 0) {
      throw new Error(
        `[orphan-reaper] ${survivors.length} orphaned scratch daemon(s) ` +
          `survived the teardown sweep: ${survivors.join(", ")} ` +
          `(${report.errors.join("; ")})`,
      );
    }
  };
}
