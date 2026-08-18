/**
 * `duckbrain search-index` CLI — keyword search index management (RETR-001)
 *
 * Subcommands:
 *   rebuild [--namespace=X]   Rebuild the FTS sidecar for one or all namespaces
 *   status  [--namespace=X]   Show index status for a namespace
 *
 * The index is a gitignored, rebuildable cache (Q-7 doctrine — mirror of
 * `duckbrain embeddings`). Rebuilds are idempotent: the sidecar directory
 * is wiped and recreated from the namespace JSONL.
 */

import fs from "fs";
import path from "path";
import { getConfig } from "../config/index";
import {
  ensureSearchGitignored,
  indexStatus,
  listNamespaces,
  rebuildAllNamespaces,
  rebuildNamespaceIndex,
  SEARCH_INDEX_DIR,
} from "../search/index";
import {
  resolveNamespaceName,
  resolveNamespacePath,
} from "../mcp/tools/shared";

interface SearchIndexArgs {
  action: string;
  namespace?: string;
}

export function parseArgs(args: string[]): SearchIndexArgs {
  const out: SearchIndexArgs = { action: args[0] ?? "status" };
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--namespace") {
      // space-separated form: --namespace test-ns (used by git hooks)
      out.namespace = rest[++i];
    } else if (a.startsWith("--namespace=")) {
      out.namespace = a.slice("--namespace=".length);
    }
  }
  return out;
}

async function cmdRebuild(opts: SearchIndexArgs): Promise<void> {
  if (opts.namespace) {
    const nsName = resolveNamespaceName(opts.namespace);
    const nsPath = resolveNamespacePath(nsName);
    if (!fs.existsSync(nsPath)) {
      console.error(`Error: Namespace '${nsName}' not found at ${nsPath}`);
      process.exitCode = 1;
      return;
    }
    ensureSearchGitignored(nsPath);
    const start = Date.now();
    console.error(
      `[search-index] Rebuilding index for namespace '${nsName}' @ ${path.join(nsPath, SEARCH_INDEX_DIR)}`,
    );
    const meta = await rebuildNamespaceIndex(nsPath);
    console.log(
      JSON.stringify(
        { namespace: nsName, ...meta, wallMs: Date.now() - start },
        null,
        2,
      ),
    );
    return;
  }

  // No --namespace: rebuild every namespace under the namespaces root.
  const root = getConfig(".").namespacesPath;
  const namespaces = listNamespaces(root);
  if (namespaces.length === 0) {
    console.error(`No namespaces found under ${root} — nothing to rebuild.`);
    process.exitCode = 1;
    return;
  }
  console.error(
    `[search-index] Rebuilding indexes for ${namespaces.length} namespace(s) under ${root}…`,
  );
  const results = await rebuildAllNamespaces(root);
  const summary = Object.fromEntries(
    Object.entries(results).map(([ns, meta]) => [
      ns,
      { rowCount: meta.rowCount, durationMs: meta.durationMs },
    ]),
  );
  console.log(JSON.stringify({ namespaces: summary }, null, 2));
}

async function cmdStatus(opts: SearchIndexArgs): Promise<void> {
  const nsName = resolveNamespaceName(opts.namespace);
  const nsPath = resolveNamespacePath(nsName);
  if (!fs.existsSync(nsPath)) {
    console.error(`Error: Namespace '${nsName}' not found at ${nsPath}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(indexStatus(nsPath), null, 2));
}

export async function runSearchIndexCLI(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  switch (opts.action) {
    case "rebuild":
      await cmdRebuild(opts);
      break;
    case "status":
      await cmdStatus(opts);
      break;
    default:
      console.error(`Unknown search-index action: ${opts.action}`);
      console.error("Actions: rebuild | status");
      process.exitCode = 1;
  }
}
