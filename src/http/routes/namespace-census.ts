/**
 * DB-GAP-057: on-disk census of the namespaces root.
 *
 * The config registry (duckbrain.config.json namespaceMappings) and the
 * namespaces directory can drift apart in BOTH directions: rows whose
 * directory was removed out-of-band (REG-GONE-001, flagged by the GET route)
 * and directories with NO mapping — which is exactly what the be129bc
 * split-brain produced for every HTTP/MCP-created namespace since 09-22
 * (the dir was created under the namespaces root; the mapping went into a
 * stray config file instead of the root config).
 *
 * This census is the union side of GET /api/namespaces: one readdirSync of
 * the root, directories only (files are not namespaces — the stray
 * `duckbrain.config.json` the bug produced is a file), hidden entries
 * skipped (the internal `.s3state` dir and friends are never namespaces).
 *
 * Read-only by contract: the GET path must never mutate the registry —
 * reconciliation of drifted prod state is an ops action, not a side effect
 * of listing.
 */

import fs from "fs";
import path from "path";
import { CONFIG_FILENAME } from "../../config/index";

/**
 * List the on-disk namespaces directly under `root`.
 *
 * @returns Map of namespace name → absolute directory path, in readdir
 * order. An unreadable root yields an EMPTY census (the registry half of the
 * response is still served; the census failure is warned, not fatal — a
 * listing endpoint must not 500 because a storage directory vanished).
 */
export function censusOnDiskNamespaces(root: string): Map<string, string> {
  const found = new Map<string, string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    console.warn(
      `Warning: namespace census could not read ${root}: ${(error as Error).message}`,
    );
    return found;
  }
  for (const entry of entries) {
    // Files are never namespaces — this skips the stray
    // namespaces/duckbrain.config.json the DB-GAP-057 bug produced in prod.
    if (!entry.isDirectory()) continue;
    // Hidden entries are internals (.s3state, .git, ...), not namespaces.
    if (entry.name.startsWith(".")) continue;
    // Defensive: a DIRECTORY named like the config file is never a namespace.
    if (entry.name === CONFIG_FILENAME) continue;
    found.set(entry.name, path.join(root, entry.name));
  }
  return found;
}
