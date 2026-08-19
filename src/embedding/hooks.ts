/**
 * Git Hook Installer — Embedding Cache Rebuild Hooks
 *
 * Installs post-checkout / post-merge / post-rewrite hooks into a namespace
 * repo. After a clone or pull, the hook fires a DETACHED `duckbrain embeddings
 * rebuild` so the local embedding cache catches up with cache assist:
 *
 *   - unchanged content → cache hit (fast)
 *   - new/changed content → embedded (slower, but only the delta)
 *   - different model on this machine → its own cache namespace, rebuilt lazily
 *
 * The hook script locates the duckbrain CLI from the namespace repo layout
 * (bin/duckbrain.js at repo root) and writes a log to `<ns>/.embeddings/rebuild.log`.
 *
 * Cwd parity (EMB-001, mirror of RETR-010): git fires hooks with cwd = the
 * namespace repo top level, so the hook steps up to the duckbrain root when
 * the CLI resolves to an absolute path — namespace resolution is
 * cwd-independent.
 */

import fs from "fs";
import path from "path";
import { EMBEDDING_CACHE_DIR } from "./cache";

const HOOK_NAMES = ["post-checkout", "post-merge", "post-rewrite"] as const;

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
# DuckBrain embedding cache rebuild hook (installed by 'duckbrain embeddings install-hooks')
# Fires on clone/pull/rewrite: rebuilds the embedding cache with cache assist.
# Detached so git operations never block on embedding.
# Log: <repo-root>/${cacheDir}/rebuild.log
if [ -n "$DUCKBRAIN_SKIP_EMBED_REBUILD" ]; then
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
"${duckbrainBin}" embeddings rebuild --namespace "${namespaceName}" --detached --log "\${REPO_ROOT}/${cacheDir}/rebuild.log" >/dev/null 2>&1 &
exit 0
`;
}

/**
 * Resolve the duckbrain CLI bin path for a namespace repo.
 *
 * Namespace repos live at <duckbrain-root>/namespaces/<ns>. We resolve from
 * the repo root upward: bin/duckbrain.js next to the namespace, else the
 * canonical install path. Falls back to bare 'duckbrain' (PATH).
 */
export function resolveDuckbrainBin(namespacePath: string): string {
  const repoRoot = fs.realpathSync(path.dirname(namespacePath));
  const candidates = [
    path.join(repoRoot, "bin", "duckbrain.js"),
    path.join(repoRoot, "..", "bin", "duckbrain.js"),
    path.join(namespacePath, "..", "..", "bin", "duckbrain.js"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // skip
    }
  }
  return "duckbrain";
}

/**
 * Install embedding rebuild hooks into a namespace repo.
 *
 * @param namespacePath path to the namespace (repo root)
 * @param namespaceName repo/namespace name (used in the hook invocation)
 * @returns list of hook files written
 */
export function installEmbeddingHooks(
  namespacePath: string,
  namespaceName: string,
): string[] {
  const hooksDir = path.join(namespacePath, ".git", "hooks");
  if (!fs.existsSync(hooksDir)) {
    throw new Error(`Not a git repo (no .git/hooks): ${namespacePath}`);
  }
  const bin = resolveDuckbrainBin(namespacePath);
  const script = hookScript(bin, namespaceName, EMBEDDING_CACHE_DIR);
  const written: string[] = [];
  for (const hook of HOOK_NAMES) {
    const p = path.join(hooksDir, hook);
    fs.writeFileSync(p, script, { mode: 0o755 });
    written.push(p);
  }
  return written;
}

/**
 * Check whether hooks are currently installed.
 */
export function embeddingHooksInstalled(namespacePath: string): boolean {
  const hooksDir = path.join(namespacePath, ".git", "hooks");
  return HOOK_NAMES.every((h) => {
    const p = path.join(hooksDir, h);
    if (!fs.existsSync(p)) return false;
    const content = fs.readFileSync(p, "utf8");
    // bin path is quoted in the script ("duckbrain" or "/abs/bin/duckbrain.js"),
    // so match the unquoted command fragment
    return content.includes("embeddings rebuild --namespace");
  });
}
