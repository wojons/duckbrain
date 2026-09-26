/**
 * On-disk census of the namespaces root (DF-0924-06 shared registry seam).
 *
 * The config registry (duckbrain.config.json namespaceMappings) and the
 * namespaces directory can drift apart in BOTH directions: rows whose
 * directory was removed out-of-band (REG-GONE-001, flagged by the GET route)
 * and directories with NO mapping — which is exactly what the be129bc
 * split-brain produced for every HTTP/MCP-created namespace since 09-22
 * (the dir was created under the namespaces root; the mapping went into a
 * stray config file instead of the root config).
 *
 * DF-0924-06: this census is now THE one directory-aware truth shared by
 * every registry surface — GET /api/namespaces (the DB-GAP-057 union),
 * the list_namespaces MCP tool, and switch_namespace's existence check —
 * so listings and switches can never disagree about which namespaces
 * exist. It previously lived at src/http/routes/namespace-census.ts
 * (HTTP-only); that path re-exports this module for compatibility.
 *
 * Read-only by contract for LIST surfaces: the GET path must never mutate
 * the registry — reconciliation of drifted prod state is an ops action,
 * not a side effect of listing. (switch_namespace uses the census read to
 * VALIDATE, then performs its own explicit, separate register write.)
 */

import fs from "fs";
import path from "path";
import { CONFIG_FILENAME } from "../config/index";

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
