/**
 * Git Hook Installer — Search Index Rebuild Hooks (RETR-010)
 *
 * Installs post-checkout / post-merge / post-rewrite hooks into a namespace
 * repo. After a clone or pull, the hook fires a DETACHED `duckbrain
 * search-index rebuild` so the local keyword index catches up with the
 * Q-7 cache doctrine (mirror of src/embedding/hooks.ts):
 *
 *   - index missing → rebuilt from the namespace JSONL (fresh clone)
 *   - index present → wiped and rebuilt (idempotent)
 *   - hook context → returns immediately; indexing runs in the background
 *
 * The hook script locates the duckbrain CLI from the namespace repo layout
 * (bin/duckbrain.js at repo root) and writes a log to
 * `<ns>/.search/rebuild.log`.
 */

import fs from "fs";
import path from "path";
import { SEARCH_INDEX_DIR } from "./index";
import { resolveDuckbrainBin } from "../embedding/hooks";

const HOOK_NAMES = ["post-checkout", "post-merge", "post-rewrite"] as const;

/**
 * Environment variable the hook checks to skip the rebuild. Set on the
 * detached re-spawn so nested git operations can never re-trigger hooks
 * (mirror of DUCKBRAIN_SKIP_EMBED_REBUILD).
 */
export const SEARCH_SKIP_ENV = "DUCKBRAIN_SKIP_SEARCH_REBUILD";

/**
 * Render the hook script body. `namespaceName` is the namespace repo's name.
 * `cacheDir` is relative to the namespace repo root; the hook resolves it
 * against the repo root at runtime ($GIT_PREFIX is empty at repo root).
 */
function hookScript(
  duckbrainBin: string,
  namespaceName: string,
  cacheDir: string,
): string {
  return `#!/bin/sh
# DuckBrain search index rebuild hook (installed by 'duckbrain search-index install-hooks')
# Fires on clone/pull/rewrite: rebuilds the keyword search index (Q-7 cache doctrine).
# Detached so git operations never block on indexing.
# Log: <repo-root>/${cacheDir}/rebuild.log
if [ -n "$DUCKBRAIN_SKIP_SEARCH_REBUILD" ]; then
  exit 0
fi
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# Git fires hooks with cwd = the namespace repo root, but duckbrain.config.json
# and the relative namespacesPath live at the duckbrain root (parent of
# namespaces/). When the bin resolved to an absolute path (canonical layout,
# <root>/bin/duckbrain.js), step up to the duckbrain root so namespace
# resolution is cwd-independent. Bare 'duckbrain' (PATH) keeps the cwd.
case "${duckbrainBin}" in
  /*)
    DUCKBRAIN_ROOT="$(dirname "$(dirname "${duckbrainBin}")")"
    [ -d "\${DUCKBRAIN_ROOT}" ] && cd "\${DUCKBRAIN_ROOT}"
    ;;
esac
"${duckbrainBin}" search-index rebuild --namespace "${namespaceName}" --detached --log "\${REPO_ROOT}/${cacheDir}/rebuild.log" >/dev/null 2>&1 &
exit 0
`;
}

/**
 * Install search-index rebuild hooks into a namespace repo.
 *
 * @param namespacePath path to the namespace (repo root)
 * @param namespaceName repo/namespace name (used in the hook invocation)
 * @returns list of hook files written
 */
export function installSearchHooks(
  namespacePath: string,
  namespaceName: string,
): string[] {
  const hooksDir = path.join(namespacePath, ".git", "hooks");
  if (!fs.existsSync(hooksDir)) {
    throw new Error(`Not a git repo (no .git/hooks): ${namespacePath}`);
  }
  const bin = resolveDuckbrainBin(namespacePath);
  const script = hookScript(bin, namespaceName, SEARCH_INDEX_DIR);
  const written: string[] = [];
  for (const hook of HOOK_NAMES) {
    const p = path.join(hooksDir, hook);
    fs.writeFileSync(p, script, { mode: 0o755 });
    written.push(p);
  }
  return written;
}

/**
 * Check whether search-index rebuild hooks are currently installed.
 * Content-detects the hook (mirror of embeddingHooksInstalled) so an
 * unrelated hook with the same filename is not mistaken for ours.
 */
export function searchHooksInstalled(namespacePath: string): boolean {
  const hooksDir = path.join(namespacePath, ".git", "hooks");
  return HOOK_NAMES.every((h) => {
    const p = path.join(hooksDir, h);
    if (!fs.existsSync(p)) return false;
    const content = fs.readFileSync(p, "utf8");
    return content.includes("search-index rebuild --namespace");
  });
}
