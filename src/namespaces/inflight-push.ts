/**
 * In-flight S3 push detection (DF-0923-01).
 *
 * Extracted from src/namespaces/lifecycle.ts so BOTH deletion paths can
 * share it without an import cycle: lifecycle.ts delegates the physical
 * removal to the shared core deleteNamespace (src/namespaces/delete.ts),
 * and DF-0923-01 added the guard to that core — delete.ts must be able to
 * import this module while lifecycle.ts also imports it (the same shape as
 * stateDir / pruneSyncManifest in src/s3/manifest, which moved there for
 * exactly this reason). This module imports only leaves (config, s3/manifest,
 * utils/pidfile) and is imported by nobody's dependencies — no cycle.
 */

import fs from "fs";
import path from "path";
import { getConfig } from "../config/index";
import { isPidAlive } from "../utils/pidfile";
import { stateDir } from "../s3/manifest";

/**
 * Is a push for this namespace in flight right now?
 *
 * Two writers can be moving this namespace's bytes:
 *  - the native delta sync (cross-process lock at <nsRoot>/.s3state/.lock —
 *    global to all namespaces, so a held lock means SOME sync is running);
 *  - the shell git layer's git-remote-s3 helper (argv names the namespace's
 *    s3:// URL).
 * When detection is impossible (no /proc, pgrep missing) we fail CLOSED:
 * a delete during an unknown push is worse than a deferred one.
 */
export function hasInFlightPush(
  namespacesPath: string,
  ns: string,
): { inFlight: boolean; detail: string } {
  const lockPath = path.join(stateDir(namespacesPath), ".lock");
  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    const data = JSON.parse(raw) as { pid: number; ts: number };
    if (
      Number.isInteger(data.pid) &&
      data.pid > 0 &&
      isPidAlive(data.pid) &&
      Date.now() - data.ts < 10 * 60 * 1000
    ) {
      return {
        inFlight: true,
        detail: `native sync lock held by pid ${data.pid} (since ${new Date(data.ts).toISOString()})`,
      };
    }
  } catch {
    // no lock / unreadable → not in flight via this path
  }

  try {
    const cfg = getConfig(".");
    if (cfg.s3?.enabled) {
      const url = `s3://${cfg.s3.bucket}/`;
      if (fs.existsSync("/proc/self/cmdline")) {
        const pidDir = "/proc";
        for (const p of fs.readdirSync(pidDir)) {
          if (!/^\d+$/.test(p)) continue;
          try {
            const argv = fs
              .readFileSync(path.join(pidDir, p, "cmdline"), "utf-8")
              .split("\0");
            const isHelper = argv.some((a) => a.includes("git-remote-s3"));
            // helper argv carries the full URL including the namespace segment
            const touchesNs = argv.some((a) => a.includes(url + ns));
            if (isHelper && touchesNs) {
              return {
                inFlight: true,
                detail: `git-remote-s3 helper pid ${p} is pushing this namespace`,
              };
            }
          } catch {
            // process vanished between readdir and read — ignore
          }
        }
      }
    }
  } catch {
    // config unreadable — the lock check above already ran
  }

  return { inFlight: false, detail: "" };
}
